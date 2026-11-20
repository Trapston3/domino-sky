import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  GoogleGenAI,
  ThinkingLevel,
  Type,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type Part,
} from '@google/genai';
import { flightNetwork } from '../src/data/flightNetwork.js';
import {
  compareObjectives,
  evaluateRecoveryCandidates,
  formatActionLabel,
  inspectFlight,
  parseAndValidateRawActions,
  simulateNetwork,
  validateClosure,
  type ClosureSpec,
  type ObjectiveProfile,
  type RecoveryAction,
  type RecoveryCandidate,
  type SimulationMetrics,
  type SimulationResult,
} from '../src/engine/index.js';

export const config = { maxDuration: 30 };

const DEFAULT_MODEL_ID = 'gemini-3.8-flash';
const MAX_QUESTION_CHARS = 300;
const MAX_TOOL_ROUNDS = 4;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const MAX_TRACKED_IPS = 1000;

const VALID_OBJECTIVES = new Set<ObjectiveProfile>([
  'LEGAL_COMPLIANCE',
  'PASSENGER_PROTECTION',
  'DELAY_MINIMIZATION',
]);

const ipRequestLog = new Map<string, number[]>();

export function resetRateLimitForTests(): void {
  ipRequestLog.clear();
}

function getClientIp(req: VercelRequest): string {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim().length > 0) {
    return xff.split(',')[0].trim();
  }
  if (Array.isArray(xff) && xff.length > 0) {
    return xff[0].split(',')[0].trim();
  }
  const realIp = req.headers?.['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim().length > 0) {
    return realIp.trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(ip: string, nowMs = Date.now()): boolean {
  const cutoff = nowMs - RATE_LIMIT_WINDOW_MS;
  if (!ipRequestLog.has(ip) && ipRequestLog.size >= MAX_TRACKED_IPS) {
    for (const [trackedIp, times] of ipRequestLog.entries()) {
      const fresh = times.filter((ts) => ts > cutoff);
      if (fresh.length === 0) {
        ipRequestLog.delete(trackedIp);
      } else {
        ipRequestLog.set(trackedIp, fresh);
      }
    }
    if (ipRequestLog.size >= MAX_TRACKED_IPS) {
      const oldestKey = ipRequestLog.keys().next().value;
      if (oldestKey !== undefined) ipRequestLog.delete(oldestKey);
    }
  }

  const timestamps = (ipRequestLog.get(ip) ?? []).filter((ts) => ts > cutoff);
  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    ipRequestLog.set(ip, timestamps);
    return false;
  }
  timestamps.push(nowMs);
  ipRequestLog.set(ip, timestamps);
  return true;
}

export interface ToolTraceEntry {
  round: number;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  code?: string;
}

export interface CandidateSummaryPayload {
  id: string;
  rank: number;
  label: string;
  actions: RecoveryAction[];
  metrics: SimulationMetrics;
  deltas: RecoveryCandidate['deltas'];
  positives: string[];
  tradeOffWarnings: string[];
  usesStandbyAssumption: boolean;
}

export interface DispatchResponsePayload {
  ok: true;
  mode: 'brief' | 'ask';
  engineLabel: 'VERTEX AI · GEMINI 3.8 FLASH' | 'DETERMINISTIC FALLBACK';
  model: string;
  objective: ObjectiveProfile;
  closure: ClosureSpec;
  appliedActions: RecoveryAction[];
  deterministic: {
    baseline: {
      metrics: SimulationMetrics;
      breachedCrews: Array<{ crew_id: string; overageMin: number; lastOperatedFlightId: string | null }>;
      brokenConnections: Array<{
        connection_id: string;
        airport: string;
        from_flight: string;
        to_flight: string;
        passengers: number;
      }>;
    };
    current: {
      metrics: SimulationMetrics;
      breachedCrews: Array<{ crew_id: string; overageMin: number; lastOperatedFlightId: string | null }>;
      brokenConnections: Array<{
        connection_id: string;
        airport: string;
        from_flight: string;
        to_flight: string;
        passengers: number;
      }>;
      reopeningSurge: SimulationResult['reopeningSurge'];
      standbyAssumptionsUsed: boolean;
    };
    candidates: CandidateSummaryPayload[];
  };
  narrative: string;
  toolTrace: ToolTraceEntry[];
  fallbackReason?: string;
}

function summarizeSimulation(sim: SimulationResult) {
  return {
    metrics: sim.metrics,
    breachedCrews: sim.crews
      .filter((c) => c.breached)
      .map((c) => ({
        crew_id: c.crew_id,
        overageMin: c.overageMin,
        lastOperatedFlightId: c.lastOperatedFlightId,
      })),
    brokenConnections: sim.connections
      .filter((c) => c.status === 'BROKEN')
      .map((c) => ({
        connection_id: c.connection_id,
        airport: c.airport,
        from_flight: c.from_flight,
        to_flight: c.to_flight,
        passengers: c.passengers,
      })),
  };
}

