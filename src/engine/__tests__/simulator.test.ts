import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flightNetwork } from '../../data/flightNetwork.js';
import {
  compareObjectives,
  evaluateRecoveryCandidates,
  formatMinutesToTime,
  inspectFlight,
  parseAndValidateRawActions,
  parseTimeToMinutes,
  simulateNetwork,
  simulateNetworkOrThrow,
} from '../index.js';

describe('flight_network.json parity', () => {
  it('matches flight_network.json byte-for-data in src/data/flightNetwork.ts', () => {
    const rawJson = JSON.parse(readFileSync(resolve(process.cwd(), 'flight_network.json'), 'utf8'));
    expect(flightNetwork).toEqual(rawJson);
  });
});

describe('Domino Sky simulation engine — 11 mandatory golden assertions', () => {
  it('1. No closure -> 0 delayed, 0 delay mins, 0 broken conns, 0 breaches, 0 stranded pax', () => {
    const res = simulateNetworkOrThrow(flightNetwork, null, []);
    expect(res.metrics.delayedFlightsCount).toBe(0);
    expect(res.metrics.totalDelayMinutes).toBe(0);
    expect(res.metrics.brokenConnectionsCount).toBe(0);
    expect(res.metrics.crewBreachesCount).toBe(0);
    expect(res.metrics.totalStrandedOrAtRiskPax).toBe(0);
    expect(res.reopeningSurge).toBeNull();
  });

  it('2. BOM 07:30-09:00 -> 16 delayed, 755 delay mins, 6 broken conns (199 pax), 0 breaches', () => {
    const res = simulateNetworkOrThrow(
      flightNetwork,
      { airport: 'BOM', start: '07:30', end: '09:00' },
      [],
    );
    expect(res.metrics.delayedFlightsCount).toBe(16);
    expect(res.metrics.totalDelayMinutes).toBe(755);
    expect(res.metrics.brokenConnectionsCount).toBe(6);
    expect(res.metrics.missedConnectionPax).toBe(199);
    expect(res.metrics.crewBreachesCount).toBe(0);
    expect(res.metrics.totalStrandedOrAtRiskPax).toBe(199);
  });

  it('3. DEL 12:00-13:30 -> 10 delayed, 680 delay mins, 1 broken conn (18 pax), 1 breach (CR03 +50 min)', () => {
    const res = simulateNetworkOrThrow(
      flightNetwork,
      { airport: 'DEL', start: '12:00', end: '13:30' },
      [],
    );
    expect(res.metrics.delayedFlightsCount).toBe(10);
    expect(res.metrics.totalDelayMinutes).toBe(680);
    expect(res.metrics.brokenConnectionsCount).toBe(1);
    expect(res.metrics.missedConnectionPax).toBe(18);
    expect(res.metrics.crewBreachesCount).toBe(1);

    const cr03 = res.crews.find((c) => c.crew_id === 'CR03')!;
    expect(cr03.breached).toBe(true);
    expect(cr03.overageMin).toBe(50);
    expect(res.flights.find((f) => f.flight_id === 'DS0304')!.crewBreach).toBe(true);
  });

  it('4. BLR 13:00-14:30 -> 8 delayed, 295 delay mins, 1 broken conn (45 pax), 1 breach (CR08 +10 min)', () => {
    const res = simulateNetworkOrThrow(
      flightNetwork,
      { airport: 'BLR', start: '13:00', end: '14:30' },
      [],
    );
    expect(res.metrics.delayedFlightsCount).toBe(8);
    expect(res.metrics.totalDelayMinutes).toBe(295);
    expect(res.metrics.brokenConnectionsCount).toBe(1);
    expect(res.metrics.missedConnectionPax).toBe(45);
    expect(res.metrics.crewBreachesCount).toBe(1);

    const cr08 = res.crews.find((c) => c.crew_id === 'CR08')!;
    expect(cr08.breached).toBe(true);
    expect(cr08.overageMin).toBe(10);
    expect(res.flights.find((f) => f.flight_id === 'DS0805')!.crewBreach).toBe(true);
  });

  it('5. CCU 16:00-17:30 -> 3 delayed, 195 delay mins, 0 broken conns, 1 breach (CR10 +30 min)', () => {
    const res = simulateNetworkOrThrow(
      flightNetwork,
      { airport: 'CCU', start: '16:00', end: '17:30' },
      [],
    );
    expect(res.metrics.delayedFlightsCount).toBe(3);
    expect(res.metrics.totalDelayMinutes).toBe(195);
    expect(res.metrics.brokenConnectionsCount).toBe(0);
    expect(res.metrics.crewBreachesCount).toBe(1);

    const cr10 = res.crews.find((c) => c.crew_id === 'CR10')!;
    expect(cr10.breached).toBe(true);
    expect(cr10.overageMin).toBe(30);
    expect(res.flights.find((f) => f.flight_id === 'DS1005')!.crewBreach).toBe(true);
  });

  it('6. DEL 12:00-13:30 + SWAP_SPARE(VT-DS18, DS0304) -> 9 delayed, 620 delay mins, 0 breaches, 1 broken conn (18 pax)', () => {
    const res = simulateNetworkOrThrow(
      flightNetwork,
      { airport: 'DEL', start: '12:00', end: '13:30' },
      [{ type: 'SWAP_SPARE', spare_tail_id: 'VT-DS18', flight_id: 'DS0304' }],
    );
    expect(res.metrics.delayedFlightsCount).toBe(9);
    expect(res.metrics.totalDelayMinutes).toBe(620);
    expect(res.metrics.crewBreachesCount).toBe(0);
    expect(res.crews.find((c) => c.crew_id === 'CR03')!.breached).toBe(false);
    expect(res.metrics.brokenConnectionsCount).toBe(1);
    expect(res.metrics.missedConnectionPax).toBe(18);
    expect(res.standbyAssumptionsUsed).toBe(true);

    const standby = res.crews.find((c) => c.crew_id === 'STBY-VT-DS18')!;
    expect(standby.isStandby).toBe(true);
    expect(standby.dutyStartMin).toBe(parseTimeToMinutes('18:55') - 45);
    expect(standby.breached).toBe(false);
  });

  it('7. BLR 13:00-14:30 + SWAP_SPARE(VT-DS17, DS0802) -> 7 delayed, 175 delay mins, 0 breaches, 2 broken conns (68 pax)', () => {
    const res = simulateNetworkOrThrow(
      flightNetwork,
      { airport: 'BLR', start: '13:00', end: '14:30' },
      [{ type: 'SWAP_SPARE', spare_tail_id: 'VT-DS17', flight_id: 'DS0802' }],
    );
    expect(res.metrics.delayedFlightsCount).toBe(7);
    expect(res.metrics.totalDelayMinutes).toBe(175);
    expect(res.metrics.crewBreachesCount).toBe(0);
    expect(res.crews.find((c) => c.crew_id === 'CR08')!.breached).toBe(false);
    expect(res.metrics.brokenConnectionsCount).toBe(2);
    expect(res.metrics.missedConnectionPax).toBe(68);

    const brokenIds = res.connections.filter((c) => c.status === 'BROKEN').map((c) => c.connection_id);
    expect(brokenIds).toEqual(['CX12', 'CX17']);

    // DS0802 is scheduled at 14:15 during BLR 13:00-14:30 closure and is held to 14:30
    const ds0802 = res.flights.find((f) => f.flight_id === 'DS0802')!;
    expect(ds0802.actualDep).toBe('14:30');
    const standby = res.crews.find((c) => c.crew_id === 'STBY-VT-DS17')!;
    expect(standby.dutyStartMin).toBe(parseTimeToMinutes('14:30') - 45);
    expect(standby.breached).toBe(false);
  });

  it('8. CCU 16:00-17:30 + CANCEL_TAIL_END(DS1005) -> 2 delayed, 135 delay mins, 0 breaches, 0 broken conns, 117 cancelled pax', () => {
    const res = simulateNetworkOrThrow(
      flightNetwork,
      { airport: 'CCU', start: '16:00', end: '17:30' },
      [{ type: 'CANCEL_TAIL_END', flight_id: 'DS1005' }],
    );
    expect(res.metrics.delayedFlightsCount).toBe(2);
    expect(res.metrics.totalDelayMinutes).toBe(135);
    expect(res.metrics.crewBreachesCount).toBe(0);
    expect(res.crews.find((c) => c.crew_id === 'CR10')!.breached).toBe(false);
    expect(res.metrics.brokenConnectionsCount).toBe(0);
    expect(res.metrics.cancelledFlightPax).toBe(117);
    expect(res.metrics.totalStrandedOrAtRiskPax).toBe(117);
  });

  it('9. CCU 16:00-17:30 + CANCEL_LOOP(DS1003, DS1004) -> 0 delayed, 0 delay mins, 0 breaches, 0 broken conns, 278 cancelled pax', () => {
    const res = simulateNetworkOrThrow(
      flightNetwork,
      { airport: 'CCU', start: '16:00', end: '17:30' },
      [{ type: 'CANCEL_LOOP', flight_ids: ['DS1003', 'DS1004'] }],
    );
    expect(res.metrics.delayedFlightsCount).toBe(0);
    expect(res.metrics.totalDelayMinutes).toBe(0);
    expect(res.metrics.crewBreachesCount).toBe(0);
    expect(res.crews.find((c) => c.crew_id === 'CR10')!.breached).toBe(false);
    expect(res.metrics.brokenConnectionsCount).toBe(0);
    expect(res.metrics.cancelledFlightPax).toBe(278);
    expect(res.metrics.totalStrandedOrAtRiskPax).toBe(278);
  });

  it('10. BLR 13:00-14:30 + HOLD_CONNECTION(CX12) -> DS0504 held to 15:15, 8 delayed, 310 delay mins, 0 broken conns, CR08 +10 min', () => {
    const res = simulateNetworkOrThrow(
      flightNetwork,
      { airport: 'BLR', start: '13:00', end: '14:30' },
      [{ type: 'HOLD_CONNECTION', connection_id: 'CX12' }],
    );
    expect(res.flights.find((f) => f.flight_id === 'DS0504')!.actualDep).toBe('15:15');
    expect(res.metrics.delayedFlightsCount).toBe(8);
    expect(res.metrics.totalDelayMinutes).toBe(310);
    expect(res.metrics.brokenConnectionsCount).toBe(0);
    expect(res.metrics.crewBreachesCount).toBe(1);
    expect(res.crews.find((c) => c.crew_id === 'CR08')!.overageMin).toBe(10);
  });

  it('11. DEL 12:00-13:30 + HOLD_CONNECTION(CX10) -> DS0903 held to 14:15, 11 delayed, 710 delay mins, 0 broken conns, CR03 +50 min', () => {
    const res = simulateNetworkOrThrow(
      flightNetwork,
      { airport: 'DEL', start: '12:00', end: '13:30' },
      [{ type: 'HOLD_CONNECTION', connection_id: 'CX10' }],
    );
    expect(res.flights.find((f) => f.flight_id === 'DS0903')!.actualDep).toBe('14:15');
    expect(res.metrics.delayedFlightsCount).toBe(11);
    expect(res.metrics.totalDelayMinutes).toBe(710);
    expect(res.metrics.brokenConnectionsCount).toBe(0);
    expect(res.metrics.crewBreachesCount).toBe(1);
    expect(res.crews.find((c) => c.crew_id === 'CR03')!.overageMin).toBe(50);
  });
});

