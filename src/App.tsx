import { useMemo, useState } from 'react';
import { flightNetwork } from './data/flightNetwork.js';
import {
  evaluateRecoveryCandidates,
  simulateNetwork,
  simulateNetworkOrThrow,
  type ClosureSpec,
  type ObjectiveProfile,
  type RecoveryAction,
} from './engine/index.js';
import { AuditTable } from './components/AuditTable.js';
import { FlightTraceDrawer } from './components/FlightTraceDrawer.js';
import { KpiStrip } from './components/KpiStrip.js';
import { StripBoard } from './components/StripBoard.js';
import { TopControlBar, type WorkspaceViewMode } from './components/TopControlBar.js';

export default function App() {
  const [closure, setClosure] = useState<ClosureSpec>({
    airport: 'DEL',
    start: '12:00',
    end: '13:30',
  });
  const [actions, setActions] = useState<RecoveryAction[]>([]);
  const [objective] = useState<ObjectiveProfile>('LEGAL_COMPLIANCE');
  const [viewMode, setViewMode] = useState<WorkspaceViewMode>('STRIP_BOARD');
  const [selectedFlightId, setSelectedFlightId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const baseline = useMemo(
    () => simulateNetworkOrThrow(flightNetwork, closure, []),
    [closure],
  );

  const currentOutcome = useMemo(
    () => simulateNetwork(flightNetwork, closure, actions),
    [closure, actions],
  );

  const current = currentOutcome.ok ? currentOutcome : baseline;

  const candidates = useMemo(
    () => evaluateRecoveryCandidates(flightNetwork, closure, objective, 6),
    [closure, objective],
  );

  const handleClosureChange = (next: ClosureSpec) => {
    setClosure(next);
    setActions([]);
    setActionError(null);
    setSelectedFlightId(null);
  };

  const handleApplyActions = (nextActions: RecoveryAction[]) => {
    const check = simulateNetwork(flightNetwork, closure, nextActions);
    if (!check.ok) {
      setActionError(`${check.code}: ${check.reason}`);
      return;
    }
    setActionError(null);
    setActions(nextActions);
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#EDE7D8] text-[#14130F]">
      <TopControlBar
        airports={flightNetwork.airports}
        closure={closure}
        onChangeClosure={handleClosureChange}
        reopeningSurge={current.reopeningSurge}
        viewMode={viewMode}
        onChangeViewMode={setViewMode}
        activeActionsCount={actions.length}
        onResetActions={() => {
          setActions([]);
          setActionError(null);
        }}
      />

      <KpiStrip baseline={baseline} current={current} />

      {actionError && (
        <div className="mx-3 mt-2 px-3 py-1.5 border border-[#C8341C] bg-[#F6F2E8] font-mono text-xs text-[#C8341C]">
          {actionError}
        </div>
      )}

      <main className="flex-1 p-3 grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-3 items-start">
        <div className="space-y-3 min-w-0">
          {viewMode === 'AUDIT' ? (
            <AuditTable simulation={current} onSelectFlight={setSelectedFlightId} />
          ) : (
            <>
              <StripBoard
                simulation={current}
                closure={closure}
                selectedFlightId={selectedFlightId}
                onSelectFlight={setSelectedFlightId}
              />
              <AuditTable simulation={current} onSelectFlight={setSelectedFlightId} />
            </>
          )}
        </div>

        {/* Phase 1 Recovery Candidate Summary Column (upgraded to full Vertex AI Dispatcher in Phase 3) */}
        <aside className="border border-[#14130F] bg-[#F6F2E8] p-3 space-y-2 rounded-[2px]">
          <div className="border-b border-[#14130F] pb-2 flex items-center justify-between">
            <h2 className="font-display font-bold text-base uppercase tracking-wide">
              RECOVERY CANDIDATES
            </h2>
            <span className="font-mono text-[10px] text-[#575246]">{objective}</span>
          </div>
          {candidates.length === 0 ? (
            <div className="font-mono text-xs text-[#575246]">
              Network nominal — no recovery actions required.
            </div>
          ) : (
            <div className="space-y-2">
              {candidates.map((cand) => (
                <div
                  key={cand.id}
                  className="border border-[#C8BFA8] bg-[#EDE7D8] p-2 font-mono text-[11px] space-y-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-[#14130F]">
                      #{cand.scoreRank} {cand.label}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleApplyActions(cand.actions)}
                      className="px-2 py-0.5 border border-[#1D4E89] bg-[#1D4E89] text-[#F6F2E8] text-[10px] font-semibold cursor-pointer"
                    >
                      APPLY
                    </button>
                  </div>
                  <div className="text-[10px] text-[#575246] tabular-nums">
                    Delay {cand.result.metrics.totalDelayMinutes}m · Breaches{' '}
                    {cand.result.metrics.crewBreachesCount} · Broken{' '}
                    {cand.result.metrics.brokenConnectionsCount}
                  </div>
                </div>
              ))}
            </div>
          )}
        </aside>
      </main>

      <FlightTraceDrawer
        flightId={selectedFlightId}
        simulation={current}
        dataset={flightNetwork}
        onClose={() => setSelectedFlightId(null)}
        onSelectFlight={setSelectedFlightId}
      />
    </div>
  );
}