function toCandidateSummary(cand: RecoveryCandidate): CandidateSummaryPayload {
  return {
    id: cand.id,
    rank: cand.scoreRank,
    label: cand.label,
    actions: cand.actions,
    metrics: cand.result.metrics,
    deltas: cand.deltas,
    positives: cand.positives,
    tradeOffWarnings: cand.tradeOffWarnings,
    usesStandbyAssumption: cand.usesStandbyAssumption,
  };
}

export interface VertexClientLike {
  models: {
    generateContent: (params: {
      model: string;
      contents: Content[];
      config?: Record<string, unknown>;
    }) => Promise<{
      text?: string;
      functionCalls?: FunctionCall[];
      candidates?: Array<{ content?: Content }>;
    }>;
  };
}

function createVertexClientFromEnv(): VertexClientLike | null {
  const apiKey = process.env.GOOGLE_VERTEX_API_KEY?.trim();
  if (apiKey) {
    return new GoogleGenAI({ vertexai: true, apiKey }) as unknown as VertexClientLike;
  }

  const saB64 = process.env.GCP_SERVICE_ACCOUNT_B64?.trim();
  if (saB64) {
    const decoded = Buffer.from(saB64, 'base64').toString('utf8');
    const credentials = JSON.parse(decoded) as {
      project_id?: string;
      client_email?: string;
      private_key?: string;
    };
    if (
      typeof credentials.client_email !== 'string' ||
      credentials.client_email.trim().length === 0 ||
      typeof credentials.private_key !== 'string' ||
      credentials.private_key.trim().length === 0
    ) {
      throw new Error('INVALID_SERVICE_ACCOUNT_CREDENTIALS');
    }
    const project = process.env.GOOGLE_CLOUD_PROJECT?.trim() || credentials.project_id;
    const location = process.env.GOOGLE_CLOUD_LOCATION?.trim() || 'global';
    return new GoogleGenAI({
      vertexai: true,
      project,
      location,
      googleAuthOptions: { credentials },
    }) as unknown as VertexClientLike;
  }

  return null;
}

function buildToolContext(closure: ClosureSpec, baseline: SimulationResult, current: SimulationResult) {
  function executeTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
    if (name === 'simulate_custom_actions') {
      const parsed = parseAndValidateRawActions(flightNetwork, args.actions);
      if (!parsed.ok) {
        return { ok: false, code: parsed.code, reason: parsed.reason };
      }
      const outcome = simulateNetwork(flightNetwork, closure, parsed.actions);
      if (!outcome.ok) {
        return { ok: false, code: outcome.code, reason: outcome.reason };
      }
      const baseM = baseline.metrics;
      const curM = outcome.metrics;
      return {
        ok: true,
        actions: parsed.actions.map(formatActionLabel),
        before: baseM,
        after: curM,
        deltas: {
          delayedFlights: curM.delayedFlightsCount - baseM.delayedFlightsCount,
          totalDelayMinutes: curM.totalDelayMinutes - baseM.totalDelayMinutes,
          brokenConnections: curM.brokenConnectionsCount - baseM.brokenConnectionsCount,
          crewBreaches: curM.crewBreachesCount - baseM.crewBreachesCount,
          strandedOrAtRiskPax: curM.totalStrandedOrAtRiskPax - baseM.totalStrandedOrAtRiskPax,
          cancelledPax: curM.cancelledFlightPax - baseM.cancelledFlightPax,
        },
        breachedCrews: outcome.crews
          .filter((c) => c.breached)
          .map((c) => ({ crew_id: c.crew_id, overageMin: c.overageMin })),
        brokenConnections: outcome.connections
          .filter((c) => c.status === 'BROKEN')
          .map((c) => ({
            connection_id: c.connection_id,
            from_flight: c.from_flight,
            to_flight: c.to_flight,
            passengers: c.passengers,
          })),
        standbyAssumptionsUsed: outcome.standbyAssumptionsUsed,
      };
    }

    if (name === 'inspect_flight') {
      const flightId = typeof args.flight_id === 'string' ? args.flight_id.trim().toUpperCase() : '';
      const info = inspectFlight(current, flightNetwork, flightId);
      if (!info) {
        return {
          ok: false,
          code: 'FLIGHT_NOT_FOUND',
          reason: `Flight "${flightId}" does not exist in flight_network.json.`,
        };
      }
      return {
        ok: true,
        flight_id: info.flight.flight_id,
        tail_id: info.flight.tail_id,
        assignedTail: info.flight.assignedTail,
        sector: `${info.flight.origin}->${info.flight.destination}`,
        scheduled: `${info.flight.dep}-${info.flight.arr}`,
        actual: info.flight.cancelled
          ? 'CANCELLED'
          : `${info.flight.actualDep}-${info.flight.actualArr}`,
        delayMin: info.flight.delayMin,
        turnaroundDelayMin: info.flight.turnaroundDelayMin,
        closureDelayMin: info.flight.closureDelayMin,
        holdDelayMin: info.flight.holdDelayMin,
        turnaroundSlackMin: info.turnaroundSlackMin,
        rootCauseFlightId: info.flight.rootCauseFlightId,
        causeChain: info.flight.causeChain.map((s) => ({
          flightId: s.flightId,
          kind: s.kind,
          addedDelayMin: s.addedDelayMin,
          description: s.description,
        })),
        crew: info.crew
          ? {
              crew_id: info.crew.crew_id,
              duty_start: info.crew.duty_start,
              dutyMins: info.crew.dutyMins,
              max_duty_mins: info.crew.max_duty_mins,
              marginMin: info.crew.marginMin,
              overageMin: info.crew.overageMin,
              breached: info.crew.breached,
              isStandby: info.crew.isStandby,
            }
          : null,
        connections: [...info.incomingConnections, ...info.outgoingConnections].map((c) => ({
          connection_id: c.connection_id,
          from_flight: c.from_flight,
          to_flight: c.to_flight,
          passengers: c.passengers,
          connectMinutes: c.connectMinutes,
          min_connect_minutes: c.min_connect_minutes,
          status: c.status,
        })),
      };
    }

    if (name === 'compare_objectives') {
      const comparison = compareObjectives(flightNetwork, closure, 3);
      return {
        ok: true,
        profiles: {
          LEGAL_COMPLIANCE: comparison.LEGAL_COMPLIANCE.map(toCandidateSummary),
          PASSENGER_PROTECTION: comparison.PASSENGER_PROTECTION.map(toCandidateSummary),
          DELAY_MINIMIZATION: comparison.DELAY_MINIMIZATION.map(toCandidateSummary),
        },
      };
    }

    return { ok: false, code: 'UNKNOWN_TOOL', reason: `Tool "${name}" is not registered.` };
  }

  return executeTool;
}

