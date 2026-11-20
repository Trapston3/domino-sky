import React, { useMemo, useState } from 'react';
import type { SimulationResult } from '../engine/index.js';
import { FlightChipButton } from './FlightChipButton.js';

interface AuditTableProps {
  simulation: SimulationResult;
  onSelectFlight: (flightId: string) => void;
}

type AuditTab = 'FLIGHTS' | 'CONNECTIONS' | 'CREWS';
type FilterScope = 'ALL' | 'IMPACTED' | 'CRITICAL';

export const AuditTable: React.FC<AuditTableProps> = ({ simulation, onSelectFlight }) => {
  const [tab, setTab] = useState<AuditTab>('FLIGHTS');
  const [scope, setScope] = useState<FilterScope>('IMPACTED');

  const filteredFlights = useMemo(() => {
    const list = simulation.flights;
    if (scope === 'ALL') return list;
    if (scope === 'IMPACTED') {
      return list.filter(
        (f) => f.delayMin > 0 || f.cancelled || f.crewBreach || f.spareTailId !== null,
      );
    }
    return list.filter((f) => f.cancelled || f.crewBreach || f.delayMin >= 45);
  }, [simulation.flights, scope]);

  const filteredConnections = useMemo(() => {
    const list = simulation.connections;
    if (scope === 'ALL') return list;
    if (scope === 'IMPACTED') {
      return list.filter((c) => c.status !== 'MADE' || c.held);
    }
    return list.filter((c) => c.status === 'BROKEN' || c.status === 'CANCELLED');
  }, [simulation.connections, scope]);

  const filteredCrews = useMemo(() => {
    const list = simulation.crews;
    if (scope === 'ALL') return list;
    if (scope === 'IMPACTED') {
      return list.filter((c) => c.breached || c.isStandby || c.marginMin <= 45);
    }
    return list.filter((c) => c.breached || c.isStandby);
  }, [simulation.crews, scope]);

  return (
    <div className="border border-[#14130F] bg-[#F6F2E8] rounded-[2px] flex flex-col">
      {/* Header Bar */}
      <div className="border-b border-[#14130F] bg-[#EDE7D8] px-3 py-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1" role="tablist" aria-label="Audit entity tabs">
          {(
            [
              { id: 'FLIGHTS', label: `FLIGHTS (${simulation.flights.length})` },
              { id: 'CONNECTIONS', label: `CONNECTIONS (${simulation.connections.length})` },
              { id: 'CREWS', label: `CREWS (${simulation.crews.length})` },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={`px-2.5 py-1 border font-mono text-[11px] font-semibold cursor-pointer ${
                tab === item.id
                  ? 'border-[#14130F] bg-[#14130F] text-[#F6F2E8]'
                  : 'border-[#C8BFA8] bg-[#F6F2E8] text-[#14130F] hover:border-[#14130F]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1" role="group" aria-label="Audit filter scope">
          {(
            [
              { id: 'ALL', label: 'ALL' },
              { id: 'IMPACTED', label: 'IMPACTED' },
              { id: 'CRITICAL', label: 'CRITICAL' },
            ] as const
          ).map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={scope === s.id}
              onClick={() => setScope(s.id)}
              className={`px-2 py-0.5 border font-mono text-[10px] font-semibold cursor-pointer ${
                scope === s.id
                  ? 'border-[#1D4E89] bg-[#1D4E89] text-[#F6F2E8]'
                  : 'border-[#C8BFA8] bg-[#F6F2E8] text-[#575246] hover:text-[#14130F]'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tables */}
      <div className="overflow-x-auto max-h-[340px] overflow-y-auto">
        {tab === 'FLIGHTS' && (
          <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
            <thead className="sticky top-0 bg-[#EDE7D8] border-b border-[#14130F] text-left text-[10px] text-[#575246]">
              <tr>
                <th className="px-2.5 py-1.5">FLIGHT</th>
                <th className="px-2.5 py-1.5">TAIL</th>
                <th className="px-2.5 py-1.5">SECTOR</th>
                <th className="px-2.5 py-1.5">SCHED</th>
                <th className="px-2.5 py-1.5">ACTUAL</th>
                <th className="px-2.5 py-1.5">DELAY</th>
                <th className="px-2.5 py-1.5">PAX</th>
                <th className="px-2.5 py-1.5">STATUS / ROOT</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#C8BFA8]">
              {filteredFlights.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-4 text-center text-[#575246]">
                    No flights match the {scope} filter in the current state.
                  </td>
                </tr>
              ) : (
                filteredFlights.map((f) => (
                  <tr key={f.flight_id} className="hover:bg-[#EDE7D8]/70">
                    <td className="px-2.5 py-1.5">
                      <FlightChipButton
                        id={f.flight_id}
                        onSelect={onSelectFlight}
                        variant={
                          f.cancelled || f.crewBreach
                            ? 'breach'
                            : f.spareTailId
                              ? 'recovery'
                              : f.delayMin > 0
                                ? 'delayed'
                                : 'ontime'
                        }
                      />
                    </td>
                    <td className="px-2.5 py-1.5">
                      {f.assignedTail}
                      {f.spareTailId ? (
                        <span className="ml-1 text-[9px] font-bold text-[#1D4E89]">(SPARE)</span>
                      ) : null}
                    </td>
                    <td className="px-2.5 py-1.5 font-semibold">
                      {f.origin}→{f.destination}
                    </td>
                    <td className="px-2.5 py-1.5 text-[#575246]">
                      {f.dep}–{f.arr}
                    </td>
                    <td className="px-2.5 py-1.5 font-semibold">
                      {f.cancelled ? 'CANCELLED' : `${f.actualDep}–${f.actualArr}`}
                    </td>
                    <td
                      className={`px-2.5 py-1.5 font-bold ${
                        f.delayMin > 0 ? 'text-[#8A5D00]' : 'text-[#2F6B4F]'
                      }`}
                    >
                      {f.cancelled ? '—' : `+${f.delayMin}m`}
                    </td>
                    <td className="px-2.5 py-1.5">{f.pax}</td>
                    <td className="px-2.5 py-1.5">
                      <span
                        className={`px-1 py-0.5 border text-[10px] font-bold ${
                          f.status === 'CANCELLED' || f.status === 'CREW_BREACH'
                            ? 'border-[#C8341C] bg-[#C8341C] text-[#F6F2E8]'
                            : f.status === 'DELAYED'
                              ? 'border-[#C98A0B] text-[#8A5D00]'
                              : 'border-[#2F6B4F] text-[#2F6B4F]'
                        }`}
                      >
                        {f.status}
                      </span>
                      {f.rootCauseFlightId && !f.cancelled && (
                        <span className="ml-1.5 text-[10px] text-[#575246]">
                          via {f.rootCauseFlightId}
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}

        {tab === 'CONNECTIONS' && (
          <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
            <thead className="sticky top-0 bg-[#EDE7D8] border-b border-[#14130F] text-left text-[10px] text-[#575246]">
              <tr>
                <th className="px-2.5 py-1.5">CONN</th>
                <th className="px-2.5 py-1.5">HUB</th>
                <th className="px-2.5 py-1.5">FEEDER</th>
                <th className="px-2.5 py-1.5">OUTBOUND</th>
                <th className="px-2.5 py-1.5">PAX</th>
                <th className="px-2.5 py-1.5">ACTUAL / MIN</th>
                <th className="px-2.5 py-1.5">STATUS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#C8BFA8]">
              {filteredConnections.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-[#575246]">
                    No connections match the {scope} filter in the current state.
                  </td>
                </tr>
              ) : (
                filteredConnections.map((c) => (
                  <tr key={c.connection_id} className="hover:bg-[#EDE7D8]/70">
                    <td className="px-2.5 py-1.5 font-bold">{c.connection_id}</td>
                    <td className="px-2.5 py-1.5">{c.airport}</td>
                    <td className="px-2.5 py-1.5">
                      <FlightChipButton id={c.from_flight} onSelect={onSelectFlight} />
                    </td>
                    <td className="px-2.5 py-1.5">
                      <FlightChipButton id={c.to_flight} onSelect={onSelectFlight} />
                    </td>
                    <td className="px-2.5 py-1.5 font-semibold">{c.passengers}</td>
                    <td className="px-2.5 py-1.5">
                      {c.connectMinutes !== null
                        ? `${c.connectMinutes}m / ${c.min_connect_minutes}m`
                        : `N/A (${c.min_connect_minutes}m)`}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <span
                        className={`px-1 py-0.5 border text-[10px] font-bold ${
                          c.status === 'MADE'
                            ? c.held
                              ? 'border-[#1D4E89] bg-[#1D4E89] text-[#F6F2E8]'
                              : 'border-[#2F6B4F] text-[#2F6B4F]'
                            : 'border-[#C8341C] bg-[#C8341C] text-[#F6F2E8]'
                        }`}
                      >
                        {c.held ? 'HELD · ' : ''}
                        {c.status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}

        {tab === 'CREWS' && (
          <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
            <thead className="sticky top-0 bg-[#EDE7D8] border-b border-[#14130F] text-left text-[10px] text-[#575246]">
              <tr>
                <th className="px-2.5 py-1.5">CREW</th>
                <th className="px-2.5 py-1.5">TAIL</th>
                <th className="px-2.5 py-1.5">BASE</th>
                <th className="px-2.5 py-1.5">DUTY START</th>
                <th className="px-2.5 py-1.5">LAST LEG</th>
                <th className="px-2.5 py-1.5">DUTY / MAX</th>
                <th className="px-2.5 py-1.5">STATUS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#C8BFA8]">
              {filteredCrews.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-[#575246]">
                    No crews match the {scope} filter in the current state.
                  </td>
                </tr>
              ) : (
                filteredCrews.map((cr) => (
                  <tr key={cr.crew_id} className="hover:bg-[#EDE7D8]/70">
                    <td className="px-2.5 py-1.5 font-bold">
                      {cr.crew_id}
                      {cr.isStandby && (
                        <span className="ml-1 text-[9px] text-[#1D4E89]">(ASSUMED)</span>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5">{cr.tail_id}</td>
                    <td className="px-2.5 py-1.5">{cr.base}</td>
                    <td className="px-2.5 py-1.5">{cr.duty_start}</td>
                    <td className="px-2.5 py-1.5">
                      {cr.lastOperatedFlightId ? (
                        <FlightChipButton
                          id={cr.lastOperatedFlightId}
                          onSelect={onSelectFlight}
                          variant={cr.breached ? 'breach' : 'default'}
                        />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-2.5 py-1.5">
                      {cr.dutyMins}m / {cr.max_duty_mins}m
                    </td>
                    <td className="px-2.5 py-1.5">
                      <span
                        className={`px-1 py-0.5 border text-[10px] font-bold ${
                          cr.breached
                            ? 'border-[#C8341C] bg-[#C8341C] text-[#F6F2E8]'
                            : cr.isStandby
                              ? 'border-[#1D4E89] text-[#1D4E89]'
                              : 'border-[#2F6B4F] text-[#2F6B4F]'
                        }`}
                      >
                        {cr.breached ? `BREACH +${cr.overageMin}M` : `MARGIN ${cr.marginMin}M`}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
