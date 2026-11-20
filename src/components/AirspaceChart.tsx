import React, { useMemo, useState } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import {
  formatMinutesToTime,
  parseTimeToMinutes,
  type Airport,
  type ClosureSpec,
  type SimulatedFlight,
  type SimulationResult,
} from '../engine/index.js';

interface AirspaceChartProps {
  airports: Airport[];
  simulation: SimulationResult;
  previewSimulation?: SimulationResult | null;
  closure: ClosureSpec;
  playbackMin: number;
  onChangePlaybackMin: (nextMin: number) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  playbackSpeed: 1 | 2 | 5;
  onChangeSpeed: (speed: 1 | 2 | 5) => void;
  selectedFlightId: string | null;
  onSelectFlight: (flightId: string) => void;
}

export const PLAYBACK_MIN = 360; // 06:00
export const PLAYBACK_MAX = 1410; // 23:30

const SVG_W = 760;
const SVG_H = 540;
const PAD_L = 54;
const PAD_R = 44;
const PAD_T = 36;
const PAD_B = 42;

const MIN_LNG = 70.5;
const MAX_LNG = 93.5;
const MIN_LAT = 7.0;
const MAX_LAT = 32.0;
const COS_MID_LAT = Math.cos((19.5 * Math.PI) / 180);

const LAT_TICKS = [10, 15, 20, 25, 30];
const LNG_TICKS = [72, 76, 80, 84, 88, 92];

const LABEL_OFFSETS: Record<string, { dx: number; dy: number; anchor: 'start' | 'end' | 'middle' }> = {
  IXC: { dx: 10, dy: -4, anchor: 'start' },
  DEL: { dx: -11, dy: 4, anchor: 'end' },
  JAI: { dx: -10, dy: 12, anchor: 'end' },
  LKO: { dx: 10, dy: 4, anchor: 'start' },
  GAU: { dx: -10, dy: -8, anchor: 'end' },
  AMD: { dx: -11, dy: 4, anchor: 'end' },
  CCU: { dx: 11, dy: 4, anchor: 'start' },
  BBI: { dx: 10, dy: 10, anchor: 'start' },
  BOM: { dx: -11, dy: -2, anchor: 'end' },
  PNQ: { dx: 10, dy: 12, anchor: 'start' },
  HYD: { dx: 11, dy: -4, anchor: 'start' },
  GOI: { dx: -10, dy: 4, anchor: 'end' },
  BLR: { dx: -11, dy: 4, anchor: 'end' },
  MAA: { dx: 11, dy: 4, anchor: 'start' },
  COK: { dx: -10, dy: 4, anchor: 'end' },
  TRV: { dx: 10, dy: 6, anchor: 'start' },
};

function projectPoint(lat: number, lng: number): { x: number; y: number } {
  const usableW = SVG_W - PAD_L - PAD_R;
  const usableH = SVG_H - PAD_T - PAD_B;
  const rawXSpan = (MAX_LNG - MIN_LNG) * COS_MID_LAT;
  const rawYSpan = MAX_LAT - MIN_LAT;
  const scale = Math.min(usableW / rawXSpan, usableH / rawYSpan);

  const mapW = rawXSpan * scale;
  const mapH = rawYSpan * scale;
  const offsetX = PAD_L + (usableW - mapW) / 2;
  const offsetY = PAD_T + (usableH - mapH) / 2;

  const x = offsetX + (lng - MIN_LNG) * COS_MID_LAT * scale;
  const y = offsetY + (MAX_LAT - lat) * scale;
  return { x, y };
}

function getStatusColor(flight: SimulatedFlight): string {
  if (flight.cancelled || flight.crewBreach) return '#C8341C';
  if (flight.spareTailId || flight.holdDelayMin > 0) return '#1D4E89';
  if (flight.delayMin > 0) return '#C98A0B';
  return '#2F6B4F';
}