const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'simulate_custom_actions',
    description:
      'Validate and simulate a proposed list of recovery actions against physical aircraft continuity, spare base hub, and crew duty rules. Rejects invalid actions (e.g. single non-loop middle-leg cancel or wrong-hub spare) with structured error codes.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        actions: {
          type: Type.ARRAY,
          description: 'List of recovery actions to simulate together.',
          items: {
            type: Type.OBJECT,
            properties: {
              type: {
                type: Type.STRING,
                enum: ['SWAP_SPARE', 'CANCEL_TAIL_END', 'CANCEL_LOOP', 'HOLD_CONNECTION'],
              },
              spare_tail_id: { type: Type.STRING },
              flight_id: { type: Type.STRING },
              flight_ids: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              connection_id: { type: Type.STRING },
            },
            required: ['type'],
          },
        },
      },
      required: ['actions'],
    },
  },
  {
    name: 'inspect_flight',
    description:
      'Inspect a specific flight ID (e.g. DS0304) to get exact scheduled/actual times, full causal delay chain, turnaround slack, connections, and crew duty margin/overage.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        flight_id: { type: Type.STRING, description: 'Flight ID like DS0304' },
      },
      required: ['flight_id'],
    },
  },
  {
    name: 'compare_objectives',
    description:
      'Compare the top 3 recovery plans across LEGAL_COMPLIANCE, PASSENGER_PROTECTION, and DELAY_MINIMIZATION objectives.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
];

function extractFunctionCalls(response: {
  functionCalls?: FunctionCall[];
  candidates?: Array<{ content?: Content }>;
}): FunctionCall[] {
  if (response.functionCalls && response.functionCalls.length > 0) {
    return response.functionCalls;
  }
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p): p is Part & { functionCall: FunctionCall } => Boolean(p.functionCall))
    .map((p) => p.functionCall);
}

