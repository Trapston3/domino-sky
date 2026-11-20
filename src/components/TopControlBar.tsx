import React from 'react';
import {
  formatMinutesToTime,
  parseTimeToMinutes,
  type Airport,
  type ClosureSpec,
  type ReopeningSurgeMetrics,
} from '../engine/index.js';

export type WorkspaceViewMode = 'SPLIT' | 'CHART' | 'STRIP_BOARD' | 'AUDIT';

export interface ScenarioPreset {
  id: string;
  label: string;
  sublabel: string;
  closure: ClosureSpec;
}

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    id: 'NOMINAL',
    label: 'NOMINAL',
    sublabel: 'No Closure',
    closure: null,
  },
  {
    id: 'BOM_MORNING',
    label: 'BOM 07:30–09:00',
    sublabel: 'Morning Bank',
    closure: { airport: 'BOM', start: '07:30', end: '09:00' },
  },
  {
    id: 'DEL_MIDDAY',
    label: 'DEL 12:00–13:30',
    sublabel: 'CR03 Breach',
    closure: { airport: 'DEL', start: '12:00', end: '13:30' },
  },
  {
    id: 'BLR_AFTERNOON',
    label: 'BLR 13:00–14:30',
    sublabel: 'CR08 + CX12',
    closure: { airport: 'BLR', start: '13:00', end: '14:30' },
  },
  {
    id: 'CCU_EVENING',
    label: 'CCU 16:00–17:30',
    sublabel: 'CR10 Breach',
    closure: { airport: 'CCU', start: '16:00', end: '17:30' },
  },
];

interface TopControlBarProps {
  airports: Airport[];
  closure: ClosureSpec;
  onChangeClosure: (next: ClosureSpec) => void;
  reopeningSurge: ReopeningSurgeMetrics | null;
  viewMode: WorkspaceViewMode;
  onChangeViewMode: (mode: WorkspaceViewMode) => void;
  activeActionsCount: number;
  onResetActions: () => void;
}

const SLIDER_MIN = 360; // 06:00
const SLIDER_MAX = 1320; // 22:00
const SLIDER_STEP = 15;

