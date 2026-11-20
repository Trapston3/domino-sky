import { useEffect, useMemo, useRef, useState } from 'react';
import { flightNetwork } from './data/flightNetwork.js';
import {
  evaluateRecoveryCandidates,
  parseTimeToMinutes,
  simulateNetwork,
  simulateNetworkOrThrow,
  type ClosureSpec,
  type ObjectiveProfile,
  type RecoveryAction,
  type RecoveryCandidate,
} from './engine/index.js';
import { AirspaceChart, PLAYBACK_MAX, PLAYBACK_MIN } from './components/AirspaceChart.js';
import { AuditTable } from './components/AuditTable.js';
import { DispatcherPanel } from './components/DispatcherPanel.js';
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
  const [objective, setObjective] = useState<ObjectiveProfile>('LEGAL_COMPLIANCE');
  const [viewMode, setViewMode] = useState<WorkspaceViewMode>('SPLIT');
  const [selectedFlightId, setSelectedFlightId] = useState<string | null>(null);
  const [hoveredCandidate, setHoveredCandidate] = useState<RecoveryCandidate | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [playbackMin, setPlaybackMin] = useState<number>(720); // 12:00 IST
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<1 | 2 | 5>(2);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTsRef.current = null;
      return;
    }

    const minsPerSecond = playbackSpeed === 1 ? 12 : playbackSpeed === 2 ? 24 : 60;

    const tick = (ts: number) => {
      if (lastTsRef.current === null) {
        lastTsRef.current = ts;
      } else {
        const dtSec = Math.min(0.1, (ts - lastTsRef.current) / 1000);
        lastTsRef.current = ts;
        setPlaybackMin((prev) => {
          const next = prev + dtSec * minsPerSecond;
          return next >= PLAYBACK_MAX ? PLAYBACK_MIN : next;
        });
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTsRef.current = null;
    };
  }, [isPlaying, playbackSpeed]);

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
    () => evaluateRecoveryCandidates(flightNetwork, closure, objective, 8),
    [closure, objective],
  );

  const handleClosureChange = (next: ClosureSpec) => {
    setClosure(next);
    setActions([]);
    setHoveredCandidate(null);
    setActionError(null);
    setSelectedFlightId(null);
    setPlaybackMin(next ? parseTimeToMinutes(next.start) : 720);
  };

  const handleApplyActions = (nextActions: RecoveryAction[]) => {
    const check = simulateNetwork(flightNetwork, closure, nextActions);
    if (!check.ok) {
      setActionError(`${check.code}: ${check.reason}`);
      return;
    }
    setActionError(null);
    setHoveredCandidate(null);
    setActions(nextActions);
  };

  const handleStackAction = (nextAction: RecoveryAction) => {
    handleApplyActions([...actions, nextAction]);
  };

  const handleRemoveActionAt = (idx: number) => {
    const remaining = actions.filter((_, i) => i !== idx);
    handleApplyActions(remaining);
  };

  const previewSim = hoveredCandidate?.result ?? null;

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

      <KpiStrip
        baseline={baseline}
        current={current}
        preview={previewSim}
        previewLabel={hoveredCandidate?.label ?? null}
      />

      <main className="flex-1 p-3 grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-3 items-start">
        <div className="space-y-3 min-w-0">
          {viewMode === 'SPLIT' && (
            <>
              <div className="grid grid-cols-1 2xl:grid-cols-[minmax(360px,540px)_1fr] gap-3 items-start">
                <AirspaceChart
                  airports={flightNetwork.airports}
                  simulation={current}
                  previewSimulation={previewSim}
                  closure={closure}
                  playbackMin={Math.round(playbackMin)}
                  onChangePlaybackMin={setPlaybackMin}
                  isPlaying={isPlaying}
                  onTogglePlay={() => setIsPlaying((p) => !p)}
                  playbackSpeed={playbackSpeed}
                  onChangeSpeed={setPlaybackSpeed}
                  selectedFlightId={selectedFlightId}
                  onSelectFlight={setSelectedFlightId}
                />
                <StripBoard
                  simulation={current}
                  previewSimulation={previewSim}
                  closure={closure}
                  selectedFlightId={selectedFlightId}
                  onSelectFlight={setSelectedFlightId}
                  playbackMin={Math.round(playbackMin)}
                />
              </div>
              <AuditTable simulation={current} onSelectFlight={setSelectedFlightId} />
            </>
          )}

          {viewMode === 'CHART' && (
            <AirspaceChart
              airports={flightNetwork.airports}
              simulation={current}
              previewSimulation={previewSim}
              closure={closure}
              playbackMin={Math.round(playbackMin)}
              onChangePlaybackMin={setPlaybackMin}
              isPlaying={isPlaying}
              onTogglePlay={() => setIsPlaying((p) => !p)}
              playbackSpeed={playbackSpeed}
              onChangeSpeed={setPlaybackSpeed}
              selectedFlightId={selectedFlightId}
              onSelectFlight={setSelectedFlightId}
            />
          )}

          {viewMode === 'STRIP_BOARD' && (
            <StripBoard
              simulation={current}
              previewSimulation={previewSim}
              closure={closure}
              selectedFlightId={selectedFlightId}
              onSelectFlight={setSelectedFlightId}
              playbackMin={Math.round(playbackMin)}
            />
          )}

          {viewMode === 'AUDIT' && (
            <AuditTable simulation={current} onSelectFlight={setSelectedFlightId} />
          )}
        </div>

        <DispatcherPanel
          closure={closure}
          actions={actions}
          objective={objective}
          onChangeObjective={setObjective}
          candidates={candidates}
          baseline={baseline}
          current={current}
          actionError={actionError}
          onApplyActions={handleApplyActions}
          onStackAction={handleStackAction}
          onRemoveActionAt={handleRemoveActionAt}
          onResetActions={() => {
            setActions([]);
            setActionError(null);
          }}
          onHoverCandidate={setHoveredCandidate}
          onSelectFlight={setSelectedFlightId}
        />
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
