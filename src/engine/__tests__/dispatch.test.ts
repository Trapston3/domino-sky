import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Content } from '@google/genai';
import handler, {
  resetRateLimitForTests,
  runAskToolLoop,
  type DispatchResponsePayload,
  type VertexClientLike,
} from '../../../api/dispatch.js';

function createMockReqRes(options: {
  method?: string;
  body?: unknown;
  ip?: string;
}) {
  const headers: Record<string, string | string[]> = {};
  let statusCode = 200;
  let jsonBody: unknown = undefined;

  const req = {
    method: options.method ?? 'POST',
    body: options.body,
    headers: options.ip ? { 'x-forwarded-for': options.ip } : {},
    socket: { remoteAddress: options.ip ?? '127.0.0.1' },
  } as unknown as VercelRequest;

  const res = {
    setHeader(k: string, v: string | string[]) {
      headers[k.toLowerCase()] = v;
      return res;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: unknown) {
      jsonBody = data;
    },
    end() {},
  } as unknown as VercelResponse;

  return {
    req,
    res,
    getStatus: () => statusCode,
    getBody: () => jsonBody,
    getHeaders: () => headers,
  };
}

describe('/api/dispatch zero-trust handler & Gemini 3+ tool loop', () => {
  beforeEach(() => {
    resetRateLimitForTests();
    delete process.env.GOOGLE_VERTEX_API_KEY;
    delete process.env.GCP_SERVICE_ACCOUNT_B64;
  });

  it('rejects non-POST methods, unknown airports, >300-char questions, and invalid actions', async () => {
    const getCall = createMockReqRes({ method: 'GET' });
    await handler(getCall.req, getCall.res);
    expect(getCall.getStatus()).toBe(405);

    const badAirport = createMockReqRes({
      body: {
        mode: 'brief',
        closure: { airport: 'JFK', start: '12:00', end: '13:30' },
        actions: [],
        objective: 'LEGAL_COMPLIANCE',
      },
    });
    await handler(badAirport.req, badAirport.res);
    expect(badAirport.getStatus()).toBe(400);
    expect(badAirport.getBody()).toMatchObject({ ok: false, code: 'INVALID_CLOSURE' });

    const longQ = createMockReqRes({
      body: {
        mode: 'ask',
        closure: { airport: 'DEL', start: '12:00', end: '13:30' },
        actions: [],
        objective: 'LEGAL_COMPLIANCE',
        question: 'x'.repeat(301),
      },
    });
    await handler(longQ.req, longQ.res);
    expect(longQ.getStatus()).toBe(400);
    expect(longQ.getBody()).toMatchObject({ ok: false, code: 'QUESTION_TOO_LONG' });

    const invalidAction = createMockReqRes({
      body: {
        mode: 'brief',
        closure: { airport: 'DEL', start: '12:00', end: '13:30' },
        actions: [{ type: 'SWAP_SPARE', spare_tail_id: 'VT-DS18', flight_id: 'DS0802' }],
        objective: 'LEGAL_COMPLIANCE',
      },
    });
    await handler(invalidAction.req, invalidAction.res);
    expect(invalidAction.getStatus()).toBe(400);
    expect(invalidAction.getBody()).toMatchObject({ ok: false, code: 'SPARE_WRONG_HUB' });
  });

  it('enforces per-IP rate limiting at 20 requests/min', async () => {
    for (let i = 0; i < 20; i += 1) {
      const call = createMockReqRes({
        ip: '198.51.100.77',
        body: {
          mode: 'brief',
          closure: null,
          actions: [],
          objective: 'LEGAL_COMPLIANCE',
        },
      });
      await handler(call.req, call.res);
      expect(call.getStatus()).toBe(200);
    }

    const blocked = createMockReqRes({
      ip: '198.51.100.77',
      body: {
        mode: 'brief',
        closure: null,
        actions: [],
        objective: 'LEGAL_COMPLIANCE',
      },
    });
    await handler(blocked.req, blocked.res);
    expect(blocked.getStatus()).toBe(429);
    expect(blocked.getHeaders()['retry-after']).toBe('60');
  });

  it('recomputes baseline/recovery server-side in brief mode with DETERMINISTIC FALLBACK', async () => {
    const call = createMockReqRes({
      body: {
        mode: 'brief',
        closure: { airport: 'DEL', start: '12:00', end: '13:30' },
        actions: [{ type: 'SWAP_SPARE', spare_tail_id: 'VT-DS18', flight_id: 'DS0304' }],
        objective: 'LEGAL_COMPLIANCE',
        // Attempting to inject fake client metrics must be ignored
        metrics: { delayedFlightsCount: 999 },
      },
    });
    await handler(call.req, call.res);
    expect(call.getStatus()).toBe(200);
    const body = call.getBody() as DispatchResponsePayload;
    expect(body.engineLabel).toBe('DETERMINISTIC FALLBACK');
    expect(body.deterministic.baseline.metrics.delayedFlightsCount).toBe(10);
    expect(body.deterministic.baseline.metrics.totalDelayMinutes).toBe(680);
    expect(body.deterministic.current.metrics.delayedFlightsCount).toBe(9);
    expect(body.deterministic.current.metrics.totalDelayMinutes).toBe(620);
    expect(body.deterministic.current.metrics.crewBreachesCount).toBe(0);
  });

  it('executes deterministic ask tools including continuity rejection on single-leg cancel', async () => {
    const call = createMockReqRes({
      body: {
        mode: 'ask',
        closure: { airport: 'CCU', start: '16:00', end: '17:30' },
        actions: [],
        objective: 'LEGAL_COMPLIANCE',
        question: 'Can we cancel only DS1003?',
      },
    });
    await handler(call.req, call.res);
    expect(call.getStatus()).toBe(200);
    const body = call.getBody() as DispatchResponsePayload;
    expect(body.engineLabel).toBe('DETERMINISTIC FALLBACK');
    expect(body.narrative).toContain('BREAKS_AIRCRAFT_CONTINUITY');
    expect(body.toolTrace.some((t) => t.name === 'simulate_custom_actions' && t.code === 'BREAKS_AIRCRAFT_CONTINUITY')).toBe(true);
  });

  it('preserves raw candidate.content (thoughtSignature), echoes functionCall.id, and caps at 4 tool rounds', async () => {
    const capturedContentsSnapshots: Content[][] = [];
    let callCounter = 0;

    const mockContentWithSignature: Content = {
      role: 'model',
      parts: [
        {
          thought: true,
          text: 'Inspecting flight before answering.',
          thoughtSignature: 'sig-opaque-base64-round-1',
        },
        {
          functionCall: {
            id: 'fc_call_987',
            name: 'inspect_flight',
            args: { flight_id: 'DS0304' },
          },
          thoughtSignature: 'sig-fc-part-abc',
        },
      ],
    };

    const mockClient: VertexClientLike = {
      models: {
        generateContent: vi.fn(async ({ contents }) => {
          // Deep snapshot contents at the moment of call
          capturedContentsSnapshots.push(JSON.parse(JSON.stringify(contents)) as Content[]);
          callCounter += 1;

          if (callCounter <= 4) {
            return {
              candidates: [{ content: mockContentWithSignature }],
              functionCalls: [
                {
                  id: `fc_call_${callCounter}`,
                  name: 'inspect_flight',
                  args: { flight_id: 'DS0304' },
                },
              ],
            };
          }

          return {
            text: 'DS0304 incurs +50m breach on CR03.',
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: 'DS0304 incurs +50m breach on CR03.' }],
                },
              },
            ],
          };
        }),
      },
    };

    const result = await runAskToolLoop({
      client: mockClient,
      model: 'gemini-3.8-flash',
      systemInstruction: 'Test system prompt',
      initialPrompt: 'Inspect DS0304',
      executeTool: (_name, args) => ({ ok: true, flight_id: args.flight_id }),
      maxRounds: 4,
    });

    expect(result.roundsExecuted).toBe(4);
    expect(result.toolTrace.length).toBe(4);
    expect(result.text).toContain('DS0304');

    // Call 2's contents should have: [user initialPrompt, exact candidate.content, user functionResponse]
    const secondCallContents = capturedContentsSnapshots[1];
    expect(secondCallContents[1]).toEqual(mockContentWithSignature);
    expect(secondCallContents[1].parts?.[0].thoughtSignature).toBe('sig-opaque-base64-round-1');
    expect(secondCallContents[1].parts?.[1].thoughtSignature).toBe('sig-fc-part-abc');
    expect(secondCallContents[2].parts?.[0].functionResponse?.id).toBe('fc_call_1');

    // 5th call (synthesis) must NOT allow more than 4 tool-calling rounds
    expect(capturedContentsSnapshots.length).toBe(5);
  });
});