export const AirspaceChart: React.FC<AirspaceChartProps> = ({
  airports,
  simulation,
  previewSimulation = null,
  closure,
  playbackMin,
  onChangePlaybackMin,
  isPlaying,
  onTogglePlay,
  playbackSpeed,
  onChangeSpeed,
  selectedFlightId,
  onSelectFlight,
}) => {
  const [hoveredFlightId, setHoveredFlightId] = useState<string | null>(null);

  const airportCoords = useMemo(() => {
    const map = new Map<string, { airport: Airport; x: number; y: number }>();
    for (const apt of airports) {
      const pt = projectPoint(apt.lat, apt.lng);
      map.set(apt.id, { airport: apt, x: pt.x, y: pt.y });
    }
    return map;
  }, [airports]);

  const airportDelayStats = useMemo(() => {
    const stats = new Map<string, { delayedOps: number; maxDelay: number; breachedOps: number }>();
    for (const f of simulation.flights) {
      if (f.cancelled) continue;
      for (const code of [f.origin, f.destination]) {
        const cur = stats.get(code) ?? { delayedOps: 0, maxDelay: 0, breachedOps: 0 };
        if (f.delayMin > 0) cur.delayedOps += 1;
        cur.maxDelay = Math.max(cur.maxDelay, f.delayMin);
        if (f.crewBreach) cur.breachedOps += 1;
        stats.set(code, cur);
      }
    }
    return stats;
  }, [simulation.flights]);

  const sectorRoutes = useMemo(() => {
    const previewMap = previewSimulation
      ? new Map(previewSimulation.flights.map((f) => [f.flight_id, f]))
      : null;

    const grouped = new Map<
      string,
      {
        key: string;
        from: string;
        to: string;
        maxDelay: number;
        hasBreach: boolean;
        hasRecovery: boolean;
        hasCancelled: boolean;
        hasPreviewDiff: boolean;
        count: number;
      }
    >();

    for (const f of simulation.flights) {
      const pair = [f.origin, f.destination].sort();
      const key = `${pair[0]}-${pair[1]}`;
      const existing = grouped.get(key) ?? {
        key,
        from: pair[0],
        to: pair[1],
        maxDelay: 0,
        hasBreach: false,
        hasRecovery: false,
        hasCancelled: false,
        hasPreviewDiff: false,
        count: 0,
      };
      existing.count += 1;
      existing.maxDelay = Math.max(existing.maxDelay, f.delayMin);
      if (f.crewBreach) existing.hasBreach = true;
      if (f.spareTailId || f.holdDelayMin > 0) existing.hasRecovery = true;
      if (f.cancelled) existing.hasCancelled = true;

      const prevF = previewMap?.get(f.flight_id);
      if (
        prevF &&
        (prevF.delayMin !== f.delayMin ||
          prevF.cancelled !== f.cancelled ||
          prevF.crewBreach !== f.crewBreach ||
          prevF.spareTailId !== f.spareTailId)
      ) {
        existing.hasPreviewDiff = true;
      }
      grouped.set(key, existing);
    }

    return Array.from(grouped.values());
  }, [simulation.flights, previewSimulation]);

  const airborneFlights = useMemo(() => {
    return simulation.flights
      .filter(
        (f) =>
          !f.cancelled &&
          playbackMin >= f.actualDepMin &&
          playbackMin <= f.actualArrMin &&
          f.block_minutes > 0,
      )
      .map((f) => {
        const fromPt = airportCoords.get(f.origin);
        const toPt = airportCoords.get(f.destination);
        if (!fromPt || !toPt) return null;
        const progress = Math.max(
          0,
          Math.min(1, (playbackMin - f.actualDepMin) / f.block_minutes),
        );
        const x = fromPt.x + (toPt.x - fromPt.x) * progress;
        const y = fromPt.y + (toPt.y - fromPt.y) * progress;
        const angleDeg = (Math.atan2(toPt.y - fromPt.y, toPt.x - fromPt.x) * 180) / Math.PI;
        return {
          flight: f,
          x,
          y,
          angleDeg,
          color: getStatusColor(f),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }, [simulation.flights, airportCoords, playbackMin]);

  const closureActiveNow = useMemo(() => {
    if (!closure) return false;
    const s = parseTimeToMinutes(closure.start);
    const e = parseTimeToMinutes(closure.end);
    return playbackMin >= s && playbackMin < e;
  }, [closure, playbackMin]);

  return (
    <div className="border border-[#14130F] bg-[#F6F2E8] rounded-[2px] flex flex-col">
      {/* Header */}
      <div className="border-b border-[#14130F] bg-[#EDE7D8] px-3 py-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-display font-bold text-base tracking-wide uppercase text-[#14130F]">
            SCHEMATIC INK AIRSPACE CHART
          </h2>
          <div className="font-mono text-[10px] text-[#575246]">
            LAT/LNG AVIATION GRATICULE · NO GEOGRAPHIC DISTORTION · CLICK AIRCRAFT PIP TO TRACE
          </div>
        </div>

        {/* Tier Legend */}
        <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] text-[#575246]">
          <span className="inline-flex items-center gap-1">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="7" cy="7" r="5.5" fill="none" stroke="#14130F" strokeWidth="1.2" />
              <circle cx="7" cy="7" r="2.5" fill="#14130F" />
            </svg>
            MEGA HUB
          </span>
          <span className="inline-flex items-center gap-1">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" fill="#F6F2E8" stroke="#14130F" strokeWidth="1.5" />
            </svg>
            REGIONAL
          </span>
          <span className="inline-flex items-center gap-1">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <polygon points="7,2 12,11 2,11" fill="#F6F2E8" stroke="#14130F" strokeWidth="1.4" />
            </svg>
            SPOKE
          </span>
        </div>
      </div>

      {/* Graticule SVG Map */}
      <div className="relative bg-[#F6F2E8] border-b border-[#14130F] overflow-hidden">
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          className="w-full h-auto block select-none"
          role="img"
          aria-label="Domino Sky Schematic Airspace Graticule"
        >
          <defs>
            <pattern
              id="notamHatchPattern"
              width="8"
              height="8"
              patternTransform="rotate(45 0 0)"
              patternUnits="userSpaceOnUse"
            >
              <line x1="0" y1="0" x2="0" y2="8" stroke="#C8341C" strokeWidth="1.5" strokeOpacity="0.45" />
            </pattern>
          </defs>

          {/* Outer Aviation Chart Frame */}
          <rect
            x={PAD_L - 8}
            y={PAD_T - 8}
            width={SVG_W - PAD_L - PAD_R + 16}
            height={SVG_H - PAD_T - PAD_B + 16}
            fill="#EDE7D8"
            fillOpacity="0.45"
            stroke="#14130F"
            strokeWidth="1.5"
          />

          {/* Latitude Graticule Lines */}
          {LAT_TICKS.map((lat) => {
            const p1 = projectPoint(lat, MIN_LNG);
            const p2 = projectPoint(lat, MAX_LNG);
            return (
              <g key={`lat-${lat}`}>
                <line
                  x1={PAD_L - 8}
                  y1={p1.y}
                  x2={SVG_W - PAD_R + 8}
                  y2={p2.y}
                  stroke="#C8BFA8"
                  strokeWidth="0.8"
                  strokeDasharray="3 3"
                />
                <text
                  x={PAD_L - 12}
                  y={p1.y + 3}
                  textAnchor="end"
                  fontFamily="IBM Plex Mono, monospace"
                  fontSize="9"
                  fill="#575246"
                >
                  {lat}°N
                </text>
              </g>
            );
          })}

          {/* Longitude Graticule Lines */}
          {LNG_TICKS.map((lng) => {
            const p1 = projectPoint(MAX_LAT, lng);
            const p2 = projectPoint(MIN_LAT, lng);
            return (
              <g key={`lng-${lng}`}>
                <line
                  x1={p1.x}
                  y1={PAD_T - 8}
                  x2={p2.x}
                  y2={SVG_H - PAD_B + 8}
                  stroke="#C8BFA8"
                  strokeWidth="0.8"
                  strokeDasharray="3 3"
                />
                <text
                  x={p2.x}
                  y={SVG_H - PAD_B + 22}
                  textAnchor="middle"
                  fontFamily="IBM Plex Mono, monospace"
                  fontSize="9"
                  fill="#575246"
                >
                  {lng}°E
                </text>
              </g>
            );
          })}

          {/* Compass North Tick */}
          <g transform={`translate(${SVG_W - PAD_R - 18}, ${PAD_T + 14})`}>
            <rect
              x="-16"
              y="-14"
              width="32"
              height="40"
              fill="#F6F2E8"
              stroke="#14130F"
              strokeWidth="1"
            />
            <polygon points="0,-9 4.5,4 0,1 -4.5,4" fill="#14130F" />
            <line x1="0" y1="1" x2="0" y2="12" stroke="#14130F" strokeWidth="1.2" />
            <text
              x="0"
              y="22"
              textAnchor="middle"
              fontFamily="IBM Plex Mono, monospace"
              fontSize="9"
              fontWeight="700"
              fill="#14130F"
            >
              N
            </text>
          </g>

          {/* Sector Route Ink Lines */}
          {sectorRoutes.map((route) => {
            const p1 = airportCoords.get(route.from);
            const p2 = airportCoords.get(route.to);
            if (!p1 || !p2) return null;

            let stroke = '#C8BFA8';
            let strokeWidth = 1;
            let dashArray: string | undefined;

            if (route.hasBreach) {
              stroke = '#C8341C';
              strokeWidth = 2.4;
            } else if (route.hasRecovery) {
              stroke = '#1D4E89';
              strokeWidth = 2;
            } else if (route.maxDelay > 0) {
              stroke = '#C98A0B';
              strokeWidth = route.maxDelay >= 45 ? 2.4 : 1.6;
            } else if (route.hasCancelled) {
              stroke = '#C8341C';
              strokeWidth = 1.6;
              dashArray = '4 3';
            }

            return (
              <g key={route.key}>
                {route.hasPreviewDiff && (
                  <line
                    x1={p1.x}
                    y1={p1.y}
                    x2={p2.x}
                    y2={p2.y}
                    stroke="#1D4E89"
                    strokeWidth={5}
                    strokeOpacity={0.3}
                  />
                )}
                <line
                  x1={p1.x}
                  y1={p1.y}
                  x2={p2.x}
                  y2={p2.y}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  strokeDasharray={dashArray}
                  strokeOpacity={stroke === '#C8BFA8' ? 0.75 : 0.92}
                />
              </g>
            );
          })}

          {/* NOTAM Closed Airport Hatch Box */}
          {closure && (() => {
            const closedPt = airportCoords.get(closure.airport);
            if (!closedPt) return null;
            return (
              <g transform={`translate(${closedPt.x}, ${closedPt.y})`}>
                <rect
                  x="-22"
                  y="-22"
                  width="44"
                  height="44"
                  fill="url(#notamHatchPattern)"
                  stroke="#C8341C"
                  strokeWidth={closureActiveNow ? 2.2 : 1.4}
                  strokeDasharray={closureActiveNow ? undefined : '4 2'}
                />
                <rect
                  x="-54"
                  y="-38"
                  width="108"
                  height="14"
                  fill="#C8341C"
                  stroke="#14130F"
                  strokeWidth="0.8"
                />
                <text
                  x="0"
                  y="-28"
                  textAnchor="middle"
                  fontFamily="IBM Plex Mono, monospace"
                  fontSize="8.5"
                  fontWeight="700"
                  fill="#F6F2E8"
                >
                  NOTAM CLOSED {closure.start}–{closure.end}
                </text>
              </g>
            );
          })()}

          {/* Airport Glyphs & Labels */}
          {airports.map((apt) => {
            const pt = airportCoords.get(apt.id);
            if (!pt) return null;
            const isClosed = closure?.airport === apt.id;
            const stats = airportDelayStats.get(apt.id);
            const labelPos = LABEL_OFFSETS[apt.id] ?? { dx: 10, dy: 4, anchor: 'start' as const };
            const glyphStroke = isClosed
              ? '#C8341C'
              : stats && stats.breachedOps > 0
                ? '#C8341C'
                : stats && stats.delayedOps > 0
                  ? '#C98A0B'
                  : '#14130F';

            return (
              <g key={apt.id} transform={`translate(${pt.x}, ${pt.y})`}>
                {apt.tier === 'mega_hub' && (
                  <>
                    <circle
                      r="7"
                      fill="#F6F2E8"
                      stroke={glyphStroke}
                      strokeWidth="1.6"
                    />
                    <circle r="3" fill={glyphStroke} />
                  </>
                )}
                {apt.tier === 'regional_hub' && (
                  <circle
                    r="5.5"
                    fill="#F6F2E8"
                    stroke={glyphStroke}
                    strokeWidth="1.6"
                  />
                )}
                {apt.tier === 'spoke' && (
                  <polygon
                    points="0,-5.5 5,4 -5,4"
                    fill="#F6F2E8"
                    stroke={glyphStroke}
                    strokeWidth="1.5"
                  />
                )}

                <text
                  x={labelPos.dx}
                  y={labelPos.dy}
                  textAnchor={labelPos.anchor}
                  fontFamily="IBM Plex Mono, monospace"
                  fontSize="10.5"
                  fontWeight="700"
                  fill={isClosed ? '#C8341C' : '#14130F'}
                >
                  {apt.id}
                </text>
                {stats && stats.maxDelay > 0 && (
                  <text
                    x={labelPos.dx}
                    y={labelPos.dy + 10}
                    textAnchor={labelPos.anchor}
                    fontFamily="IBM Plex Mono, monospace"
                    fontSize="8.5"
                    fontWeight="600"
                    fill={stats.breachedOps > 0 ? '#C8341C' : '#8A5D00'}
                  >
                    +{stats.maxDelay}m
                  </text>
                )}
              </g>
            );
          })}

          {/* Airborne Aircraft Pips */}
          {airborneFlights.map(({ flight, x, y, angleDeg, color }) => {
            const isSelected = selectedFlightId === flight.flight_id;
            const isHovered = hoveredFlightId === flight.flight_id;
            return (
              <g
                key={flight.flight_id}
                transform={`translate(${x}, ${y})`}
                role="button"
                tabIndex={0}
                aria-label={`Inspect ${flight.flight_id} ${flight.origin} to ${flight.destination}${flight.delayMin > 0 ? `, delayed ${flight.delayMin} minutes` : ''}`}
                onClick={() => onSelectFlight(flight.flight_id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectFlight(flight.flight_id);
                  }
                }}
                onMouseEnter={() => setHoveredFlightId(flight.flight_id)}
                onMouseLeave={() => setHoveredFlightId(null)}
                style={{ cursor: 'pointer' }}
              >
                <g transform={`rotate(${angleDeg})`}>
                  <polygon
                    points="8,0 -5,4.5 -2.5,0 -5,-4.5"
                    fill={color}
                    stroke="#14130F"
                    strokeWidth={isSelected ? 1.8 : 1}
                  />
                </g>
                {(isSelected || isHovered || flight.delayMin > 0 || flight.crewBreach) && (
                  <g transform="translate(8, -8)">
                    <rect
                      x="-2"
                      y="-9"
                      width={flight.delayMin > 0 ? 74 : 46}
                      height="12"
                      fill="#F6F2E8"
                      stroke="#14130F"
                      strokeWidth="0.8"
                    />
                    <text
                      x="1"
                      y="0"
                      fontFamily="IBM Plex Mono, monospace"
                      fontSize="8.5"
                      fontWeight="700"
                      fill={color}
                    >
                      {flight.flight_id}
                      {flight.delayMin > 0 ? ` +${flight.delayMin}m` : ''}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Synchronized 06:00-23:30 IST Playback Scrubber */}
      <div className="bg-[#EDE7D8] px-3 py-2 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onTogglePlay}
            aria-label={isPlaying ? 'Pause cascade playback' : 'Play cascade playback'}
            className="inline-flex items-center gap-1 px-2.5 py-1 border border-[#14130F] bg-[#14130F] text-[#F6F2E8] font-mono text-[11px] font-semibold cursor-pointer rounded-[2px]"
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            {isPlaying ? 'PAUSE' : 'PLAY'}
          </button>

          <button
            type="button"
            onClick={() => onChangePlaybackMin(closure ? parseTimeToMinutes(closure.start) : PLAYBACK_MIN)}
            title="Reset playback clock to closure start (or 06:00)"
            aria-label="Reset playback clock"
            className="p-1 border border-[#14130F] bg-[#F6F2E8] text-[#14130F] hover:bg-[#14130F] hover:text-[#F6F2E8] cursor-pointer rounded-[2px]"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex items-center border border-[#14130F] bg-[#F6F2E8] p-0.5 rounded-[2px]">
          {([1, 2, 5] as const).map((spd) => (
            <button
              key={spd}
              type="button"
              onClick={() => onChangeSpeed(spd)}
              className={`px-1.5 py-0.5 font-mono text-[10px] font-semibold cursor-pointer ${
                playbackSpeed === spd
                  ? 'bg-[#1D4E89] text-[#F6F2E8]'
                  : 'text-[#575246] hover:text-[#14130F]'
              }`}
            >
              {spd}x
            </button>
          ))}
        </div>

        <div className="flex-1 min-w-[160px] flex items-center gap-2">
          <span className="font-mono text-[10px] text-[#575246] tabular-nums">06:00</span>
          <input
            type="range"
            aria-label="Playback time IST"
            min={PLAYBACK_MIN}
            max={PLAYBACK_MAX}
            step={1}
            value={playbackMin}
            onChange={(e) => onChangePlaybackMin(Number(e.target.value))}
            className="atc-slider flex-1"
          />
          <span className="font-mono text-[10px] text-[#575246] tabular-nums">23:30</span>
        </div>

        <div className="flex items-center gap-2 font-mono text-xs tabular-nums">
          <span className="px-2 py-0.5 border border-[#14130F] bg-[#F6F2E8] font-bold">
            {formatMinutesToTime(playbackMin)} IST
          </span>
          <span className="px-2 py-0.5 border border-[#C8BFA8] bg-[#F6F2E8] text-[11px] text-[#575246]">
            AIRBORNE: <strong className="text-[#14130F]">{airborneFlights.length}</strong>
          </span>
        </div>
      </div>
    </div>
  );
};
