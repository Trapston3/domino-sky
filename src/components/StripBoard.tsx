import React, { useMemo, useState } from 'react';
import {
  formatMinutesToTime,
  parseTimeToMinutes,
  type ClosureSpec,
  type SimulatedCrew,
  type SimulatedFlight,
  type SimulationResult,
} from '../engine/index.js';

interface StripBoardProps {
  simulation: SimulationResult;
  previewSimulation?: SimulationResult | null;
  closure: ClosureSpec;
  selectedFlightId: string | null;
  onSelectFlight: (flightId: string) => void;
  playbackMin?: number | null;
}

const TIMELINE_START_MIN = 345; // 05:45
const TIMELINE_END_MIN = 1470; // 00:30 (+1)

const HOUR_TICKS = [360, 480, 600, 720, 840, 960, 1080, 1200, 1320, 1440];

function pctOnTrack(min: number): number {
  const clamped = Math.max(TIMELINE_START_MIN, Math.min(TIMELINE_END_MIN, min));
  return ((clamped - TIMELINE_START_MIN) / (TIMELINE_END_MIN - TIMELINE_START_MIN)) * 100;
}

function getBarColors(flight: SimulatedFlight): string {
  if (flight.cancelled) {
    return 'cancelled-hatch border border-dashed border-[#C8341C] text-[#C8341C]';
  }
  if (flight.crewBreach) {
    return 'bg-[#C8341C] border border-[#14130F] text-[#F6F2E8]';
  }
  if (flight.isSpareTakeover || flight.spareTailId) {
    if (flight.delayMin > 0) {
      return 'bg-[#1D4E89] border border-[#14130F] text-[#F6F2E8]';
    }
    return 'bg-[#1D4E89] border border-[#14130F] text-[#F6F2E8]';
  }
  if (flight.holdDelayMin > 0) {
    return 'bg-[#1D4E89] border border-[#14130F] text-[#F6F2E8]';
  }
  if (flight.delayMin > 0) {
    return 'bg-[#C98A0B] border border-[#14130F] text-[#14130F]';
  }
  return 'bg-[#2F6B4F] border border-[#14130F] text-[#F6F2E8]';
}

