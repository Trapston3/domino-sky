import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import {
  formatMinutesToTime,
  inspectFlight,
  type FlightNetworkDataset,
  type SimulationResult,
} from '../engine/index.js';
import { FlightChipButton } from './FlightChipButton.js';

interface FlightTraceDrawerProps {
  flightId: string | null;
  simulation: SimulationResult;
  dataset: FlightNetworkDataset;
  onClose: () => void;
  onSelectFlight: (flightId: string) => void;
}

export const FlightTraceDrawer: React.FC<FlightTraceDrawerProps> = ({
  flightId,
  simulation,
  dataset,
  onClose,
  onSelectFlight,
}) => {
  useEffect(() => {
    if (!flightId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [flightId, onClose]);

  if (!flightId) return null;
  const inspection = inspectFlight(simulation, dataset, flightId);
  if (!inspection) return null;

  const {
    flight,
    previousTailLeg,
    nextTailLeg,
    turnaroundSlackMin,
    incomingConnections,
    outgoingConnections,
    crew,
    tailChain,
  } = inspection;

  const statusBadgeClass =
    flight.status === 'CANCELLED' || flight.status === 'CREW_BREACH'
      ? 'border-[#C8341C] bg-[#C8341C] text-[#F6F2E8]'
      : flight.status === 'DELAYED'
        ? 'border-[#C98A0B] bg-[#C98A0B] text-[#14130F]'
        : 'border-[#2F6B4F] bg-[#2F6B4F] text-[#F6F2E8]';

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-[#14130F]/35"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="flight-trace-title"
    >
      <div
        className="w-full max-w-lg h-full bg-[#F6F2E8] border-l-2 border-[#14130F] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="border-b-2 border-[#14130F] bg-[#EDE7D8] px-4 py-3 flex items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span
                id="flight-trace-title"
                className="font-display font-bold text-xl tracking-wide text-[#14130F]"
              >
                {flight.flight_id}
              </span>
              <span className="font-mono text-sm font-semibold text-[#14130F]">
                {flight.origin} → {flight.destination}
              </span>
              <span className={`px-1.5 py-0.5 border font-mono text-[10px] font-bold ${statusBadgeClass}`}>
                {flight.status.replace('_', ' ')}
              </span>
              {flight.spareTailId && (
                <span className="px-1.5 py-0.5 border border-[#1D4E89] bg-[#1D4E89] text-[#F6F2E8] font-mono text-[10px] font-bold">
                  SPARE {flight.spareTailId}
                </span>
              )}
            </div>
            <div className="font-mono text-[11px] text-[#575246] mt-0.5 tabular-nums">
              Orig Tail {flight.tail_id} · Assigned {flight.assignedTail} · Leg #{flight.leg_order} ·{' '}
              {flight.pax} pax · Block {flight.block_minutes}m
            </div>
          </div>

          <button
            type="button"
            autoFocus
            onClick={onClose}
            aria-label="Close flight trace drawer"
            className="p-1.5 border border-[#14130F] bg-[#F6F2E8] hover:bg-[#14130F] hover:text-[#F6F2E8] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Timing & Delay Breakdown */}
          <div className="border border-[#14130F] bg-[#EDE7D8] p-3">
            <div className="font-display font-bold text-xs uppercase tracking-wider text-[#575246] mb-2">
              TIMING &amp; DELAY ATTRIBUTION
            </div>
            <div className="grid grid-cols-3 gap-2 font-mono text-xs tabular-nums">
              <div className="border border-[#C8BFA8] bg-[#F6F2E8] p-2">
                <div className="text-[10px] text-[#575246]">SCHEDULED</div>
                <div className="font-semibold mt-0.5">
                  {flight.dep} – {flight.arr}
                </div>
              </div>
              <div className="border border-[#C8BFA8] bg-[#F6F2E8] p-2">
                <div className="text-[10px] text-[#575246]">SIMULATED</div>
                <div className="font-semibold mt-0.5">
                  {flight.cancelled ? 'CANCELLED' : `${flight.actualDep} – ${flight.actualArr}`}
                </div>
              </div>
              <div className="border border-[#C8BFA8] bg-[#F6F2E8] p-2">
                <div className="text-[10px] text-[#575246]">TOTAL DELAY</div>
                <div
                  className={`font-bold mt-0.5 ${
                    flight.delayMin > 0 ? 'text-[#8A5D00]' : 'text-[#2F6B4F]'
                  }`}
                >
                  {flight.cancelled ? 'CXL' : `+${flight.delayMin}m`}
                </div>
              </div>
            </div>
            {!flight.cancelled && (
              <div className="mt-2 font-mono text-[11px] text-[#575246] flex flex-wrap gap-x-4 tabular-nums">
                <span>Closure Hold: +{flight.closureDelayMin}m</span>
                <span>Turnaround Cascade: +{flight.turnaroundDelayMin}m</span>
                <span>Conn Hold: +{flight.holdDelayMin}m</span>
                <span>
                  Turn Slack:{' '}
                  {turnaroundSlackMin !== null
                    ? `${turnaroundSlackMin}m (min ${dataset.meta.min_turnaround_minutes}m)`
                    : 'N/A (first / takeover leg)'}
                </span>
              </div>
            )}
          </div>

          {/* Root-Cause Chain */}
          <div className="border border-[#14130F] bg-[#F6F2E8] p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="font-display font-bold text-xs uppercase tracking-wider text-[#575246]">
                ROOT-CAUSE PROPAGATION CHAIN
              </span>
              {flight.rootCauseFlightId && (
                <span className="font-mono text-[10px] font-semibold text-[#14130F]">
                  ROOT:{' '}
                  <FlightChipButton
                    id={flight.rootCauseFlightId}
                    onSelect={onSelectFlight}
                    variant="breach"
                  />
                </span>
              )}
            </div>

            {flight.cancelled ? (
              <div className="font-mono text-xs text-[#C8341C] border border-[#C8341C] bg-[#EDE7D8] p-2">
                Flight cancelled by {flight.cancelledBy}. Downstream turnaround propagation halted on this leg.
              </div>
            ) : flight.causeChain.length === 0 ? (
              <div className="font-mono text-xs text-[#2F6B4F] border border-[#2F6B4F] bg-[#EDE7D8] p-2">
                Operating cleanly on published schedule — zero upstream or closure propagation.
              </div>
            ) : (
              <ol className="space-y-1.5">
                {flight.causeChain.map((step, idx) => (
                  <li
                    key={`${step.flightId}-${step.kind}-${idx}`}
                    className="border border-[#C8BFA8] bg-[#EDE7D8] px-2.5 py-2 font-mono text-[11px]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <span className="px-1 bg-[#14130F] text-[#F6F2E8] text-[10px] font-bold">
                          {idx + 1}
                        </span>
                        <FlightChipButton
                          id={step.flightId}
                          onSelect={onSelectFlight}
                          variant={step.kind.startsWith('CLOSURE') ? 'breach' : 'delayed'}
                        />
                        <span className="text-[10px] font-semibold text-[#575246]">
                          {step.kind}
                        </span>
                      </div>
                      <span className="font-bold text-[#8A5D00] tabular-nums">
                        +{step.addedDelayMin}m ({formatMinutesToTime(step.fromTimeMin)} →{' '}
                        {formatMinutesToTime(step.toTimeMin)})
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-[#14130F]">{step.description}</div>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {/* Crew Duty Status */}
          {crew && (
            <div className="border border-[#14130F] bg-[#F6F2E8] p-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="font-display font-bold text-xs uppercase tracking-wider text-[#575246]">
                  ASSIGNED CREW DUTY
                </span>
                <span
                  className={`px-1.5 py-0.5 border font-mono text-[10px] font-bold tabular-nums ${
                    crew.breached
                      ? 'border-[#C8341C] bg-[#C8341C] text-[#F6F2E8]'
                      : 'border-[#2F6B4F] text-[#2F6B4F]'
                  }`}
                >
                  {crew.crew_id} · {crew.breached ? `BREACHED +${crew.overageMin}M` : `MARGIN ${crew.marginMin}M`}
                </span>
              </div>
              <div className="font-mono text-[11px] text-[#14130F] tabular-nums space-y-1">
                <div>
                  Base {crew.base} · Duty Start {crew.duty_start} · Max {crew.max_duty_mins}m · Actual{' '}
                  {crew.dutyMins}m (last operated: {crew.lastOperatedFlightId ?? 'None'})
                </div>
                {crew.modelingAssumptionNote && (
                  <div className="p-1.5 border border-[#1D4E89] bg-[#EDE7D8] text-[#1D4E89] text-[10px]">
                    {crew.modelingAssumptionNote}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Connections */}
          <div className="border border-[#14130F] bg-[#F6F2E8] p-3">
            <div className="font-display font-bold text-xs uppercase tracking-wider text-[#575246] mb-2">
              PASSENGER CONNECTIONS ({incomingConnections.length + outgoingConnections.length})
            </div>
            {incomingConnections.length === 0 && outgoingConnections.length === 0 ? (
              <div className="font-mono text-xs text-[#575246]">
                No tracked hub connections on this flight.
              </div>
            ) : (
              <div className="space-y-1.5 font-mono text-[11px] tabular-nums">
                {[...incomingConnections, ...outgoingConnections].map((conn) => {
                  const otherId =
                    conn.from_flight === flight.flight_id ? conn.to_flight : conn.from_flight;
                  const dir = conn.from_flight === flight.flight_id ? 'OUT →' : 'IN ←';
                  return (
                    <div
                      key={conn.connection_id}
                      className="border border-[#C8BFA8] bg-[#EDE7D8] px-2 py-1.5 flex items-center justify-between gap-2"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold">{conn.connection_id}</span>
                        <span className="text-[#575246]">
                          @{conn.airport} {dir}
                        </span>
                        <FlightChipButton id={otherId} onSelect={onSelectFlight} />
                        <span className="text-[#575246]">({conn.passengers}p)</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span>
                          {conn.connectMinutes !== null
                            ? `${conn.connectMinutes}m / ${conn.min_connect_minutes}m`
                            : 'N/A'}
                        </span>
                        <span
                          className={`px-1 border text-[10px] font-bold ${
                            conn.status === 'MADE'
                              ? 'border-[#2F6B4F] text-[#2F6B4F]'
                              : 'border-[#C8341C] bg-[#C8341C] text-[#F6F2E8]'
                          }`}
                        >
                          {conn.held ? 'HELD · ' : ''}
                          {conn.status}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Tail Chain Sequence */}
          <div className="border border-[#14130F] bg-[#F6F2E8] p-3">
            <div className="font-display font-bold text-xs uppercase tracking-wider text-[#575246] mb-2">
              AIRCRAFT ROTATION CHAIN ({flight.tail_id})
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {tailChain.map((leg, i) => (
                <React.Fragment key={leg.flight_id}>
                  <FlightChipButton
                    id={leg.flight_id}
                    onSelect={onSelectFlight}
                    variant={
                      leg.cancelled || leg.crewBreach
                        ? 'breach'
                        : leg.delayMin > 0
                          ? 'delayed'
                          : 'ontime'
                    }
                    title={`${leg.origin}->${leg.destination} (${leg.actualDep}-${leg.actualArr})`}
                  />
                  {i < tailChain.length - 1 && (
                    <span className="font-mono text-[10px] text-[#575246]">→</span>
                  )}
                </React.Fragment>
              ))}
            </div>
            {(previousTailLeg || nextTailLeg) && (
              <div className="mt-2 font-mono text-[10px] text-[#575246]">
                Active assigned links:{' '}
                {previousTailLeg ? `Prev ${previousTailLeg.flight_id} (arr ${previousTailLeg.actualArr})` : 'Start of rotation'}
                {' · '}
                {nextTailLeg ? `Next ${nextTailLeg.flight_id} (dep ${nextTailLeg.actualDep})` : 'End of rotation'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