export async function runAskToolLoop(params: {
  client: VertexClientLike;
  model: string;
  systemInstruction: string;
  initialPrompt: string;
  executeTool: (name: string, args: Record<string, unknown>) => Record<string, unknown>;
  maxRounds?: number;
}): Promise<{ text: string; toolTrace: ToolTraceEntry[]; roundsExecuted: number }> {
  const maxRounds = Math.min(MAX_TOOL_ROUNDS, params.maxRounds ?? MAX_TOOL_ROUNDS);
  const contents: Content[] = [
    {
      role: 'user',
      parts: [{ text: params.initialPrompt }],
    },
  ];
  const toolTrace: ToolTraceEntry[] = [];
  let roundsExecuted = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    const response = await params.client.models.generateContent({
      model: params.model,
      contents,
      config: {
        systemInstruction: params.systemInstruction,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      },
    });

    const candidateContent = response.candidates?.[0]?.content;
    const calls = extractFunctionCalls(response);

    if (calls.length === 0) {
      return {
        text: (response.text ?? '').trim(),
        toolTrace,
        roundsExecuted,
      };
    }

    // CRITICAL Gemini 3+ rule: preserve exact candidate.content unchanged (with all thoughtSignature parts)
    if (candidateContent) {
      contents.push(candidateContent);
    }

    roundsExecuted += 1;
    const responseParts: Part[] = calls.map((fc) => {
      const toolName = fc.name ?? 'unknown';
      const args = (fc.args ?? {}) as Record<string, unknown>;
      const output = params.executeTool(toolName, args);
      toolTrace.push({
        round: roundsExecuted,
        name: toolName,
        args,
        ok: Boolean(output.ok ?? true),
        code: typeof output.code === 'string' ? output.code : undefined,
      });

      return {
        functionResponse: {
          ...(fc.id ? { id: fc.id } : {}),
          name: toolName,
          response: { output },
        },
      };
    });

    contents.push({
      role: 'user',
      parts: responseParts,
    });
  }

  // Final synthesis pass after reaching max tool rounds (tools disabled so it must conclude)
  const finalResponse = await params.client.models.generateContent({
    model: params.model,
    contents,
    config: {
      systemInstruction: params.systemInstruction,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
    },
  });

  return {
    text: (finalResponse.text ?? '').trim(),
    toolTrace,
    roundsExecuted,
  };
}

function buildDeterministicBriefing(
  closure: ClosureSpec,
  baseline: SimulationResult,
  current: SimulationResult,
  candidates: RecoveryCandidate[],
  objective: ObjectiveProfile,
): string {
  if (!closure) {
    return 'NOMINAL SCHEDULE: No airport closure is active. All 70 scheduled legs operate with 0 delayed flights, 0 delay minutes, 0 broken connections, and 0 crew duty breaches.';
  }

  const bm = baseline.metrics;
  const cm = current.metrics;
  const breached = current.crews.filter((c) => c.breached);
  const broken = current.connections.filter((c) => c.status === 'BROKEN');
  const surge = current.reopeningSurge;

  const lines: string[] = [];
  lines.push(
    `CLOSURE IMPACT (${closure.airport} ${closure.start}–${closure.end}): Baseline cascade produces ${bm.delayedFlightsCount} delayed flights (${bm.totalDelayMinutes}m total delay), ${bm.brokenConnectionsCount} broken connection(s) (${bm.missedConnectionPax} pax), and ${bm.crewBreachesCount} crew duty breach(es)${
      baseline.crews.some((c) => c.breached)
        ? ` [${baseline.crews
            .filter((c) => c.breached)
            .map((c) => `${c.crew_id} +${c.overageMin}m on ${c.lastOperatedFlightId}`)
            .join(', ')}]`
        : ''
    }.`,
  );

  if (surge) {
    lines.push(
      `REOPENING SURGE [${surge.windowStart}–${surge.windowEnd}]: ${surge.operationsCount}/${surge.capacityPerHour} ops (${surge.utilizationPct}% of hourly capacity; ${surge.departuresCount} dep / ${surge.arrivalsCount} arr).`,
    );
  }

  if (current.actions.length > 0) {
    lines.push(
      `ACTIVE PLAN (${current.actions.map(formatActionLabel).join(' + ')}): Delayed ${cm.delayedFlightsCount} flights (${cm.totalDelayMinutes}m), ${cm.crewBreachesCount} crew breach(es)${
        breached.length > 0 ? ` [${breached.map((c) => `${c.crew_id} +${c.overageMin}m`).join(', ')}]` : ''
      }, ${cm.brokenConnectionsCount} broken connection(s)${
        broken.length > 0 ? ` [${broken.map((c) => `${c.connection_id} ${c.passengers}p`).join(', ')}]` : ''
      }, ${cm.totalStrandedOrAtRiskPax} stranded/at-risk pax.`,
    );
  }

  const top = candidates[0];
  if (top) {
    const tradeOffText =
      top.tradeOffWarnings.length > 0
        ? ` Trade-offs: ${top.tradeOffWarnings.join('; ')}.`
        : ' No negative side effects introduced.';
    const standbyText = top.usesStandbyAssumption
      ? ' Note: spare swap relies on the standby hub crew modeling assumption (600m duty clock starting 45m prior to swap actual departure).'
      : '';
    lines.push(
      `TOP RECOMMENDATION (${objective.replace('_', ' ')}): #1 ${top.label} -> ${top.result.metrics.delayedFlightsCount} delayed, ${top.result.metrics.totalDelayMinutes}m delay, ${top.result.metrics.crewBreachesCount} breaches, ${top.result.metrics.brokenConnectionsCount} broken conns, ${top.result.metrics.totalStrandedOrAtRiskPax} stranded/at-risk pax.${tradeOffText}${standbyText}`,
    );
  }

  return lines.join('\n\n');
}