describe('Physical action validation, causal inspection & optimizer', () => {
  it('formats post-midnight rollover times with (+1)', () => {
    expect(formatMinutesToTime(1455)).toBe('00:15 (+1)');
    expect(formatMinutesToTime(1439)).toBe('23:59');
  });

  it('rejects physically invalid actions with structured error codes', () => {
    const closure = { airport: 'CCU', start: '16:00', end: '17:30' };

    const wrongHub = simulateNetwork(flightNetwork, closure, [
      { type: 'SWAP_SPARE', spare_tail_id: 'VT-DS18', flight_id: 'DS0802' },
    ]);
    expect(wrongHub).toMatchObject({ ok: false, code: 'SPARE_WRONG_HUB' });

    const duplicateSpare = simulateNetwork(
      flightNetwork,
      { airport: 'DEL', start: '12:00', end: '13:30' },
      [
        { type: 'SWAP_SPARE', spare_tail_id: 'VT-DS18', flight_id: 'DS0304' },
        { type: 'SWAP_SPARE', spare_tail_id: 'VT-DS18', flight_id: 'DS0903' },
      ],
    );
    expect(duplicateSpare).toMatchObject({ ok: false, code: 'SPARE_ALREADY_USED' });

    const brokenLoop = simulateNetwork(flightNetwork, closure, [
      { type: 'CANCEL_LOOP', flight_ids: ['DS1003'] },
    ]);
    expect(brokenLoop).toMatchObject({ ok: false, code: 'BREAKS_AIRCRAFT_CONTINUITY' });

    const nonContiguousLoop = simulateNetwork(flightNetwork, closure, [
      { type: 'CANCEL_LOOP', flight_ids: ['DS1001', 'DS1004'] },
    ]);
    expect(nonContiguousLoop).toMatchObject({ ok: false, code: 'BREAKS_AIRCRAFT_CONTINUITY' });

    const missingFlight = simulateNetwork(flightNetwork, closure, [
      { type: 'CANCEL_TAIL_END', flight_id: 'DS9999' },
    ]);
    expect(missingFlight).toMatchObject({ ok: false, code: 'FLIGHT_NOT_FOUND' });

    const missingConn = simulateNetwork(flightNetwork, closure, [
      { type: 'HOLD_CONNECTION', connection_id: 'CX99' },
    ]);
    expect(missingConn).toMatchObject({ ok: false, code: 'CONNECTION_NOT_FOUND' });

    const rawCheck = parseAndValidateRawActions(flightNetwork, [{ type: 'TELEPORT_TAIL' }]);
    expect(rawCheck).toMatchObject({ ok: false, code: 'INVALID_ACTION' });
  });

  it('supports stacking multiple recovery actions cleanly (DEL SWAP + HOLD CX10)', () => {
    const res = simulateNetworkOrThrow(
      flightNetwork,
      { airport: 'DEL', start: '12:00', end: '13:30' },
      [
        { type: 'SWAP_SPARE', spare_tail_id: 'VT-DS18', flight_id: 'DS0304' },
        { type: 'HOLD_CONNECTION', connection_id: 'CX10' },
      ],
    );
    expect(res.metrics.crewBreachesCount).toBe(0);
    expect(res.metrics.brokenConnectionsCount).toBe(0);
    expect(res.metrics.totalStrandedOrAtRiskPax).toBe(0);
  });

  it('traces root-cause chain and turnaround slack via inspectFlight', () => {
    const sim = simulateNetworkOrThrow(
      flightNetwork,
      { airport: 'DEL', start: '12:00', end: '13:30' },
      [],
    );
    const inspection = inspectFlight(sim, flightNetwork, 'DS0304');
    expect(inspection).not.toBeNull();
    expect(inspection!.flight.rootCauseFlightId).toBe('DS0301');
    expect(inspection!.flight.causeChain.length).toBeGreaterThanOrEqual(3);
    expect(inspection!.crew?.crew_id).toBe('CR03');
    expect(inspection!.crew?.overageMin).toBe(50);
  });

  it('highlights negative trade-offs and re-ranks across the 3 objective profiles', () => {
    const blrClosure = { airport: 'BLR', start: '13:00', end: '14:30' };
    const legalRanked = evaluateRecoveryCandidates(flightNetwork, blrClosure, 'LEGAL_COMPLIANCE', 20);
    const swapOnly = legalRanked.find((c) => c.id === 'SWAP:VT-DS17:DS0802');
    expect(swapOnly).toBeDefined();
    expect(swapOnly!.tradeOffWarnings.some((w) => w.includes('CX17'))).toBe(true);

    const ccuClosure = { airport: 'CCU', start: '16:00', end: '17:30' };
    const compared = compareObjectives(flightNetwork, ccuClosure, 3);
    expect(compared.LEGAL_COMPLIANCE[0].result.metrics.crewBreachesCount).toBe(0);
    expect(compared.PASSENGER_PROTECTION[0].id).toBe('CXL_END:DS1005');
    expect(compared.DELAY_MINIMIZATION[0].id).toBe('CXL_LOOP:DS1003,DS1004');
  });

  it('computes informational reopening surge without mutating golden metrics', () => {
    const res = simulateNetworkOrThrow(
      flightNetwork,
      { airport: 'DEL', start: '12:00', end: '13:30' },
      [],
    );
    expect(res.reopeningSurge).not.toBeNull();
    expect(res.reopeningSurge!.windowStart).toBe('13:30');
    expect(res.reopeningSurge!.windowEnd).toBe('14:30');
    expect(res.reopeningSurge!.capacityPerHour).toBe(40);
    expect(res.reopeningSurge!.operationsCount).toBeGreaterThan(0);
  });
});