export const StripBoard: React.FC<StripBoardProps> = ({
  simulation,
  previewSimulation = null,
  closure,
  selectedFlightId,
  onSelectFlight,
  playbackMin = null,
}) => {
  const [filterMode, setFilterMode] = useState<'ALL' | 'IMPACTED'>('ALL');

  const tailRows = useMemo(() => {
    const byTail = new Map<string, SimulatedFlight[]>();
    for (const f of simulation.flights) {
      const list = byTail.get(f.tail_id) ?? [];
      list.push(f);
      byTail.set(f.tail_id, list);
    }

    const previewFlightMap = previewSimulation
      ? new Map(previewSimulation.flights.map((f) => [f.flight_id, f]))
      : null;

    const crewByTail = new Map<string, SimulatedCrew>();
    const standbyByTail = new Map<string, SimulatedCrew>();
    for (const crew of simulation.crews) {
      if (crew.isStandby) {
        standbyByTail.set(crew.tail_id, crew);
      } else {
        crewByTail.set(crew.tail_id, crew);
      }
    }

    const rows = Array.from(byTail.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tailId, legs]) => {
        const sortedLegs = [...legs].sort((a, b) => a.leg_order - b.leg_order);
        const origCrew = crewByTail.get(tailId) ?? null;
        const activeSpareId = sortedLegs.find((l) => l.spareTailId)?.spareTailId ?? null;
        const standbyCrew = activeSpareId ? standbyByTail.get(activeSpareId) ?? null : null;
        const isImpacted = sortedLegs.some(
          (l) =>
            l.delayMin > 0 ||
            l.cancelled ||
            l.crewBreach ||
            l.spareTailId !== null ||
            l.holdDelayMin > 0,
        );
        return {
          tailId,
          legs: sortedLegs,
          origCrew,
          standbyCrew,
          isImpacted,
          previewFlightMap,
        };
      });

    if (filterMode === 'IMPACTED') {
      const filtered = rows.filter((r) => r.isImpacted);
      return filtered.length > 0 ? filtered : rows;
    }
    return rows;
  }, [simulation, previewSimulation, filterMode]);

  const closureWindow = useMemo(() => {
    if (!closure) return null;
    const start = parseTimeToMinutes(closure.start);
    const end = parseTimeToMinutes(closure.end);
    const left = pctOnTrack(start);
    const width = Math.max(0.5, pctOnTrack(end) - left);
    return { airport: closure.airport, start: closure.start, end: closure.end, left, width };
  }, [closure]);

  return (
    <div className="border border-[#14130F] bg-[#F6F2E8] rounded-[2px] flex flex-col min-w-0">
      {/* Strip Board Header */}
      <div className="border-b border-[#14130F] bg-[#EDE7D8] px-3 py-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h2 className="font-display font-bold text-base tracking-wide uppercase text-[#14130F]">
            FLIGHT-PROGRESS STRIP BOARD
          </h2>
          <div className="flex items-center border border-[#14130F] bg-[#F6F2E8] p-0.5 rounded-[2px]">
            {(['ALL', 'IMPACTED'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setFilterMode(mode)}
                className={`px-2 py-0.5 font-mono text-[10px] font-semibold cursor-pointer ${
                  filterMode === mode
                    ? 'bg-[#14130F] text-[#F6F2E8]'
                    : 'text-[#575246] hover:text-[#14130F]'
                }`}
              >
                {mode === 'ALL' ? 'ALL 16 TAILS' : 'IMPACTED ONLY'}
              </button>
            ))}
          </div>
        </div>

        {/* Ink Legend */}
        <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] text-[#575246]">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-3 h-2.5 border border-dashed border-[#575246]" />
            SCHED GHOST
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-3 h-2.5 bg-[#2F6B4F] border border-[#14130F]" />
            ON-TIME
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-3 h-2.5 bg-[#C98A0B] border border-[#14130F]" />
            DELAYED
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-3 h-2.5 bg-[#C8341C] border border-[#14130F]" />
            CREW BREACH
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-3 h-2.5 bg-[#1D4E89] border border-[#14130F]" />
            SPARE / HOLD
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-3 h-2.5 cancelled-hatch border border-dashed border-[#C8341C]" />
            CANCELLED
          </span>
        </div>
      </div>

      {/* Scrollable Strip Rack */}
      <div className="overflow-x-auto">
        <div className="min-w-[820px]">
          {/* Shared Timeline Axis Header */}
          <div className="grid grid-cols-[190px_1fr] border-b border-[#14130F] bg-[#EDE7D8]">
            <div className="px-2.5 py-1 border-r border-[#14130F] font-mono text-[10px] font-semibold uppercase tracking-wider text-[#575246]">
              TAIL / CREW DUTY
            </div>
            <div className="relative h-6 font-mono text-[10px] text-[#575246] tabular-nums">
              {HOUR_TICKS.map((tick) => {
                const left = pctOnTrack(tick);
                return (
                  <div
                    key={tick}
                    style={{ left: `${left}%` }}
                    className="absolute top-0 bottom-0 border-l border-[#C8BFA8] pl-1 flex items-center"
                  >
                    {formatMinutesToTime(tick)}
                  </div>
                );
              })}
              {closureWindow && (
                <div
                  style={{ left: `${closureWindow.left}%`, width: `${closureWindow.width}%` }}
                  className="absolute top-0 bottom-0 bg-[#C8341C]/15 border-x border-[#C8341C] flex items-center justify-center font-mono text-[9px] font-bold text-[#C8341C] overflow-hidden"
                >
                  {closureWindow.airport} CLOSED
                </div>
              )}
            </div>
          </div>

          {/* 16 Tail Strips */}
          <div className="divide-y divide-[#C8BFA8]">
            {tailRows.map((row) => {
              const crewToDisplay = row.origCrew;
              const isBreached = Boolean(crewToDisplay?.breached || row.standbyCrew?.breached);
              return (
                <div
                  key={row.tailId}
                  className={`grid grid-cols-[190px_1fr] min-h-[54px] ${
                    isBreached ? 'bg-[#C8341C]/[0.04]' : 'bg-[#F6F2E8]'
                  }`}
                >
                  {/* Left Perforated Stub */}
                  <div className="border-r border-[#14130F] flex">
                    <div className="w-3 shrink-0 strip-perforation border-r border-[#C8BFA8]" />
                    <div className="px-2 py-1.5 flex-1 min-w-0 flex flex-col justify-between">
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-display font-bold text-sm tracking-wide text-[#14130F]">
                          {row.tailId}
                        </span>
                        {crewToDisplay && (
                          <span
                            className={`px-1 py-0.5 font-mono text-[9px] font-bold border tabular-nums ${
                              crewToDisplay.breached
                                ? 'border-[#C8341C] bg-[#C8341C] text-[#F6F2E8]'
                                : 'border-[#C8BFA8] bg-[#EDE7D8] text-[#14130F]'
                            }`}
                          >
                            {crewToDisplay.crew_id}{' '}
                            {crewToDisplay.breached
                              ? `+${crewToDisplay.overageMin}M`
                              : `${crewToDisplay.dutyMins}/${crewToDisplay.max_duty_mins}`}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-1 mt-1">
                        {row.standbyCrew ? (
                          <span className="px-1 py-0.5 border border-[#1D4E89] bg-[#1D4E89] text-[#F6F2E8] font-mono text-[9px] font-semibold tabular-nums truncate">
                            {row.standbyCrew.crew_id} ({row.standbyCrew.dutyMins}m)
                          </span>
                        ) : (
                          <span className="font-mono text-[9px] text-[#575246] tabular-nums">
                            {row.legs[0]?.origin} → {row.legs[row.legs.length - 1]?.destination} (
                            {row.legs.length}L)
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right Timeline Track */}
                  <div className="relative py-1.5">
                    {/* Vertical Hour Gridlines */}
                    {HOUR_TICKS.map((tick) => (
                      <div
                        key={tick}
                        style={{ left: `${pctOnTrack(tick)}%` }}
                        className="absolute top-0 bottom-0 border-l border-[#C8BFA8]/50 pointer-events-none"
                      />
                    ))}

                    {/* Closure Hatch Band */}
                    {closureWindow && (
                      <div
                        style={{
                          left: `${closureWindow.left}%`,
                          width: `${closureWindow.width}%`,
                        }}
                        className="absolute top-0 bottom-0 notam-hatch border-x border-[#C8341C]/50 pointer-events-none"
                      />
                    )}

                    {/* Playback Scrubber Line */}
                    {playbackMin !== null && (
                      <div
                        style={{ left: `${pctOnTrack(playbackMin)}%` }}
                        className="absolute top-0 bottom-0 w-0.5 bg-[#1D4E89] z-20 pointer-events-none"
                      />
                    )}

                    {/* Flight Bars */}
                    <div className="relative h-10 w-full">
                      {row.legs.map((leg) => {
                        const schedLeft = pctOnTrack(leg.scheduledDepMin);
                        const schedRight = pctOnTrack(leg.scheduledArrMin);
                        const schedWidth = Math.max(1.5, schedRight - schedLeft);

                        const actualLeft = pctOnTrack(leg.actualDepMin);
                        const actualRight = pctOnTrack(leg.actualArrMin);
                        const actualWidth = Math.max(2, actualRight - actualLeft);

                        const shifted = leg.actualDepMin !== leg.scheduledDepMin || leg.cancelled;
                        const isSelected = selectedFlightId === leg.flight_id;

                        const previewLeg = row.previewFlightMap?.get(leg.flight_id);
                        const hasPreviewDiff =
                          previewLeg &&
                          (previewLeg.actualDepMin !== leg.actualDepMin ||
                            previewLeg.cancelled !== leg.cancelled ||
                            previewLeg.spareTailId !== leg.spareTailId);

                        return (
                          <React.Fragment key={leg.flight_id}>
                            {/* Scheduled Ghost Outline */}
                            {shifted && (
                              <div
                                style={{ left: `${schedLeft}%`, width: `${schedWidth}%` }}
                                className="absolute top-1.5 h-7 border border-dashed border-[#575246]/65 bg-transparent pointer-events-none"
                                title={`Scheduled: ${leg.flight_id} ${leg.dep}–${leg.arr}`}
                              />
                            )}

                            {/* Hover Preview Diff Ghost */}
                            {hasPreviewDiff && previewLeg && (
                              <div
                                style={{
                                  left: `${pctOnTrack(previewLeg.actualDepMin)}%`,
                                  width: `${Math.max(
                                    2,
                                    pctOnTrack(previewLeg.actualArrMin) -
                                      pctOnTrack(previewLeg.actualDepMin),
                                  )}%`,
                                }}
                                className={`absolute top-0.5 h-9 border-2 pointer-events-none z-10 ${
                                  previewLeg.cancelled
                                    ? 'border-dashed border-[#C8341C] bg-[#C8341C]/10'
                                    : 'border-[#1D4E89] bg-[#1D4E89]/15'
                                }`}
                              />
                            )}

                            {/* Actual Flight Bar */}
                            <button
                              type="button"
                              onClick={() => onSelectFlight(leg.flight_id)}
                              style={{ left: `${actualLeft}%`, width: `${actualWidth}%` }}
                              title={`${leg.flight_id} (${leg.origin}→${leg.destination}) | Sched ${leg.dep}–${leg.arr} | Actual ${leg.actualDep}–${leg.actualArr} | Delay +${leg.delayMin}m${
                                leg.spareTailId ? ` | Spare ${leg.spareTailId}` : ''
                              }${leg.crewBreach ? ' | CREW BREACH' : ''}${
                                leg.cancelled ? ' | CANCELLED' : ''
                              }`}
                              className={`absolute top-1.5 h-7 px-1 flex flex-col justify-center items-start overflow-hidden text-left rounded-[1px] cursor-pointer transition-transform ${getBarColors(
                                leg,
                              )} ${
                                isSelected
                                  ? 'ring-2 ring-[#14130F] ring-offset-1 ring-offset-[#F6F2E8] z-10'
                                  : 'hover:z-10'
                              }`}
                            >
                              <div className="flex items-center justify-between w-full gap-1 leading-none">
                                <span className="font-mono text-[10px] font-bold tracking-tight truncate tabular-nums">
                                  {leg.flight_id}
                                </span>
                                {!leg.cancelled && leg.delayMin > 0 && (
                                  <span className="font-mono text-[9px] font-bold tabular-nums shrink-0">
                                    +{leg.delayMin}
                                  </span>
                                )}
                                {leg.cancelled && (
                                  <span className="font-mono text-[9px] font-bold shrink-0">
                                    CXL
                                  </span>
                                )}
                              </div>
                              <div className="font-mono text-[9px] leading-none opacity-90 truncate w-full tabular-nums">
                                {leg.origin}-{leg.destination}
                                {leg.isSpareTakeover && leg.spareTailId ? ` · ${leg.spareTailId}` : ''}
                              </div>
                            </button>
                          </React.Fragment>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
