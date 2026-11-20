import React from 'react';
import type { SimulationResult } from '../engine/index.js';

interface KpiStripProps {
  baseline: SimulationResult;
  current: SimulationResult;
  preview?: SimulationResult | null;
  previewLabel?: string | null;
}

function formatDiff(diff: number, unit = ''): string {
  if (diff === 0) return `0${unit}`;
  const sign = diff > 0 ? '+' : '';
  return `${sign}${diff}${unit}`;
}

export const KpiStrip: React.FC<KpiStripProps> = ({
  baseline,
  current,
  preview = null,
  previewLabel = null,
}) => {
  const b = baseline.metrics;
  const c = current.metrics;
  const p = preview?.metrics ?? null;

  const hasRecoveryApplied = current.actions.length > 0;
  const showStandbyBanner =
    current.standbyAssumptionsUsed || Boolean(preview?.standbyAssumptionsUsed);

  const cards = [
    {
      label: 'DELAYED FLIGHTS',
      base: b.delayedFlightsCount,
      cur: c.delayedFlightsCount,
      prev: p?.delayedFlightsCount ?? null,
      unit: '',
      sub: `${c.operatedFlights} operated · ${c.cancelledFlightsCount} cancelled`,
      accent: c.delayedFlightsCount > 0 ? 'text-[#C98A0B]' : 'text-[#2F6B4F]',
    },
    {
      label: 'TOTAL DELAY',
      base: b.totalDelayMinutes,
      cur: c.totalDelayMinutes,
      prev: p?.totalDelayMinutes ?? null,
      unit: 'm',
      sub: `Max single leg: ${c.maxFlightDelayMinutes}m`,
      accent: c.totalDelayMinutes > 0 ? 'text-[#C98A0B]' : 'text-[#2F6B4F]',
    },
    {
      label: 'BROKEN CONNS',
      base: b.brokenConnectionsCount,
      cur: c.brokenConnectionsCount,
      prev: p?.brokenConnectionsCount ?? null,
      unit: '',
      sub: `${c.madeConnectionsCount}/${c.totalConnections} made · ${c.missedConnectionPax} pax missed`,
      accent: c.brokenConnectionsCount > 0 ? 'text-[#C8341C]' : 'text-[#2F6B4F]',
    },
    {
      label: 'CREW DUTY BREACHES',
      base: b.crewBreachesCount,
      cur: c.crewBreachesCount,
      prev: p?.crewBreachesCount ?? null,
      unit: '',
      sub:
        c.crewBreachesCount > 0
          ? `${current.crews
              .filter((cr) => cr.breached)
              .map((cr) => `${cr.crew_id} +${cr.overageMin}m`)
              .join(', ')}`
          : 'All crews within 600m limit',
      accent: c.crewBreachesCount > 0 ? 'text-[#C8341C]' : 'text-[#2F6B4F]',
    },
  ];

  return (
    <section className="border-b border-[#14130F] bg-[#EDE7D8] px-3 py-2">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
        {cards.map((card) => {
          const deltaFromBase = card.cur - card.base;
          const previewDelta = card.prev !== null ? card.prev - card.cur : null;
          return (
            <div
              key={card.label}
              className="border border-[#14130F] bg-[#F6F2E8] px-2.5 py-2 rounded-[2px] flex flex-col justify-between"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-display font-bold text-xs tracking-wider uppercase text-[#575246]">
                  {card.label}
                </span>
                {hasRecoveryApplied && deltaFromBase !== 0 && (
                  <span
                    className={`font-mono text-[10px] font-semibold px-1 border tabular-nums ${
                      deltaFromBase < 0
                        ? 'border-[#2F6B4F] text-[#2F6B4F]'
                        : 'border-[#C8341C] text-[#C8341C]'
                    }`}
                  >
                    {formatDiff(deltaFromBase, card.unit)}
                  </span>
                )}
              </div>

              <div className="mt-1 flex items-baseline gap-2 font-mono tabular-nums">
                {hasRecoveryApplied && (
                  <span className="text-xs text-[#575246] line-through">
                    {card.base}
                    {card.unit}
                  </span>
                )}
                <span className={`text-xl font-semibold leading-none ${card.accent}`}>
                  {card.cur}
                  {card.unit}
                </span>
                {card.prev !== null && previewDelta !== null && (
                  <span
                    className={`text-xs font-semibold px-1 border ${
                      previewDelta < 0
                        ? 'border-[#1D4E89] bg-[#1D4E89] text-[#F6F2E8]'
                        : previewDelta > 0
                          ? 'border-[#C8341C] bg-[#C8341C] text-[#F6F2E8]'
                          : 'border-[#C8BFA8] text-[#575246]'
                    }`}
                  >
                    → {card.prev}
                    {card.unit}
                  </span>
                )}
              </div>

              <div className="mt-1 font-mono text-[10px] text-[#575246] truncate tabular-nums">
                {card.sub}
              </div>
            </div>
          );
        })}

        {/* Stranded / At-Risk Pax with Non-Double-Counted 3-Part Breakdown */}
        <div className="col-span-2 lg:col-span-1 border border-[#14130F] bg-[#F6F2E8] px-2.5 py-2 rounded-[2px] flex flex-col justify-between">
          <div className="flex items-center justify-between gap-2">
            <span className="font-display font-bold text-xs tracking-wider uppercase text-[#575246]">
              STRANDED / AT-RISK PAX
            </span>
            {p && (
              <span
                className={`font-mono text-[10px] font-semibold px-1 border tabular-nums ${
                  p.totalStrandedOrAtRiskPax - c.totalStrandedOrAtRiskPax <= 0
                    ? 'border-[#1D4E89] text-[#1D4E89]'
                    : 'border-[#C8341C] text-[#C8341C]'
                }`}
              >
                PREVIEW {p.totalStrandedOrAtRiskPax}
              </span>
            )}
          </div>

          <div className="mt-1 flex items-baseline gap-2 font-mono tabular-nums">
            {hasRecoveryApplied && (
              <span className="text-xs text-[#575246] line-through">
                {b.totalStrandedOrAtRiskPax}
              </span>
            )}
            <span
              className={`text-xl font-semibold leading-none ${
                c.totalStrandedOrAtRiskPax > 0 ? 'text-[#C8341C]' : 'text-[#2F6B4F]'
              }`}
            >
              {c.totalStrandedOrAtRiskPax}
            </span>
            <span className="text-[10px] text-[#575246]">PAX</span>
          </div>

          <div className="mt-1 font-mono text-[10px] text-[#575246] tabular-nums flex flex-wrap gap-x-2">
            <span>Missed: {c.missedConnectionPax}</span>
            <span>Cxl: {c.cancelledFlightPax}</span>
            <span>Breach-Risk: {c.crewBreachAtRiskPax}</span>
            {c.paxOverlapDeduction > 0 && <span>Dedup: -{c.paxOverlapDeduction}</span>}
          </div>
        </div>
      </div>

      {/* Explicit Policy Footnote & Modeling Assumption Strip */}
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-[#575246]">
        <div className="flex flex-wrap items-center gap-3">
          <span>* Crew duty evaluated against actual arrival times.</span>
          {previewLabel && (
            <span className="px-1.5 py-0.5 border border-[#1D4E89] bg-[#F6F2E8] text-[#1D4E89] font-semibold">
              HOVER PREVIEW: {previewLabel}
            </span>
          )}
        </div>
        {showStandbyBanner && (
          <div className="px-1.5 py-0.5 border border-[#1D4E89] bg-[#F6F2E8] text-[#1D4E89]">
            MODELING ASSUMPTION: Standby hub crew clock starts 45m before swap leg actual departure (dataset lists no standby crews).
          </div>
        )}
      </div>
    </section>
  );
};
