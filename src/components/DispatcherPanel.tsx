import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Send, AlertTriangle, Check, Plus, X } from 'lucide-react';
import type { DispatchResponsePayload, ToolTraceEntry } from '../../api/dispatch.js';
import {
  formatActionLabel,
  formatCandidateId,
  type ClosureSpec,
  type ObjectiveProfile,
  type RecoveryAction,
  type RecoveryCandidate,
  type SimulationResult,
} from '../engine/index.js';
import { FlightChipButton } from './FlightChipButton.js';

interface DispatcherPanelProps {
  closure: ClosureSpec;
  actions: RecoveryAction[];
  objective: ObjectiveProfile;
  onChangeObjective: (next: ObjectiveProfile) => void;
  candidates: RecoveryCandidate[];
  baseline: SimulationResult;
  current: SimulationResult;
  actionError: string | null;
  onApplyActions: (next: RecoveryAction[]) => void;
  onStackAction: (action: RecoveryAction) => void;
  onRemoveActionAt: (idx: number) => void;
  onResetActions: () => void;
  onHoverCandidate: (candidate: RecoveryCandidate | null) => void;
  onSelectFlight: (flightId: string) => void;
}

interface QaExchange {
  id: string;
  question: string;
  answer: string;
  engineLabel: string;
  toolTrace: ToolTraceEntry[];
  error?: string;
}

const OBJECTIVE_TABS: Array<{ id: ObjectiveProfile; label: string; hint: string }> = [
  { id: 'LEGAL_COMPLIANCE', label: 'LEGAL COMPLIANCE', hint: '0 Breaches -> Min Pax -> Min Delay' },
  { id: 'PASSENGER_PROTECTION', label: 'PAX PROTECTION', hint: 'Min Stranded Pax -> 0 Breaches -> Min Delay' },
  { id: 'DELAY_MINIMIZATION', label: 'MIN DELAY', hint: 'Min Total Delay -> 0 Breaches -> Min Pax' },
];

const FLIGHT_ID_TOKEN_RE = /(\bDS\d{4}\b)/g;