function buildDeterministicAskResponse(params: {
  question: string;
  closure: ClosureSpec;
  current: SimulationResult;
  executeTool: (name: string, args: Record<string, unknown>) => Record<string, unknown>;
}): { narrative: string; toolTrace: ToolTraceEntry[] } {
  const q = params.question.trim();
  const qUpper = q.toUpperCase();
  const toolTrace: ToolTraceEntry[] = [];

  const flightMatches = Array.from(new Set(qUpper.match(/\bDS\d{4}\b/g) ?? []));
  const connMatches = Array.from(new Set(qUpper.match(/\bCX\d{2}\b/g) ?? []));
  const spareMatches = Array.from(new Set(qUpper.match(/\bVT-DS1[78]\b/g) ?? []));

  const run = (name: string, args: Record<string, unknown>) => {
    const out = params.executeTool(name, args);
    toolTrace.push({
      round: toolTrace.length + 1,
      name,
      args,
      ok: Boolean(out.ok ?? true),
      code: typeof out.code === 'string' ? out.code : undefined,
    });
    return out;
  };

  // 1. Check for SWAP_SPARE intent
  if (
    (qUpper.includes('SWAP') || spareMatches.length > 0) &&
    spareMatches.length > 0 &&
    flightMatches.length > 0
  ) {
    const res = run('simulate_custom_actions', {
      actions: [
        { type: 'SWAP_SPARE', spare_tail_id: spareMatches[0], flight_id: flightMatches[0] },
      ],
    });
    if (!res.ok) {
      return {
        narrative: `ACTION REJECTED [${String(res.code)}]: ${String(res.reason)}`,
        toolTrace,
      };
    }
    const after = res.after as SimulationMetrics;
    const before = res.before as SimulationMetrics;
    return {
      narrative: `SIMULATED SWAP ${spareMatches[0]} -> ${flightMatches[0]}: Delayed flights ${before.delayedFlightsCount} -> ${after.delayedFlightsCount}, total delay ${before.totalDelayMinutes}m -> ${after.totalDelayMinutes}m, crew breaches ${before.crewBreachesCount} -> ${after.crewBreachesCount}, broken connections ${before.brokenConnectionsCount} -> ${after.brokenConnectionsCount} (${after.missedConnectionPax} missed pax).${
        res.standbyAssumptionsUsed
          ? ' Assumes standby hub crew starts 600m duty clock 45m before swap leg actual departure.'
          : ''
      }`,
      toolTrace,
    };
  }

  // 2. Check for HOLD_CONNECTION intent
  if (qUpper.includes('HOLD') && connMatches.length > 0) {
    const res = run('simulate_custom_actions', {
      actions: [{ type: 'HOLD_CONNECTION', connection_id: connMatches[0] }],
    });
    if (!res.ok) {
      return {
        narrative: `ACTION REJECTED [${String(res.code)}]: ${String(res.reason)}`,
        toolTrace,
      };
    }
    const after = res.after as SimulationMetrics;
    const before = res.before as SimulationMetrics;
    return {
      narrative: `SIMULATED HOLD ${connMatches[0]}: Broken connections ${before.brokenConnectionsCount} -> ${after.brokenConnectionsCount}, total delay ${before.totalDelayMinutes}m -> ${after.totalDelayMinutes}m, crew breaches ${before.crewBreachesCount} -> ${after.crewBreachesCount}.`,
      toolTrace,
    };
  }

  // 3. Check for CANCEL intent (distinguishing loop vs tail-end vs invalid single-leg cancel)
  if (qUpper.includes('CANCEL') && flightMatches.length > 0) {
    if (flightMatches.length >= 2) {
      const res = run('simulate_custom_actions', {
        actions: [{ type: 'CANCEL_LOOP', flight_ids: flightMatches }],
      });
      if (!res.ok) {
        return {
          narrative: `ACTION REJECTED [${String(res.code)}]: ${String(res.reason)}`,
          toolTrace,
        };
      }
      const after = res.after as SimulationMetrics;
      return {
        narrative: `SIMULATED CANCEL LOOP (${flightMatches.join('+')}): Delayed ${after.delayedFlightsCount} flights (${after.totalDelayMinutes}m), crew breaches ${after.crewBreachesCount}, cancelled pax ${after.cancelledFlightPax}.`,
        toolTrace,
      };
    }

    const fid = flightMatches[0];
    const tailLegs = flightNetwork.flights
      .filter((f) => f.tail_id === flightNetwork.flights.find((x) => x.flight_id === fid)?.tail_id)
      .sort((a, b) => a.leg_order - b.leg_order);
    const isLastLeg = tailLegs.length > 0 && tailLegs[tailLegs.length - 1].flight_id === fid;

    if (qUpper.includes('ONLY') || !isLastLeg) {
      // Test single-leg cancel via CANCEL_LOOP([fid]) so continuity check triggers cleanly
      const invalidCheck = run('simulate_custom_actions', {
        actions: [{ type: 'CANCEL_LOOP', flight_ids: [fid] }],
      });
      if (!invalidCheck.ok) {
        const tailEndCheck = run('simulate_custom_actions', {
          actions: [{ type: 'CANCEL_TAIL_END', flight_id: fid }],
        });
        const tailEndAfter = tailEndCheck.ok ? (tailEndCheck.after as SimulationMetrics) : null;
        return {
          narrative: `CANNOT CANCEL ONLY ${fid} [${String(invalidCheck.code)}]: ${String(invalidCheck.reason)} Valid physical alternatives: cancel a closed loop starting at ${fid} (e.g., if a round-trip returns to its origin) or run CANCEL_TAIL_END(${fid})${
            tailEndAfter
              ? ` which cancels ${tailLegs
                  .filter((l) => l.leg_order >= (tailLegs.find((x) => x.flight_id === fid)?.leg_order ?? 0))
                  .map((l) => l.flight_id)
                  .join('+')} (${tailEndAfter.cancelledFlightPax} pax, ${tailEndAfter.crewBreachesCount} breaches)`
              : ''
          }.`,
          toolTrace,
        };
      }
    }

    const res = run('simulate_custom_actions', {
      actions: [{ type: 'CANCEL_TAIL_END', flight_id: fid }],
    });
    if (!res.ok) {
      return {
        narrative: `ACTION REJECTED [${String(res.code)}]: ${String(res.reason)}`,
        toolTrace,
      };
    }
    const after = res.after as SimulationMetrics;
    return {
      narrative: `SIMULATED CANCEL_TAIL_END(${fid}): Delayed ${after.delayedFlightsCount} flights (${after.totalDelayMinutes}m), crew breaches ${after.crewBreachesCount}, broken connections ${after.brokenConnectionsCount}, cancelled pax ${after.cancelledFlightPax}.`,
      toolTrace,
    };
  }

  // 4. Objective comparison intent
  if (
    qUpper.includes('COMPARE') ||
    qUpper.includes('OBJECTIVE') ||
    qUpper.includes('BEST') ||
    qUpper.includes('RECOMMEND')
  ) {
    const cmp = run('compare_objectives', {});
    const profiles = cmp.profiles as Record<ObjectiveProfile, CandidateSummaryPayload[]>;
    const legal = profiles.LEGAL_COMPLIANCE?.[0];
    const pax = profiles.PASSENGER_PROTECTION?.[0];
    const delay = profiles.DELAY_MINIMIZATION?.[0];
    return {
      narrative: [
        legal
          ? `LEGAL COMPLIANCE #1: ${legal.label} (${legal.metrics.crewBreachesCount} breaches, ${legal.metrics.totalStrandedOrAtRiskPax} stranded/risk pax, ${legal.metrics.totalDelayMinutes}m delay).`
          : 'LEGAL COMPLIANCE: No recovery actions needed.',
        pax
          ? `PASSENGER PROTECTION #1: ${pax.label} (${pax.metrics.totalStrandedOrAtRiskPax} stranded/risk pax, ${pax.metrics.crewBreachesCount} breaches, ${pax.metrics.totalDelayMinutes}m delay).`
          : null,
        delay
          ? `DELAY MINIMIZATION #1: ${delay.label} (${delay.metrics.totalDelayMinutes}m delay, ${delay.metrics.crewBreachesCount} breaches, ${delay.metrics.cancelledFlightPax} cxl pax).`
          : null,
      ]
        .filter(Boolean)
        .join(' '),
      toolTrace,
    };
  }

  // 5. Flight inspection intent
  if (flightMatches.length > 0) {
    const fid = flightMatches[0];
    const info = run('inspect_flight', { flight_id: fid });
    if (!info.ok) {
      return { narrative: String(info.reason), toolTrace };
    }
    const chain = (info.causeChain as Array<{ flightId: string; addedDelayMin: number; description: string }>) ?? [];
    const crew = info.crew as { crew_id: string; dutyMins: number; max_duty_mins: number; breached: boolean; overageMin: number } | null;
    return {
      narrative: `FLIGHT ${String(info.flight_id)} (${String(info.sector)}, tail ${String(info.assignedTail)}): Scheduled ${String(info.scheduled)}, simulated ${String(info.actual)}, delay +${String(info.delayMin)}m (root: ${String(info.rootCauseFlightId ?? 'none')}). ${
        chain.length > 0
          ? `Cascade: ${chain.map((s) => `${s.flightId} +${s.addedDelayMin}m`).join(' -> ')}. `
          : ''
      }${
        crew
          ? `Crew ${crew.crew_id}: ${crew.dutyMins}/${crew.max_duty_mins}m (${
              crew.breached ? `BREACHED +${crew.overageMin}m` : 'legal'
            }).`
          : ''
      }`,
      toolTrace,
    };
  }

  // 6. General fallback summary via compare_objectives
  const cmp = run('compare_objectives', {});
  const profiles = cmp.profiles as Record<ObjectiveProfile, CandidateSummaryPayload[]>;
  const topLegal = profiles.LEGAL_COMPLIANCE?.[0];
  const cm = params.current.metrics;
  return {
    narrative: `Current state (${params.closure ? `${params.closure.airport} ${params.closure.start}–${params.closure.end}` : 'Nominal'}): ${cm.delayedFlightsCount} delayed flights (${cm.totalDelayMinutes}m), ${cm.brokenConnectionsCount} broken connections (${cm.missedConnectionPax} pax), ${cm.crewBreachesCount} crew breaches. ${
      topLegal
        ? `Top legal recovery: ${topLegal.label} (${topLegal.metrics.totalDelayMinutes}m delay, ${topLegal.metrics.crewBreachesCount} breaches, ${topLegal.metrics.totalStrandedOrAtRiskPax} stranded/risk pax). Mention a flight ID (e.g. DS0304), connection (e.g. CX10), or action (SWAP/CANCEL/HOLD) for a specific trace.`
        : 'No recovery interventions required.'
    }`,
    toolTrace,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', reason: 'Use POST /api/dispatch.' });
    return;
  }

  const clientIp = getClientIp(req);
  if (!checkRateLimit(clientIp)) {
    res.setHeader('Retry-After', '60');
    res.status(429).json({
      ok: false,
      code: 'RATE_LIMITED',
      reason: 'Rate limit exceeded (max 20 requests per minute per IP).',
    });
    return;
  }

  const rawBody = req.body;
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    res.status(400).json({ ok: false, code: 'INVALID_BODY', reason: 'Request body must be a JSON object.' });
    return;
  }

  // Zero-trust whitelist: NEVER read or trust pre-computed metrics/snapshots from browser
  const { mode, closure: rawClosure, actions: rawActions, objective: rawObjective, question: rawQuestion } =
    rawBody as Record<string, unknown>;

  if (mode !== 'brief' && mode !== 'ask') {
    res.status(400).json({ ok: false, code: 'INVALID_MODE', reason: 'mode must be "brief" or "ask".' });
    return;
  }

  const objective: ObjectiveProfile =
    typeof rawObjective === 'string' && VALID_OBJECTIVES.has(rawObjective as ObjectiveProfile)
      ? (rawObjective as ObjectiveProfile)
      : 'LEGAL_COMPLIANCE';

  if (rawObjective !== undefined && !VALID_OBJECTIVES.has(rawObjective as ObjectiveProfile)) {
    res.status(400).json({
      ok: false,
      code: 'INVALID_OBJECTIVE',
      reason: 'objective must be LEGAL_COMPLIANCE, PASSENGER_PROTECTION, or DELAY_MINIMIZATION.',
    });
    return;
  }

  const closure = (rawClosure === undefined ? null : rawClosure) as ClosureSpec;
  const closureValidation = validateClosure(flightNetwork, closure);
  if (!closureValidation.ok) {
    res.status(400).json(closureValidation);
    return;
  }

  const actionsValidation = parseAndValidateRawActions(flightNetwork, rawActions);
  if (!actionsValidation.ok) {
    res.status(400).json(actionsValidation);
    return;
  }

  let question = '';
  if (mode === 'ask') {
    if (typeof rawQuestion !== 'string') {
      res.status(400).json({ ok: false, code: 'INVALID_QUESTION', reason: 'question is required for ask mode.' });
      return;
    }
    if (rawQuestion.length > MAX_QUESTION_CHARS) {
      res.status(400).json({
        ok: false,
        code: 'QUESTION_TOO_LONG',
        reason: `question must be at most ${MAX_QUESTION_CHARS} characters (got ${rawQuestion.length}).`,
      });
      return;
    }
    question = rawQuestion.trim();
    if (question.length === 0) {
      res.status(400).json({ ok: false, code: 'INVALID_QUESTION', reason: 'question cannot be blank.' });
      return;
    }
  }

  // Recompute everything server-side deterministically
  const baselineOutcome = simulateNetwork(flightNetwork, closure, []);
  const currentOutcome = simulateNetwork(flightNetwork, closure, actionsValidation.actions);
  if (!baselineOutcome.ok || !currentOutcome.ok) {
    const err = !baselineOutcome.ok ? baselineOutcome : currentOutcome;
    res.status(400).json(err);
    return;
  }

  const baseline = baselineOutcome;
  const current = currentOutcome;
  const candidates = evaluateRecoveryCandidates(flightNetwork, closure, objective, 8);
  const candidateSummaries = candidates.map(toCandidateSummary);

  const modelId = process.env.VERTEX_MODEL?.trim() || DEFAULT_MODEL_ID;
  const deterministicPayload: DispatchResponsePayload['deterministic'] = {
    baseline: summarizeSimulation(baseline),
    current: {
      ...summarizeSimulation(current),
      reopeningSurge: current.reopeningSurge,
      standbyAssumptionsUsed: current.standbyAssumptionsUsed,
    },
    candidates: candidateSummaries,
  };

  let vertexClient: VertexClientLike | null = null;
  let fallbackReason: 'NO_VERTEX_CREDENTIALS' | 'VERTEX_INIT_FAILED' | 'VERTEX_API_UNAVAILABLE' =
    'NO_VERTEX_CREDENTIALS';
  try {
    vertexClient = createVertexClientFromEnv();
  } catch (err) {
    console.warn('[dispatch] Vertex client init failed:', err instanceof Error ? err.message : err);
    fallbackReason = 'VERTEX_INIT_FAILED';
  }

  const executeTool = buildToolContext(closure, baseline, current);

  if (vertexClient) {
    fallbackReason = 'VERTEX_API_UNAVAILABLE';
    try {
      if (mode === 'brief') {
        const promptPayload = {
          closure,
          objective,
          appliedActions: actionsValidation.actions.map(formatActionLabel),
          baseline: deterministicPayload.baseline,
          current: deterministicPayload.current,
          topCandidates: candidateSummaries.slice(0, 5),
        };
        const response = await vertexClient.models.generateContent({
          model: modelId,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: `Produce a concise, high-signal ATC recovery briefing from ONLY this verified server simulation JSON. Cite exact flight IDs, crew IDs, connection IDs, and numbers verbatim. Never invent metrics. Highlight negative trade-offs and note the standby hub crew modeling assumption if swaps appear.\n\n${JSON.stringify(promptPayload)}`,
                },
              ],
            },
          ],
          config: {
            systemInstruction:
              'You are Domino Sky ATC Dispatch AI. Cite ONLY exact numbers and IDs present in the provided simulation JSON. Keep the briefing crisp (3 short paragraphs max).',
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          },
        });

        const narrative = (response.text ?? '').trim();
        if (narrative.length > 0) {
          res.status(200).json({
            ok: true,
            mode,
            engineLabel: 'VERTEX AI · GEMINI 3.8 FLASH',
            model: modelId,
            objective,
            closure,
            appliedActions: actionsValidation.actions,
            deterministic: deterministicPayload,
            narrative,
            toolTrace: [],
          } satisfies DispatchResponsePayload);
          return;
        }
      } else {
        const systemInstruction =
          'You are Domino Sky ATC Operations Analyst. Answer using ONLY data returned by your deterministic tools (simulate_custom_actions, inspect_flight, compare_objectives) and the verified context below. Never invent flight IDs, timings, or metrics. If an action violates aircraft continuity or spare base rules, explain the exact error code returned by simulate_custom_actions. Note standby crew modeling assumptions whenever spare swaps are discussed.';

        const initialPrompt = `Active closure: ${JSON.stringify(closure)}\nActive applied actions: ${JSON.stringify(actionsValidation.actions)}\nSelected objective: ${objective}\nCurrent metrics: ${JSON.stringify(current.metrics)}\n\nDispatcher question: ${question}`;

        const askResult = await runAskToolLoop({
          client: vertexClient,
          model: modelId,
          systemInstruction,
          initialPrompt,
          executeTool,
          maxRounds: MAX_TOOL_ROUNDS,
        });

        if (askResult.text.length > 0) {
          res.status(200).json({
            ok: true,
            mode,
            engineLabel: 'VERTEX AI · GEMINI 3.8 FLASH',
            model: modelId,
            objective,
            closure,
            appliedActions: actionsValidation.actions,
            deterministic: deterministicPayload,
            narrative: askResult.text,
            toolTrace: askResult.toolTrace,
          } satisfies DispatchResponsePayload);
          return;
        }
      }
    } catch (err) {
      console.warn('[dispatch] Vertex API request failed:', err instanceof Error ? err.message : err);
      fallbackReason = 'VERTEX_API_UNAVAILABLE';
    }
  }

  // Seamless deterministic fallback
  if (mode === 'brief') {
    const narrative = buildDeterministicBriefing(closure, baseline, current, candidates, objective);
    res.status(200).json({
      ok: true,
      mode,
      engineLabel: 'DETERMINISTIC FALLBACK',
      model: modelId,
      objective,
      closure,
      appliedActions: actionsValidation.actions,
      deterministic: deterministicPayload,
      narrative,
      toolTrace: [],
      fallbackReason,
    } satisfies DispatchResponsePayload);
    return;
  }

  const deterministicAsk = buildDeterministicAskResponse({
    question,
    closure,
    current,
    executeTool,
  });

  res.status(200).json({
    ok: true,
    mode,
    engineLabel: 'DETERMINISTIC FALLBACK',
    model: modelId,
    objective,
    closure,
    appliedActions: actionsValidation.actions,
    deterministic: deterministicPayload,
    narrative: deterministicAsk.narrative,
    toolTrace: deterministicAsk.toolTrace,
    fallbackReason,
  } satisfies DispatchResponsePayload);
}
