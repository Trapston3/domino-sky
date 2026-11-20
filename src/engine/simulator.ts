import { formatMinutesToTime, parseTimeToMinutes } from './time.js';
import type {
  CauseStep,
  ClosureSpec,
  FlightNetworkDataset,
  RecoveryAction,
  ReopeningSurgeMetrics,
  SimulatedConnection,
  SimulatedCrew,
  SimulatedFlight,
  SimulationOutcome,
  SimulationResult,
} from './types.js';
import { validateActions, validateClosure } from './validator.js';

interface InternalLeg extends SimulatedFlight {
  spareAvailableMin: number | null;
}

const STANDBY_CREW_PRE_DUTY_MIN = 45;
const STANDBY_MAX_DUTY_MIN = 600;
const MAX_FIXED_POINT_ITERATIONS = 30;

export function simulateNetwork(
  dataset: FlightNetworkDataset,
  closure: ClosureSpec,
  actions: RecoveryAction[] = [],
): SimulationOutcome {
  const closureCheck = validateClosure(dataset, closure);
  if (!closureCheck.ok) {
    return closureCheck;
  }

  const actionCheck = validateActions(dataset, actions);
  if (!actionCheck.ok) {
    return actionCheck;
  }

  const minTurnaround = dataset.meta.min_turnaround_minutes;
  const crewByFlightId = new Map<string, string>();
  for (const crew of dataset.crews) {
    for (const fid of crew.flight_ids) {
      crewByFlightId.set(fid, crew.crew_id);
    }
  }

  const spareById = new Map(dataset.spare_aircraft.map((s) => [s.tail_id, s]));

  const legs: InternalLeg[] = dataset.flights.map((f) => {
    const schedDepMin = parseTimeToMinutes(f.dep);
    const schedArrMin = parseTimeToMinutes(f.arr);
    return {
      ...f,
      scheduledDepMin: schedDepMin,
      scheduledArrMin: schedArrMin,
      actualDepMin: schedDepMin,
      actualArrMin: schedArrMin,
      actualDep: f.dep,
      actualArr: f.arr,
      delayMin: 0,
      turnaroundDelayMin: 0,
      holdDelayMin: 0,
      closureDelayMin: 0,
      cancelled: false,
      assignedTail: f.tail_id,
      isSpareTakeover: false,
      spareTailId: null,
      crewId: crewByFlightId.get(f.flight_id) ?? 'UNKNOWN',
      isStandbyCrew: false,
      crewBreach: false,
      rootCauseFlightId: null,
      causeChain: [],
      status: 'ON_TIME',
      spareAvailableMin: null,
    };
  });

  const legById = new Map(legs.map((l) => [l.flight_id, l]));
  const byOriginalTail = new Map<string, InternalLeg[]>();
  for (const leg of legs) {
    const list = byOriginalTail.get(leg.tail_id) ?? [];
    list.push(leg);
    byOriginalTail.set(leg.tail_id, list);
  }
  for (const chain of byOriginalTail.values()) {
    chain.sort((a, b) => a.leg_order - b.leg_order);
  }

  const heldConnectionIds = new Set<string>();
  const swapAssignments: Array<{
    spareId: string;
    base: string;
    swapFlightId: string;
    originalTail: string;
    availableMin: number;
  }> = [];

  for (const action of actions) {
    if (action.type === 'SWAP_SPARE') {
      const target = legById.get(action.flight_id)!;
      const spare = spareById.get(action.spare_tail_id)!;
      const availableMin = parseTimeToMinutes(spare.available_from);
      const chain = byOriginalTail.get(target.tail_id)!;
      for (const leg of chain) {
        if (leg.leg_order >= target.leg_order) {
          leg.assignedTail = spare.tail_id;
          leg.spareTailId = spare.tail_id;
          leg.crewId = `STBY-${spare.tail_id}`;
          leg.isStandbyCrew = true;
          if (leg.flight_id === target.flight_id) {
            leg.isSpareTakeover = true;
            leg.spareAvailableMin = availableMin;
          }
        }
      }
      swapAssignments.push({
        spareId: spare.tail_id,
        base: spare.base,
        swapFlightId: target.flight_id,
        originalTail: target.tail_id,
        availableMin,
      });
    } else if (action.type === 'CANCEL_TAIL_END') {
      const target = legById.get(action.flight_id)!;
      const chain = byOriginalTail.get(target.tail_id)!;
      for (const leg of chain) {
        if (leg.leg_order >= target.leg_order) {
          leg.cancelled = true;
          leg.cancelledBy = 'CANCEL_TAIL_END';
        }
      }
    } else if (action.type === 'CANCEL_LOOP') {
      for (const fid of action.flight_ids) {
        const leg = legById.get(fid)!;
        leg.cancelled = true;
        leg.cancelledBy = 'CANCEL_LOOP';
      }
    } else if (action.type === 'HOLD_CONNECTION') {
      heldConnectionIds.add(action.connection_id);
    }
  }

  const closureAirport = closure ? closure.airport : null;
  const closureStartMin = closure ? parseTimeToMinutes(closure.start) : -1;
  const closureEndMin = closure ? parseTimeToMinutes(closure.end) : -1;

  for (let iter = 0; iter < MAX_FIXED_POINT_ITERATIONS; iter += 1) {
    let changed = false;

    const holdReqByToFlight = new Map<
      string,
      { reqDepMin: number; connectionId: string; fromFlight: InternalLeg }
    >();
    for (const conn of dataset.connections) {
      if (!heldConnectionIds.has(conn.connection_id)) continue;
      const fromF = legById.get(conn.from_flight)!;
      const toF = legById.get(conn.to_flight)!;
      if (fromF.cancelled || toF.cancelled) continue;
      const reqDepMin = fromF.actualArrMin + conn.min_connect_minutes;
      const existing = holdReqByToFlight.get(toF.flight_id);
      if (!existing || reqDepMin > existing.reqDepMin) {
        holdReqByToFlight.set(toF.flight_id, {
          reqDepMin,
          connectionId: conn.connection_id,
          fromFlight: fromF,
        });
      }
    }

    for (const chain of byOriginalTail.values()) {
      const prevByAssignedTail = new Map<string, InternalLeg>();

      for (const leg of chain) {
        if (leg.cancelled) {
          leg.actualDepMin = leg.scheduledDepMin;
          leg.actualArrMin = leg.scheduledArrMin;
          leg.delayMin = 0;
          leg.turnaroundDelayMin = 0;
          leg.holdDelayMin = 0;
          leg.closureDelayMin = 0;
          leg.causeChain = [];
          leg.rootCauseFlightId = null;
          continue;
        }

        let dep = leg.scheduledDepMin;
        let turnaroundDelay = 0;
        let holdDelay = 0;
        let closureDelay = 0;
        const steps: CauseStep[] = [];
        let inheritedChain: CauseStep[] = [];

        const prev = prevByAssignedTail.get(leg.assignedTail);
        if (prev && !leg.isSpareTakeover) {
          const minTurnDep = prev.actualArrMin + minTurnaround;
          if (minTurnDep > dep) {
            const added = minTurnDep - dep;
            turnaroundDelay += added;
            inheritedChain = [...prev.causeChain];
            steps.push({
              kind: 'TURNAROUND',
              flightId: leg.flight_id,
              tailId: leg.assignedTail,
              sourceFlightId: prev.flight_id,
              description: `Awaited ${prev.flight_id} arrival (${formatMinutesToTime(prev.actualArrMin)}) + ${minTurnaround}m turnaround`,
              addedDelayMin: added,
              fromTimeMin: dep,
              toTimeMin: minTurnDep,
            });
            dep = minTurnDep;
          }
        } else if (leg.isSpareTakeover && leg.spareAvailableMin !== null && leg.spareAvailableMin > dep) {
          const added = leg.spareAvailableMin - dep;
          steps.push({
            kind: 'SPARE_AVAIL',
            flightId: leg.flight_id,
            tailId: leg.assignedTail,
            description: `Spare ${leg.assignedTail} available from ${formatMinutesToTime(leg.spareAvailableMin)}`,
            addedDelayMin: added,
            fromTimeMin: dep,
            toTimeMin: leg.spareAvailableMin,
          });
          dep = leg.spareAvailableMin;
        }

        const holdReq = holdReqByToFlight.get(leg.flight_id);
        if (holdReq && holdReq.reqDepMin > dep) {
          const added = holdReq.reqDepMin - dep;
          holdDelay += added;
          if (inheritedChain.length === 0 && holdReq.fromFlight.causeChain.length > 0) {
            inheritedChain = [...holdReq.fromFlight.causeChain];
          }
          steps.push({
            kind: 'HOLD_CONNECTION',
            flightId: leg.flight_id,
            tailId: leg.assignedTail,
            sourceFlightId: holdReq.fromFlight.flight_id,
            connectionId: holdReq.connectionId,
            description: `Held for ${holdReq.connectionId} from ${holdReq.fromFlight.flight_id} (${formatMinutesToTime(holdReq.fromFlight.actualArrMin)})`,
            addedDelayMin: added,
            fromTimeMin: dep,
            toTimeMin: holdReq.reqDepMin,
          });
          dep = holdReq.reqDepMin;
        }

        if (closureAirport && leg.origin === closureAirport && dep >= closureStartMin && dep < closureEndMin) {
          const added = closureEndMin - dep;
          closureDelay += added;
          steps.push({
            kind: 'CLOSURE_DEP',
            flightId: leg.flight_id,
            tailId: leg.assignedTail,
            description: `Departure gate hold at ${closureAirport} until reopening (${formatMinutesToTime(closureEndMin)})`,
            addedDelayMin: added,
            fromTimeMin: dep,
            toTimeMin: closureEndMin,
          });
          dep = closureEndMin;
        }

        const tentativeArr = dep + leg.block_minutes;
        if (
          closureAirport &&
          leg.destination === closureAirport &&
          tentativeArr >= closureStartMin &&
          tentativeArr < closureEndMin
        ) {
          const shift = closureEndMin - tentativeArr;
          closureDelay += shift;
          steps.push({
            kind: 'CLOSURE_ARR',
            flightId: leg.flight_id,
            tailId: leg.assignedTail,
            description: `Arrival ground stop for ${closureAirport}; held departure +${shift}m to land at ${formatMinutesToTime(closureEndMin)}`,
            addedDelayMin: shift,
            fromTimeMin: dep,
            toTimeMin: dep + shift,
          });
          dep += shift;
        }

        const arr = dep + leg.block_minutes;
        if (dep !== leg.actualDepMin || arr !== leg.actualArrMin) {
          changed = true;
        }

        leg.actualDepMin = dep;
        leg.actualArrMin = arr;
        leg.actualDep = formatMinutesToTime(dep);
        leg.actualArr = formatMinutesToTime(arr);
        leg.delayMin = arr - leg.scheduledArrMin;
        leg.turnaroundDelayMin = turnaroundDelay;
        leg.holdDelayMin = holdDelay;
        leg.closureDelayMin = closureDelay;
        leg.causeChain = [...inheritedChain, ...steps];
        leg.rootCauseFlightId = leg.causeChain.length > 0 ? leg.causeChain[0].flightId : null;

        prevByAssignedTail.set(leg.assignedTail, leg);
      }
    }

    if (!changed) break;
  }

  // Connections evaluation
  const simulatedConnections: SimulatedConnection[] = dataset.connections.map((conn) => {
    const fromF = legById.get(conn.from_flight)!;
    const toF = legById.get(conn.to_flight)!;
    const held = heldConnectionIds.has(conn.connection_id);
    if (fromF.cancelled || toF.cancelled) {
      return {
        ...conn,
        fromArrMin: fromF.cancelled ? null : fromF.actualArrMin,
        toDepMin: toF.cancelled ? null : toF.actualDepMin,
        connectMinutes: null,
        slackMinutes: null,
        status: 'CANCELLED',
        held,
      };
    }
    const connectMinutes = toF.actualDepMin - fromF.actualArrMin;
    const slackMinutes = connectMinutes - conn.min_connect_minutes;
    return {
      ...conn,
      fromArrMin: fromF.actualArrMin,
      toDepMin: toF.actualDepMin,
      connectMinutes,
      slackMinutes,
      status: connectMinutes >= conn.min_connect_minutes ? 'MADE' : 'BROKEN',
      held,
    };
  });

  // Crew duty evaluation against actualArr of last operated non-cancelled flight
  const simulatedCrews: SimulatedCrew[] = [];
  for (const crew of dataset.crews) {
    const dutyStartMin = parseTimeToMinutes(crew.duty_start);
    const operated = crew.flight_ids
      .map((fid) => legById.get(fid)!)
      .filter((f) => !f.cancelled && !f.isStandbyCrew);

    if (operated.length === 0) {
      simulatedCrews.push({
        ...crew,
        dutyStartMin,
        operatedFlightIds: [],
        lastOperatedFlightId: null,
        lastArrMin: null,
        dutyMins: 0,
        marginMin: crew.max_duty_mins,
        overageMin: 0,
        breached: false,
        isStandby: false,
      });
      continue;
    }

    const last = operated[operated.length - 1];
    const dutyMins = last.actualArrMin - dutyStartMin;
    const overageMin = Math.max(0, dutyMins - crew.max_duty_mins);
    const breached = dutyMins > crew.max_duty_mins;

    if (breached) {
      for (const leg of operated) {
        if (leg.actualArrMin - dutyStartMin > crew.max_duty_mins) {
          leg.crewBreach = true;
        }
      }
    }

    simulatedCrews.push({
      ...crew,
      dutyStartMin,
      operatedFlightIds: operated.map((f) => f.flight_id),
      lastOperatedFlightId: last.flight_id,
      lastArrMin: last.actualArrMin,
      dutyMins,
      marginMin: crew.max_duty_mins - dutyMins,
      overageMin,
      breached,
      isStandby: false,
    });
  }

  // Standby hub crews for active swaps (45 min prior to swap leg actualDep)
  for (const swap of swapAssignments) {
    const swapLeg = legById.get(swap.swapFlightId)!;
    const operated = (byOriginalTail.get(swap.originalTail) ?? []).filter(
      (f) => !f.cancelled && f.spareTailId === swap.spareId,
    );
    const dutyStartMin = swapLeg.actualDepMin - STANDBY_CREW_PRE_DUTY_MIN;
    const last = operated.length > 0 ? operated[operated.length - 1] : null;
    const dutyMins = last ? last.actualArrMin - dutyStartMin : 0;
    const overageMin = Math.max(0, dutyMins - STANDBY_MAX_DUTY_MIN);
    const breached = dutyMins > STANDBY_MAX_DUTY_MIN;

    if (breached) {
      for (const leg of operated) {
        if (leg.actualArrMin - dutyStartMin > STANDBY_MAX_DUTY_MIN) {
          leg.crewBreach = true;
        }
      }
    }

    simulatedCrews.push({
      crew_id: `STBY-${swap.spareId}`,
      tail_id: swap.spareId,
      base: swap.base,
      duty_start: formatMinutesToTime(dutyStartMin),
      max_duty_mins: STANDBY_MAX_DUTY_MIN,
      flight_ids: operated.map((f) => f.flight_id),
      dutyStartMin,
      operatedFlightIds: operated.map((f) => f.flight_id),
      lastOperatedFlightId: last ? last.flight_id : null,
      lastArrMin: last ? last.actualArrMin : null,
      dutyMins,
      marginMin: STANDBY_MAX_DUTY_MIN - dutyMins,
      overageMin,
      breached,
      isStandby: true,
      modelingAssumptionNote: `Modeling assumption: standby hub crew at ${swap.base} starts 600m duty clock 45m before ${swap.swapFlightId} actual departure (${formatMinutesToTime(dutyStartMin)}); flight_network.json lists no standby crews.`,
    });
  }

  // Finalize flight status
  const simulatedFlights: SimulatedFlight[] = legs.map((leg) => {
    let status: SimulatedFlight['status'] = 'ON_TIME';
    if (leg.cancelled) {
      status = 'CANCELLED';
    } else if (leg.crewBreach) {
      status = 'CREW_BREACH';
    } else if (leg.delayMin > 0) {
      status = 'DELAYED';
    }
    const { spareAvailableMin: _ignore, ...clean } = leg;
    return {
      ...clean,
      status,
    };
  });

  const cleanById = new Map(simulatedFlights.map((f) => [f.flight_id, f]));

  // Reopening Surge Badge (Informational Only)
  let reopeningSurge: ReopeningSurgeMetrics | null = null;
  if (closure && closureAirport) {
    const apt = dataset.airports.find((a) => a.id === closureAirport)!;
    const surgeStart = closureEndMin;
    const surgeEnd = closureEndMin + 60;
    let departuresCount = 0;
    let arrivalsCount = 0;
    for (const f of simulatedFlights) {
      if (f.cancelled) continue;
      if (f.origin === closureAirport && f.actualDepMin >= surgeStart && f.actualDepMin < surgeEnd) {
        departuresCount += 1;
      }
      if (f.destination === closureAirport && f.actualArrMin >= surgeStart && f.actualArrMin < surgeEnd) {
        arrivalsCount += 1;
      }
    }
    const operationsCount = departuresCount + arrivalsCount;
    reopeningSurge = {
      airport: closureAirport,
      windowStart: formatMinutesToTime(surgeStart),
      windowEnd: formatMinutesToTime(surgeEnd),
      windowStartMin: surgeStart,
      windowEndMin: surgeEnd,
      operationsCount,
      departuresCount,
      arrivalsCount,
      capacityPerHour: apt.capacity_per_hour,
      utilizationPct: Math.round((operationsCount / apt.capacity_per_hour) * 100),
    };
  }

  // Metrics & Non-Double-Counted Pax
  const operatedFlights = simulatedFlights.filter((f) => !f.cancelled);
  const delayedFlights = operatedFlights.filter((f) => f.delayMin > 0);
  const cancelledFlights = simulatedFlights.filter((f) => f.cancelled);
  const totalDelayMinutes = delayedFlights.reduce((sum, f) => sum + f.delayMin, 0);
  const maxFlightDelayMinutes = delayedFlights.reduce((max, f) => Math.max(max, f.delayMin), 0);

  const madeConnections = simulatedConnections.filter((c) => c.status === 'MADE');
  const brokenConnections = simulatedConnections.filter((c) => c.status === 'BROKEN');
  const cancelledConnections = simulatedConnections.filter((c) => c.status === 'CANCELLED');

  const breachedCrews = simulatedCrews.filter((c) => c.breached);
  const totalCrewOverageMinutes = breachedCrews.reduce((sum, c) => sum + c.overageMin, 0);

  const missedConnectionPax = brokenConnections.reduce((sum, c) => sum + c.passengers, 0);
  const cancelledFlightPax = cancelledFlights.reduce((sum, f) => sum + f.pax, 0);
  const crewBreachFlights = operatedFlights.filter((f) => f.crewBreach);
  const crewBreachAtRiskPax = crewBreachFlights.reduce((sum, f) => sum + f.pax, 0);

  // Guard against double counting if a broken connection directly touches a CREW_BREACH leg
  const overlapPerBreachFlight = new Map<string, number>();
  for (const conn of brokenConnections) {
    const fromF = cleanById.get(conn.from_flight)!;
    const toF = cleanById.get(conn.to_flight)!;
    if (fromF.crewBreach) {
      overlapPerBreachFlight.set(
        fromF.flight_id,
        (overlapPerBreachFlight.get(fromF.flight_id) ?? 0) + conn.passengers,
      );
    } else if (toF.crewBreach) {
      overlapPerBreachFlight.set(
        toF.flight_id,
        (overlapPerBreachFlight.get(toF.flight_id) ?? 0) + conn.passengers,
      );
    }
  }
  let paxOverlapDeduction = 0;
  for (const [fid, connPax] of overlapPerBreachFlight.entries()) {
    const leg = cleanById.get(fid)!;
    paxOverlapDeduction += Math.min(connPax, leg.pax);
  }

  const totalStrandedOrAtRiskPax =
    missedConnectionPax + cancelledFlightPax + crewBreachAtRiskPax - paxOverlapDeduction;

  return {
    ok: true,
    closure,
    actions,
    flights: simulatedFlights,
    connections: simulatedConnections,
    crews: simulatedCrews,
    metrics: {
      totalFlights: simulatedFlights.length,
      operatedFlights: operatedFlights.length,
      delayedFlightsCount: delayedFlights.length,
      cancelledFlightsCount: cancelledFlights.length,
      totalDelayMinutes,
      maxFlightDelayMinutes,
      totalConnections: simulatedConnections.length,
      madeConnectionsCount: madeConnections.length,
      brokenConnectionsCount: brokenConnections.length,
      cancelledConnectionsCount: cancelledConnections.length,
      crewBreachesCount: breachedCrews.length,
      totalCrewOverageMinutes,
      missedConnectionPax,
      cancelledFlightPax,
      crewBreachAtRiskPax,
      paxOverlapDeduction,
      totalStrandedOrAtRiskPax,
    },
    reopeningSurge,
    standbyAssumptionsUsed: swapAssignments.length > 0,
  };
}

export function simulateNetworkOrThrow(
  dataset: FlightNetworkDataset,
  closure: ClosureSpec,
  actions: RecoveryAction[] = [],
): SimulationResult {
  const outcome = simulateNetwork(dataset, closure, actions);
  if (!outcome.ok) {
    throw new Error(`${outcome.code}: ${outcome.reason}`);
  }
  return outcome;
}