function renderTextWithFlightChips(
  text: string,
  onSelectFlight: (flightId: string) => void,
): React.ReactNode {
  const parts = text.split(FLIGHT_ID_TOKEN_RE);
  return parts.map((part, idx) => {
    if (/^DS\d{4}$/.test(part)) {
      return (
        <span key={`${part}-${idx}`} className="mx-0.5 inline-block align-baseline">
          <FlightChipButton id={part} onSelect={onSelectFlight} />
        </span>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

function formatDeltaBadge(val: number, suffix = ''): string {
  if (val === 0) return `0${suffix}`;
  return `${val > 0 ? '+' : ''}${val}${suffix}`;
}

export const DispatcherPanel: React.FC<DispatcherPanelProps> = ({
  closure,
  actions,
  objective,
  onChangeObjective,
  candidates,
  baseline,
  current,
  actionError,
  onApplyActions,
  onStackAction,
  onRemoveActionAt,
  onResetActions,
  onHoverCandidate,
  onSelectFlight,
}) => {
  const [briefData, setBriefData] = useState<DispatchResponsePayload | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const [questionInput, setQuestionInput] = useState('');
  const [askLoading, setAskLoading] = useState(false);
  const [qaHistory, setQaHistory] = useState<QaExchange[]>([]);

  // Fetch automatic server-side briefing (Mode 1)
  useEffect(() => {
    const controller = new AbortController();
    setBriefLoading(true);
    setBriefError(null);

    fetch('/api/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        mode: 'brief',
        closure,
        actions,
        objective,
      }),
    })
      .then(async (resp) => {
        const json = (await resp.json()) as DispatchResponsePayload & { reason?: string; ok?: boolean };
        if (!resp.ok || !json.ok) {
          throw new Error(json.reason || `HTTP ${resp.status}`);
        }
        setBriefData(json);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        setBriefError(err instanceof Error ? err.message : 'Failed to load briefing');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setBriefLoading(false);
        }
      });

    return () => controller.abort();
  }, [closure, actions, objective, refreshTick]);

  const quickQuestions = useMemo(() => {
    if (!closure) {
      return [
        'Compare all 3 objectives on a nominal day',
        'Inspect DS0304 crew margin',
      ];
    }
    if (closure.airport === 'DEL') {
      return [
        'Inspect DS0304 root cause and crew margin',
        'What happens if we swap VT-DS18 onto DS0304?',
        'Compare all 3 objectives',
      ];
    }
    if (closure.airport === 'BLR') {
      return [
        'What breaks if we swap VT-DS17 onto DS0802?',
        'Hold CX12 and inspect DS0504',
        'Compare all 3 objectives',
      ];
    }
    if (closure.airport === 'CCU') {
      return [
        'Can we cancel only DS1003?',
        'Compare CANCEL_TAIL_END DS1005 vs CANCEL_LOOP DS1003+DS1004',
        'Inspect DS1005',
      ];
    }
    return [
      'Inspect DS1201 and broken connections',
      'Compare all 3 objectives',
    ];
  }, [closure]);

  const submitQuestion = async (rawQ: string) => {
    const trimmed = rawQ.trim();
    if (!trimmed || trimmed.length > 300 || askLoading) return;

    setAskLoading(true);
    setQuestionInput('');
    try {
      const resp = await fetch('/api/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'ask',
          closure,
          actions,
          objective,
          question: trimmed,
        }),
      });
      const json = (await resp.json()) as DispatchResponsePayload & {
        ok?: boolean;
        code?: string;
        reason?: string;
      };
      if (!resp.ok || !json.ok) {
        setQaHistory((prev) => [
          {
            id: `${Date.now()}-${Math.random()}`,
            question: trimmed,
            answer: json.reason || `Request failed (${resp.status})`,
            engineLabel: 'VALIDATION ERROR',
            toolTrace: [],
            error: json.code || `HTTP_${resp.status}`,
          },
          ...prev,
        ]);
      } else {
        setQaHistory((prev) => [
          {
            id: `${Date.now()}-${Math.random()}`,
            question: trimmed,
            answer: json.narrative,
            engineLabel: json.engineLabel,
            toolTrace: json.toolTrace,
          },
          ...prev,
        ]);
      }
    } catch (err) {
      setQaHistory((prev) => [
        {
          id: `${Date.now()}-${Math.random()}`,
          question: trimmed,
          answer: err instanceof Error ? err.message : 'Network error querying dispatcher',
          engineLabel: 'ERROR',
          toolTrace: [],
          error: 'NETWORK_ERROR',
        },
        ...prev,
      ]);
    } finally {
      setAskLoading(false);
    }
  };

  // Strictly deterministic Before->After table from server JSON (falling back to local engine only while loading initial payload)
  const tableBefore = briefData?.deterministic.baseline.metrics ?? baseline.metrics;
  const tableAfter = briefData?.deterministic.current.metrics ?? current.metrics;
  const engineLabel = briefData?.engineLabel ?? 'DETERMINISTIC FALLBACK';
  const activeStackId = useMemo(() => formatCandidateId(actions), [actions]);
  const activeSingleIds = useMemo(
    () => new Set(actions.map((a) => formatCandidateId([a]))),
    [actions],
  );

  return (
    <aside className="border border-[#14130F] bg-[#F6F2E8] rounded-[2px] flex flex-col min-w-0">
      {/* Header + Provenance */}
      <div className="border-b border-[#14130F] bg-[#EDE7D8] px-3 py-2 flex items-center justify-between gap-2">
        <div>
          <h2 className="font-display font-bold text-base tracking-wide uppercase text-[#14130F]">
            AI DISPATCHER CONSOLE
          </h2>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span
              className={`px-1.5 py-0.5 border font-mono text-[9px] font-bold tracking-wider ${
                engineLabel.startsWith('VERTEX')
                  ? 'border-[#1D4E89] bg-[#1D4E89] text-[#F6F2E8]'
                  : 'border-[#575246] bg-[#F6F2E8] text-[#14130F]'
              }`}
            >
              {engineLabel}
            </span>
            {briefLoading && (
              <span className="font-mono text-[10px] text-[#575246]">SYNCING...</span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setRefreshTick((t) => t + 1)}
          title="Refresh server-side dispatch briefing"
          aria-label="Refresh dispatch briefing"
          className="p-1.5 border border-[#14130F] bg-[#F6F2E8] hover:bg-[#14130F] hover:text-[#F6F2E8] cursor-pointer rounded-[2px]"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${briefLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* 3 Objective Profile Switcher */}
      <div className="border-b border-[#14130F] p-2 bg-[#EDE7D8]/70">
        <div className="font-mono text-[10px] uppercase tracking-wider text-[#575246] mb-1">
          DISPATCH OBJECTIVE PROFILE
        </div>
        <div className="grid grid-cols-3 gap-1" role="group" aria-label="Dispatch objective profile">
          {OBJECTIVE_TABS.map((tab) => {
            const active = objective === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                aria-pressed={active}
                onClick={() => onChangeObjective(tab.id)}
                title={tab.hint}
                className={`px-1.5 py-1.5 border font-mono text-[10px] font-bold leading-tight text-center cursor-pointer rounded-[2px] ${
                  active
                    ? 'border-[#14130F] bg-[#14130F] text-[#F6F2E8]'
                    : 'border-[#C8BFA8] bg-[#F6F2E8] text-[#14130F] hover:border-[#14130F]'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Active Action Stack */}
      {actions.length > 0 && (
        <div className="border-b border-[#14130F] p-2.5 bg-[#1D4E89]/10">
          <div className="flex items-center justify-between mb-1.5">
            <span className="font-mono text-[10px] font-bold uppercase text-[#1D4E89]">
              ACTIVE STACK ({actions.length})
            </span>
            <button
              type="button"
              onClick={onResetActions}
              className="font-mono text-[10px] font-semibold underline text-[#1D4E89] cursor-pointer"
            >
              RESET ALL
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {actions.map((act, idx) => (
              <span
                key={`${formatActionLabel(act)}-${idx}`}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-[#1D4E89] bg-[#1D4E89] text-[#F6F2E8] font-mono text-[10px] font-semibold"
              >
                {formatActionLabel(act)}
                <button
                  type="button"
                  onClick={() => onRemoveActionAt(idx)}
                  aria-label={`Remove ${formatActionLabel(act)}`}
                  className="hover:text-[#EDE7D8] cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {actionError && (
        <div
          role="alert"
          className="border-b border-[#C8341C] bg-[#C8341C]/10 px-3 py-2 font-mono text-[11px] text-[#C8341C] flex items-start gap-1.5"
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{actionError}</span>
        </div>
      )}

      {/* Deterministic Before->After Table + Briefing Narrative */}
      <div className="border-b border-[#14130F] p-3 space-y-2.5">
        <div className="font-display font-bold text-xs tracking-wider uppercase text-[#575246]">
          SERVER-VERIFIED BRIEFING &amp; DELTA TABLE
        </div>

        {/* Strictly rendered from deterministic JSON */}
        <table className="w-full border border-[#14130F] border-collapse font-mono text-[10px] tabular-nums bg-[#EDE7D8]">
          <thead>
            <tr className="border-b border-[#14130F] text-[#575246]">
              <th className="px-2 py-1 text-left">METRIC</th>
              <th className="px-2 py-1 text-right">BEFORE</th>
              <th className="px-2 py-1 text-right">AFTER</th>
              <th className="px-2 py-1 text-right">DELTA</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#C8BFA8] bg-[#F6F2E8]">
            {[
              {
                label: 'Delayed Legs',
                b: tableBefore.delayedFlightsCount,
                a: tableAfter.delayedFlightsCount,
                unit: '',
              },
              {
                label: 'Delay Mins',
                b: tableBefore.totalDelayMinutes,
                a: tableAfter.totalDelayMinutes,
                unit: 'm',
              },
              {
                label: 'Crew Breaches',
                b: tableBefore.crewBreachesCount,
                a: tableAfter.crewBreachesCount,
                unit: '',
              },
              {
                label: 'Broken Conns',
                b: tableBefore.brokenConnectionsCount,
                a: tableAfter.brokenConnectionsCount,
                unit: '',
              },
              {
                label: 'Stranded/Risk Pax',
                b: tableBefore.totalStrandedOrAtRiskPax,
                a: tableAfter.totalStrandedOrAtRiskPax,
                unit: '',
              },
            ].map((row) => {
              const d = row.a - row.b;
              return (
                <tr key={row.label}>
                  <td className="px-2 py-1 font-semibold">{row.label}</td>
                  <td className="px-2 py-1 text-right text-[#575246]">
                    {row.b}
                    {row.unit}
                  </td>
                  <td className="px-2 py-1 text-right font-bold">
                    {row.a}
                    {row.unit}
                  </td>
                  <td
                    className={`px-2 py-1 text-right font-bold ${
                      d < 0 ? 'text-[#2F6B4F]' : d > 0 ? 'text-[#C8341C]' : 'text-[#575246]'
                    }`}
                  >
                    {formatDeltaBadge(d, row.unit)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {briefError ? (
          <div
            role="alert"
            className="font-mono text-[11px] text-[#C8341C] border border-[#C8341C] p-2 bg-[#EDE7D8]"
          >
            Briefing error: {briefError}
          </div>
        ) : (
          <div className="font-sans text-xs leading-relaxed text-[#14130F] whitespace-pre-line bg-[#EDE7D8]/70 border border-[#C8BFA8] p-2.5">
            {briefData
              ? renderTextWithFlightChips(briefData.narrative, onSelectFlight)
              : 'Computing server-side dispatch briefing...'}
          </div>
        )}
      </div>

      {/* Ranked Trade-Off Recovery Cards */}
      <div className="border-b border-[#14130F] p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-display font-bold text-xs tracking-wider uppercase text-[#575246]">
            RANKED TRADE-OFF OPTIONS (HOVER TO PREVIEW)
          </span>
          <span className="font-mono text-[10px] text-[#575246]">{candidates.length} PLANS</span>
        </div>

        {candidates.length === 0 ? (
          <div className="font-mono text-xs text-[#2F6B4F] border border-[#2F6B4F] bg-[#EDE7D8] p-2">
            Schedule nominal — no recovery actions needed.
          </div>
        ) : (
          <div className="space-y-2 max-h-[360px] overflow-y-auto pr-0.5">
            {candidates.map((cand) => {
              const isApplied = actions.length > 0 && activeStackId === cand.id;
              const canStack =
                actions.length > 0 &&
                cand.actions.length === 1 &&
                !activeSingleIds.has(cand.id);

              return (
                <div
                  key={cand.id}
                  onMouseEnter={() => onHoverCandidate(cand)}
                  onMouseLeave={() => onHoverCandidate(null)}
                  onFocus={() => onHoverCandidate(cand)}
                  onBlur={() => onHoverCandidate(null)}
                  tabIndex={0}
                  className={`border p-2.5 rounded-[2px] transition-colors ${
                    isApplied
                      ? 'border-[#1D4E89] bg-[#1D4E89]/10'
                      : 'border-[#14130F] bg-[#EDE7D8] hover:bg-[#F6F2E8]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-mono text-[11px] font-bold text-[#14130F]">
                        #{cand.scoreRank} {cand.label}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1.5 font-mono text-[10px] tabular-nums">
                        <span className="px-1 border border-[#C8BFA8] bg-[#F6F2E8]">
                          Delay {cand.result.metrics.totalDelayMinutes}m (
                          {formatDeltaBadge(cand.deltas.totalDelayMinutes, 'm')})
                        </span>
                        <span
                          className={`px-1 border ${
                            cand.result.metrics.crewBreachesCount === 0
                              ? 'border-[#2F6B4F] text-[#2F6B4F] bg-[#F6F2E8]'
                              : 'border-[#C8341C] text-[#C8341C] bg-[#F6F2E8]'
                          }`}
                        >
                          Breaches {cand.result.metrics.crewBreachesCount}
                        </span>
                        <span
                          className={`px-1 border ${
                            cand.result.metrics.brokenConnectionsCount === 0
                              ? 'border-[#2F6B4F] text-[#2F6B4F] bg-[#F6F2E8]'
                              : 'border-[#C8341C] text-[#C8341C] bg-[#F6F2E8]'
                          }`}
                        >
                          Broken {cand.result.metrics.brokenConnectionsCount}
                        </span>
                        <span className="px-1 border border-[#C8BFA8] bg-[#F6F2E8]">
                          Risk Pax {cand.result.metrics.totalStrandedOrAtRiskPax}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => onApplyActions(cand.actions)}
                        className={`inline-flex items-center justify-center gap-1 px-2 py-1 border font-mono text-[10px] font-bold cursor-pointer rounded-[2px] ${
                          isApplied
                            ? 'border-[#2F6B4F] bg-[#2F6B4F] text-[#F6F2E8]'
                            : 'border-[#1D4E89] bg-[#1D4E89] text-[#F6F2E8] hover:bg-[#14130F] hover:border-[#14130F]'
                        }`}
                      >
                        {isApplied ? <Check className="w-3 h-3" /> : null}
                        {isApplied ? 'ACTIVE' : 'APPLY'}
                      </button>

                      {canStack && (
                        <button
                          type="button"
                          onClick={() => onStackAction(cand.actions[0])}
                          className="inline-flex items-center justify-center gap-0.5 px-2 py-0.5 border border-[#14130F] bg-[#F6F2E8] font-mono text-[9px] font-semibold cursor-pointer hover:bg-[#14130F] hover:text-[#F6F2E8] rounded-[2px]"
                        >
                          <Plus className="w-2.5 h-2.5" />
                          STACK
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Positives */}
                  {cand.positives.length > 0 && (
                    <div className="mt-1.5 space-y-0.5 font-mono text-[10px] text-[#2F6B4F]">
                      {cand.positives.map((pos) => (
                        <div key={pos}>+ {pos}</div>
                      ))}
                    </div>
                  )}

                  {/* Negative Trade-Off Highlight */}
                  {cand.tradeOffWarnings.length > 0 && (
                    <div className="mt-1.5 border border-[#C8341C] bg-[#F6F2E8] px-2 py-1 font-mono text-[10px] text-[#C8341C]">
                      <span className="font-bold">TRADE-OFF:</span>{' '}
                      {cand.tradeOffWarnings.join(' · ')}
                    </div>
                  )}

                  {cand.usesStandbyAssumption && (
                    <div className="mt-1 font-mono text-[9px] text-[#1D4E89]">
                      * Standby hub crew clock starts 45m prior to swap leg actualDep.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Dynamic Q&A (Mode 2) */}
      <div className="p-3 space-y-2">
        <div className="font-display font-bold text-xs tracking-wider uppercase text-[#575246]">
          DISPATCH Q&amp;A (SERVER TOOL LOOP · 300 CHAR MAX)
        </div>

        <div className="flex flex-wrap gap-1">
          {quickQuestions.map((qq) => (
            <button
              key={qq}
              type="button"
              onClick={() => submitQuestion(qq)}
              disabled={askLoading}
              className="px-1.5 py-0.5 border border-[#C8BFA8] bg-[#EDE7D8] hover:border-[#14130F] font-mono text-[10px] text-[#14130F] cursor-pointer text-left rounded-[2px]"
            >
              {qq}
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitQuestion(questionInput);
          }}
          className="space-y-1"
        >
          <div className="flex gap-1">
            <input
              type="text"
              value={questionInput}
              onChange={(e) => setQuestionInput(e.target.value)}
              maxLength={300}
              placeholder="Ask e.g. 'Can we cancel only DS1003?' or 'Inspect DS0304'"
              aria-label="Ask dispatcher question"
              className="flex-1 min-w-0 border border-[#14130F] bg-[#EDE7D8] px-2 py-1.5 font-mono text-[11px] text-[#14130F] placeholder:text-[#575246] rounded-[2px]"
            />
            <button
              type="submit"
              disabled={askLoading || questionInput.trim().length === 0}
              aria-label="Send question"
              className="px-2.5 py-1.5 border border-[#14130F] bg-[#14130F] text-[#F6F2E8] font-mono text-[11px] font-semibold cursor-pointer disabled:opacity-40 inline-flex items-center gap-1 rounded-[2px]"
            >
              <Send className="w-3 h-3" />
              ASK
            </button>
          </div>
          <div className="flex justify-between font-mono text-[9px] text-[#575246] tabular-nums">
            <span>Tools: simulate_custom_actions · inspect_flight · compare_objectives</span>
            <span>{questionInput.length}/300</span>
          </div>
        </form>

        {qaHistory.length > 0 && (
          <div aria-live="polite" className="space-y-2 max-h-[260px] overflow-y-auto pt-1">
            {qaHistory.map((item) => (
              <div
                key={item.id}
                className="border border-[#14130F] bg-[#EDE7D8] p-2 space-y-1.5 rounded-[2px]"
              >
                <div className="font-mono text-[10px] font-bold text-[#14130F]">
                  Q: {item.question}
                </div>
                {item.toolTrace.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {item.toolTrace.map((t, idx) => (
                      <span
                        key={`${t.name}-${idx}`}
                        className={`px-1 py-0.5 border font-mono text-[9px] ${
                          t.ok
                            ? 'border-[#1D4E89] text-[#1D4E89] bg-[#F6F2E8]'
                            : 'border-[#C8341C] text-[#C8341C] bg-[#F6F2E8]'
                        }`}
                      >
                        #{t.round} {t.name}
                        {t.code ? ` [${t.code}]` : ''}
                      </span>
                    ))}
                  </div>
                )}
                <div
                  className={`font-sans text-xs leading-relaxed whitespace-pre-line ${
                    item.error ? 'text-[#C8341C]' : 'text-[#14130F]'
                  }`}
                >
                  {renderTextWithFlightChips(item.answer, onSelectFlight)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
};