export const TopControlBar: React.FC<TopControlBarProps> = ({
  airports,
  closure,
  onChangeClosure,
  reopeningSurge,
  viewMode,
  onChangeViewMode,
  activeActionsCount,
  onResetActions,
}) => {
  const selectedAirport = closure?.airport ?? 'DEL';
  const startMin = closure ? parseTimeToMinutes(closure.start) : 720;
  const endMin = closure ? parseTimeToMinutes(closure.end) : 810;

  const isPresetActive = (preset: ScenarioPreset): boolean => {
    if (preset.closure === null && closure === null) return true;
    if (preset.closure === null || closure === null) return false;
    return (
      preset.closure.airport === closure.airport &&
      preset.closure.start === closure.start &&
      preset.closure.end === closure.end
    );
  };

  const handleAirportChange = (airportId: string) => {
    if (airportId === 'NONE') {
      onChangeClosure(null);
      return;
    }
    const baseStart = closure ? closure.start : '12:00';
    const baseEnd = closure ? closure.end : '13:30';
    onChangeClosure({ airport: airportId, start: baseStart, end: baseEnd });
  };

  const handleStartSlider = (nextStart: number) => {
    const clampedStart = Math.min(nextStart, SLIDER_MAX - SLIDER_STEP);
    const nextEnd = Math.max(endMin, clampedStart + SLIDER_STEP);
    onChangeClosure({
      airport: selectedAirport,
      start: formatMinutesToTime(clampedStart),
      end: formatMinutesToTime(nextEnd),
    });
  };

  const handleEndSlider = (nextEnd: number) => {
    const clampedEnd = Math.max(nextEnd, SLIDER_MIN + SLIDER_STEP);
    const nextStart = Math.min(startMin, clampedEnd - SLIDER_STEP);
    onChangeClosure({
      airport: selectedAirport,
      start: formatMinutesToTime(nextStart),
      end: formatMinutesToTime(clampedEnd),
    });
  };

  const viewTabs: Array<{ id: WorkspaceViewMode; label: string }> = [
    { id: 'SPLIT', label: 'SPLIT' },
    { id: 'CHART', label: 'CHART' },
    { id: 'STRIP_BOARD', label: 'STRIP BOARD' },
    { id: 'AUDIT', label: 'AUDIT' },
  ];

  const surgePct = reopeningSurge?.utilizationPct ?? 0;
  const surgeColor =
    surgePct >= 80
      ? 'border-[#C8341C] text-[#C8341C] bg-[#F6F2E8]'
      : surgePct >= 45
        ? 'border-[#C98A0B] text-[#8A5D00] bg-[#F6F2E8]'
        : 'border-[#575246] text-[#14130F] bg-[#F6F2E8]';

  return (
    <header className="border-b-2 border-[#14130F] bg-[#F6F2E8] px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Brand Masthead */}
        <div className="flex items-center gap-3">
          <div className="border border-[#14130F] bg-[#14130F] text-[#F6F2E8] px-2 py-1 font-display font-bold text-lg tracking-wider leading-none uppercase">
            DOMINO SKY
          </div>
          <div className="leading-tight">
            <div className="font-display font-bold text-sm tracking-wide uppercase text-[#14130F]">
              ATC DISRUPTION CASCADE &amp; RECOVERY BOARD
            </div>
            <div className="font-mono text-[10px] text-[#575246] tabular-nums">
              16 AIRPORTS · 70 LEGS · 21 CONNECTIONS · IST (UTC+05:30)
            </div>
          </div>
        </div>

        {/* Presets */}
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Scenario presets">
          <span className="font-mono text-[10px] uppercase tracking-wider text-[#575246] mr-1">
            PRESETS:
          </span>
          {SCENARIO_PRESETS.map((preset) => {
            const active = isPresetActive(preset);
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => onChangeClosure(preset.closure)}
                className={`px-2 py-1 border font-mono text-[11px] font-semibold tabular-nums rounded-[2px] cursor-pointer transition-colors ${
                  active
                    ? 'border-[#14130F] bg-[#14130F] text-[#F6F2E8]'
                    : 'border-[#C8BFA8] bg-[#EDE7D8] text-[#14130F] hover:border-[#14130F]'
                }`}
                title={preset.sublabel}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        {/* View Switcher */}
        <div className="flex items-center gap-1 border border-[#14130F] bg-[#EDE7D8] p-0.5 rounded-[2px]">
          {viewTabs.map((tab) => {
            const active = viewMode === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onChangeViewMode(tab.id)}
                className={`px-2.5 py-1 font-mono text-[11px] font-semibold tracking-wide rounded-[1px] cursor-pointer transition-colors ${
                  active
                    ? 'bg-[#14130F] text-[#F6F2E8]'
                    : 'text-[#575246] hover:text-[#14130F]'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Closure Controls & Reopening Surge Row */}
      <div className="mt-2 pt-2 border-t border-[#C8BFA8] flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 font-mono text-xs">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#575246]">
              CLOSED STATION
            </span>
            <select
              aria-label="Closed station airport"
              value={closure ? closure.airport : 'NONE'}
              onChange={(e) => handleAirportChange(e.target.value)}
              className="border border-[#14130F] bg-[#EDE7D8] px-2 py-1 font-mono text-xs font-semibold text-[#14130F] rounded-[2px]"
            >
              <option value="NONE">NONE (NOMINAL DAY)</option>
              {airports.map((apt) => (
                <option key={apt.id} value={apt.id}>
                  {apt.id} — {apt.city} ({apt.tier.replace('_', ' ').toUpperCase()})
                </option>
              ))}
            </select>
          </label>

          {/* Closure Start & End Sliders */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 font-mono text-xs">
              <span className="text-[10px] uppercase tracking-wider text-[#575246]">START</span>
              <input
                type="range"
                aria-label="Closure start time"
                min={SLIDER_MIN}
                max={SLIDER_MAX - SLIDER_STEP}
                step={SLIDER_STEP}
                value={startMin}
                onChange={(e) => handleStartSlider(Number(e.target.value))}
                className="atc-slider w-28"
              />
              <span className="w-12 text-right font-semibold tabular-nums">
                {closure ? closure.start : '--:--'}
              </span>
            </label>

            <label className="flex items-center gap-2 font-mono text-xs">
              <span className="text-[10px] uppercase tracking-wider text-[#575246]">END</span>
              <input
                type="range"
                aria-label="Closure end time"
                min={SLIDER_MIN + SLIDER_STEP}
                max={SLIDER_MAX}
                step={SLIDER_STEP}
                value={endMin}
                onChange={(e) => handleEndSlider(Number(e.target.value))}
                className="atc-slider w-28"
              />
              <span className="w-12 text-right font-semibold tabular-nums">
                {closure ? closure.end : '--:--'}
              </span>
            </label>

            {closure && (
              <span className="px-1.5 py-0.5 border border-[#C8341C] bg-[#F6F2E8] font-mono text-[10px] font-semibold text-[#C8341C] tabular-nums">
                NOTAM {closure.airport} {closure.start}–{closure.end} ({endMin - startMin}M)
              </span>
            )}
          </div>
        </div>

        {/* Right: Reopening Surge Badge + Active Action Reset */}
        <div className="flex flex-wrap items-center gap-2">
          {reopeningSurge && (
            <div
              className={`px-2 py-1 border font-mono text-[11px] tabular-nums rounded-[2px] ${surgeColor}`}
              title="Informational reopening surge utilization in the first 60 minutes after reopening (does not alter delay propagation)."
            >
              <span className="font-semibold">REOPEN SURGE</span>{' '}
              <span>
                [{reopeningSurge.windowStart}–{reopeningSurge.windowEnd}]
              </span>
              :{' '}
              <span className="font-bold">
                {reopeningSurge.operationsCount}/{reopeningSurge.capacityPerHour} OPS (
                {reopeningSurge.utilizationPct}%)
              </span>{' '}
              <span className="text-[10px] text-[#575246]">
                ({reopeningSurge.departuresCount}D/{reopeningSurge.arrivalsCount}A)
              </span>
            </div>
          )}

          {activeActionsCount > 0 && (
            <button
              type="button"
              onClick={onResetActions}
              className="px-2.5 py-1 border border-[#1D4E89] bg-[#1D4E89] text-[#F6F2E8] font-mono text-[11px] font-semibold rounded-[2px] cursor-pointer hover:bg-[#14130F] hover:border-[#14130F]"
            >
              RESET {activeActionsCount} ACTION{activeActionsCount > 1 ? 'S' : ''}
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
