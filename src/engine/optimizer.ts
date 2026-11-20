import { simulateNetwork } from './simulator.js';
import { formatMinutesToTime } from './time.js';
import type {
  ClosureSpec,
  FlightNetworkDataset,
  FlightRecord,
  ObjectiveProfile,
  RecoveryAction,
  RecoveryCandidate,
  SimulationResult,
} from './types.js';

export function formatActionLabel(action: RecoveryAction): string {
  switch (action.type) {
    case 'SWAP_SPARE':
      return `SWAP ${action.spare_tail_id} -> ${action.flight_id}`;
    case 'CANCEL_TAIL_END':
      return `CANCEL TAIL-END ${action.flight_id}+`;
    case 'CANCEL_LOOP':
      return `CANCEL LOOP ${action.flight_ids.join('+')}`;
    case 'HOLD_CONNECTION':
      return `HOLD ${action.connection_id}`;
  }
}

export function formatCandidateId(actions: RecoveryAction[]): string {
  return actions
    .map((a) => {
      switch (a.type) {
        case 'SWAP_SPARE':
          return `SWAP:${a.spare_tail_id}:${a.flight_id}`;
        case 'CANCEL_TAIL_END':
          return `CXL_END:${a.flight_id}`;
        case 'CANCEL_LOOP':
          return `CXL_LOOP:${a.flight_ids.join(',')}`;
        case 'HOLD_CONNECTION':
          return `HOLD:${a.connection_id}`;
      }
    })
    .join('|');
}

function compareByObjective(
  a: RecoveryCandidate,
  b: RecoveryCandidate,
  objective: ObjectiveProfile,
): number {
  const ma = a.result.metrics;
  const mb = b.result.metrics;

  if (objective === 'LEGAL_COMPLIANCE') {
    if (ma.crewBreachesCount !== mb.crewBreachesCount) {
      return ma.crewBreachesCount - mb.crewBreachesCount;
    }
    if (ma.totalStrandedOrAtRiskPax !== mb.totalStrandedOrAtRiskPax) {
      return ma.totalStrandedOrAtRiskPax - mb.totalStrandedOrAtRiskPax;
    }
    if (ma.totalDelayMinutes !== mb.totalDelayMinutes) {
      return ma.totalDelayMinutes - mb.totalDelayMinutes;
    }
  } else if (objective === 'PASSENGER_PROTECTION') {
    if (ma.totalStrandedOrAtRiskPax !== mb.totalStrandedOrAtRiskPax) {
      return ma.totalStrandedOrAtRiskPax - mb.totalStrandedOrAtRiskPax;
    }
    if (ma.crewBreachesCount !== mb.crewBreachesCount) {
      return ma.crewBreachesCount - mb.crewBreachesCount;
    }
    if (ma.totalDelayMinutes !== mb.totalDelayMinutes) {
      return ma.totalDelayMinutes - mb.totalDelayMinutes;
    }
  } else {
    // DELAY_MINIMIZATION
    if (ma.totalDelayMinutes !== mb.totalDelayMinutes) {
      return ma.totalDelayMinutes - mb.totalDelayMinutes;
    }
    if (ma.crewBreachesCount !== mb.crewBreachesCount) {
      return ma.crewBreachesCount - mb.crewBreachesCount;
    }
    if (ma.totalStrandedOrAtRiskPax !== mb.totalStrandedOrAtRiskPax) {
      return ma.totalStrandedOrAtRiskPax - mb.totalStrandedOrAtRiskPax;
    }
  }

  // Tie-breakers: fewer actions, then fewer cancelled pax, then deterministic ID
  if (a.actions.length !== b.actions.length) {
    return a.actions.length - b.actions.length;
  }
  if (ma.cancelledFlightPax !== mb.cancelledFlightPax) {
    return ma.cancelledFlightPax - mb.cancelledFlightPax;
  }
  return a.id.localeCompare(b.id);
}

function buildCandidateMetadata(
  baseline: SimulationResult,
  result: SimulationResult,
  actions: RecoveryAction[],
): Omit<RecoveryCandidate, 'scoreRank'> {
  const baseM = baseline.metrics;
  const curM = result.metrics;

  const deltas = {
    delayedFlights: curM.delayedFlightsCount - baseM.delayedFlightsCount,
    totalDelayMinutes: curM.totalDelayMinutes - baseM.totalDelayMinutes,
    brokenConnections: curM.brokenConnectionsCount - baseM.brokenConnectionsCount,
    crewBreaches: curM.crewBreachesCount - baseM.crewBreachesCount,
    strandedOrAtRiskPax: curM.totalStrandedOrAtRiskPax - baseM.totalStrandedOrAtRiskPax,
    cancelledPax: curM.cancelledFlightPax - baseM.cancelledFlightPax,
  };

  const positives: string[] = [];
  const tradeOffWarnings: string[] = [];

  // Cleared crew breaches
  const baseBreachMap = new Map(
    baseline.crews.filter((c) => c.breached).map((c) => [c.crew_id, c.overageMin]),
  );
  const curBreachMap = new Map(
    result.crews.filter((c) => c.breached).map((c) => [c.crew_id, c.overageMin]),
  );
  const clearedCrews = Array.from(baseBreachMap.keys()).filter((cid) => !curBreachMap.has(cid));
  if (clearedCrews.length > 0) {
    positives.push(`Clears crew duty breach (${clearedCrews.join(', ')})`);
  }

  // Fixed broken connections
  const baseBrokenIds = new Set(
    baseline.connections.filter((c) => c.status === 'BROKEN').map((c) => c.connection_id),
  );
  const curBrokenIds = new Set(
    result.connections.filter((c) => c.status === 'BROKEN').map((c) => c.connection_id),
  );
  const savedConns = baseline.connections.filter(
    (c) =>
      baseBrokenIds.has(c.connection_id) &&
      result.connections.find((rc) => rc.connection_id === c.connection_id)?.status === 'MADE',
  );
  if (savedConns.length > 0) {
    const savedPax = savedConns.reduce((s, c) => s + c.passengers, 0);
    positives.push(
      `Saves ${savedConns.map((c) => c.connection_id).join(', ')} (${savedPax} connecting pax)`,
    );
  }

  if (deltas.totalDelayMinutes < 0) {
    positives.push(`Cuts network delay by ${Math.abs(deltas.totalDelayMinutes)}m`);
  }

  // Negative trade-offs
  const newlyBrokenConns = result.connections.filter(
    (c) => c.status === 'BROKEN' && !baseBrokenIds.has(c.connection_id),
  );
  if (newlyBrokenConns.length > 0) {
    const newBrokenPax = newlyBrokenConns.reduce((s, c) => s + c.passengers, 0);
    tradeOffWarnings.push(
      `Breaks downstream ${newlyBrokenConns.map((c) => `${c.connection_id} (${c.from_flight}->${c.to_flight}, ${c.passengers}p)`).join(', ')} (+${newBrokenPax} missed conn pax)`,
    );
  }

  if (deltas.totalDelayMinutes > 0) {
    tradeOffWarnings.push(`Adds +${deltas.totalDelayMinutes}m network delay across downstream tail legs`);
  }

  if (curM.cancelledFlightPax > 0) {
    const cancelledIds = result.flights.filter((f) => f.cancelled).map((f) => f.flight_id);
    tradeOffWarnings.push(
      `Cancels ${cancelledIds.join('+')} (${curM.cancelledFlightPax} pax require re-accommodation)`,
    );
  }

  if (curM.crewBreachesCount > 0) {
    const remaining = result.crews
      .filter((c) => c.breached)
      .map((c) => `${c.crew_id} (+${c.overageMin}m)`);
    tradeOffWarnings.push(`Does NOT clear crew duty breach: ${remaining.join(', ')}`);
  }

  const remainingUnheldBroken = result.connections.filter(
    (c) => c.status === 'BROKEN' && curBrokenIds.has(c.connection_id) && !newlyBrokenConns.some((n) => n.connection_id === c.connection_id),
  );
  if (remainingUnheldBroken.length > 0 && clearedCrews.length > 0) {
    tradeOffWarnings.push(
      `Leaves ${remainingUnheldBroken.map((c) => `${c.connection_id} (${c.passengers}p)`).join(', ')} broken`,
    );
  }

  // Note held flight times explicitly for clarity
  const holdActions = actions.filter((a): a is Extract<RecoveryAction, { type: 'HOLD_CONNECTION' }> => a.type === 'HOLD_CONNECTION');
  for (const ha of holdActions) {
    const conn = result.connections.find((c) => c.connection_id === ha.connection_id);
    const toFlight = conn ? result.flights.find((f) => f.flight_id === conn.to_flight) : undefined;
    if (conn && toFlight && toFlight.delayMin > 0) {
      positives.push(`Holds ${toFlight.flight_id} to ${formatMinutesToTime(toFlight.actualDepMin)}`);
    }
  }

  return {
    id: formatCandidateId(actions),
    label: actions.map(formatActionLabel).join(' + '),
    actions,
    result,
    deltas,
    positives,
    tradeOffWarnings,
    usesStandbyAssumption: result.standbyAssumptionsUsed,
  };
}

function generateSingleActionPool(
  dataset: FlightNetworkDataset,
  baseline: SimulationResult,
): RecoveryAction[] {
  const pool: RecoveryAction[] = [];
  const disruptedFlightIds = new Set(
    baseline.flights.filter((f) => f.delayMin > 0 || f.crewBreach).map((f) => f.flight_id),
  );
  const disruptedTails = new Set(
    baseline.flights.filter((f) => f.delayMin > 0 || f.crewBreach).map((f) => f.tail_id),
  );

  // 1. SWAP_SPARE on delayed/breached legs (or legs on disrupted tails) departing spare's hub
  for (const spare of dataset.spare_aircraft) {
    for (const f of dataset.flights) {
      if (f.origin !== spare.base) continue;
      if (!disruptedTails.has(f.tail_id) && !disruptedFlightIds.has(f.flight_id)) continue;
      pool.push({ type: 'SWAP_SPARE', spare_tail_id: spare.tail_id, flight_id: f.flight_id });
    }
  }

  // 2. HOLD_CONNECTION on currently broken connections
  for (const conn of baseline.connections) {
    if (conn.status === 'BROKEN') {
      pool.push({ type: 'HOLD_CONNECTION', connection_id: conn.connection_id });
    }
  }

  // 3. CANCEL_TAIL_END on disrupted tails (last 1..2 legs, or starting from delayed/breached legs)
  const byTail = new Map<string, FlightRecord[]>();
  for (const f of dataset.flights) {
    const list = byTail.get(f.tail_id) ?? [];
    list.push(f);
    byTail.set(f.tail_id, list);
  }
  for (const [tailId, chain] of byTail.entries()) {
    chain.sort((a, b) => a.leg_order - b.leg_order);
    if (!disruptedTails.has(tailId)) continue;
    for (let i = Math.max(0, chain.length - 3); i < chain.length; i += 1) {
      pool.push({ type: 'CANCEL_TAIL_END', flight_id: chain[i].flight_id });
    }
  }

  // 4. CANCEL_LOOP on disrupted tails
  for (const [tailId, chain] of byTail.entries()) {
    if (!disruptedTails.has(tailId)) continue;
    for (let i = 0; i < chain.length; i += 1) {
      for (let j = i; j < chain.length; j += 1) {
        if (chain[i].origin === chain[j].destination) {
          const slice = chain.slice(i, j + 1);
          // Avoid duplicating CANCEL_TAIL_END when loop goes to the end
          if (j < chain.length - 1) {
            pool.push({
              type: 'CANCEL_LOOP',
              flight_ids: slice.map((l) => l.flight_id),
            });
          }
        }
      }
    }
  }

  return pool;
}

function isMeaningfulImprovement(baseline: SimulationResult, candidate: SimulationResult): boolean {
  const b = baseline.metrics;
  const c = candidate.metrics;
  return (
    c.crewBreachesCount < b.crewBreachesCount ||
    c.brokenConnectionsCount < b.brokenConnectionsCount ||
    c.totalDelayMinutes < b.totalDelayMinutes ||
    c.totalStrandedOrAtRiskPax < b.totalStrandedOrAtRiskPax ||
    c.delayedFlightsCount < b.delayedFlightsCount
  );
}

export function evaluateRecoveryCandidates(
  dataset: FlightNetworkDataset,
  closure: ClosureSpec,
  objective: ObjectiveProfile = 'LEGAL_COMPLIANCE',
  limit = 12,
): RecoveryCandidate[] {
  const baselineOutcome = simulateNetwork(dataset, closure, []);
  if (!baselineOutcome.ok) return [];
  const baseline = baselineOutcome;

  if (
    baseline.metrics.delayedFlightsCount === 0 &&
    baseline.metrics.crewBreachesCount === 0 &&
    baseline.metrics.brokenConnectionsCount === 0
  ) {
    return [];
  }

  const singlePool = generateSingleActionPool(dataset, baseline);
  const candidatesById = new Map<string, Omit<RecoveryCandidate, 'scoreRank'>>();

  const addIfValid = (actions: RecoveryAction[]) => {
    const id = formatCandidateId(actions);
    if (candidatesById.has(id)) return;
    const outcome = simulateNetwork(dataset, closure, actions);
    if (!outcome.ok) return;
    if (!isMeaningfulImprovement(baseline, outcome)) return;
    candidatesById.set(id, buildCandidateMetadata(baseline, outcome, actions));
  };

  for (const action of singlePool) {
    addIfValid([action]);
  }

  const singleCandidates = Array.from(candidatesById.values());

  // Pair top single candidates with:
  // (a) newly broken connections discovered in that candidate (e.g., SWAP_SPARE + HOLD_CONNECTION)
  // (b) other top single actions when breaches or broken connections remain
  const topSingleSlices = [
    ...singleCandidates
      .slice()
      .sort((a, b) =>
        compareByObjective({ ...a, scoreRank: 0 }, { ...b, scoreRank: 0 }, 'LEGAL_COMPLIANCE'),
      )
      .slice(0, 6),
    ...singleCandidates
      .slice()
      .sort((a, b) =>
        compareByObjective({ ...a, scoreRank: 0 }, { ...b, scoreRank: 0 }, 'PASSENGER_PROTECTION'),
      )
      .slice(0, 4),
  ];

  const uniqueTopSingles = Array.from(
    new Map(topSingleSlices.map((c) => [c.id, c])).values(),
  );

  for (const baseCand of uniqueTopSingles) {
    const baseAction = baseCand.actions[0];
    // Pair with holding any broken connection in the candidate's post-action state
    for (const conn of baseCand.result.connections) {
      if (conn.status === 'BROKEN') {
        addIfValid([baseAction, { type: 'HOLD_CONNECTION', connection_id: conn.connection_id }]);
      }
    }

    // If breaches or broken connections remain, pair with other top single actions
    if (
      baseCand.result.metrics.crewBreachesCount > 0 ||
      baseCand.result.metrics.brokenConnectionsCount > 0
    ) {
      for (const other of uniqueTopSingles) {
        if (other.id === baseCand.id) continue;
        const pair = [baseAction, other.actions[0]].sort((x, y) =>
          formatCandidateId([x]).localeCompare(formatCandidateId([y])),
        );
        addIfValid(pair);
      }
    }
  }

  // Filter out 2-action combos that do NOT strictly improve over their constituent 1-action candidates
  const singleResultMap = new Map(singleCandidates.map((c) => [c.id, c]));
  const allCandidates = Array.from(candidatesById.values()).filter((cand) => {
    if (cand.actions.length === 1) return true;
    const constituentIds = cand.actions.map((a) => formatCandidateId([a]));
    for (const cid of constituentIds) {
      const single = singleResultMap.get(cid);
      if (!single) continue;
      const cm = cand.result.metrics;
      const sm = single.result.metrics;
      const strictlyImprovesSomeMetric =
        cm.crewBreachesCount < sm.crewBreachesCount ||
        cm.brokenConnectionsCount < sm.brokenConnectionsCount ||
        cm.totalStrandedOrAtRiskPax < sm.totalStrandedOrAtRiskPax ||
        cm.totalDelayMinutes < sm.totalDelayMinutes;
      if (!strictlyImprovesSomeMetric) return false;
    }
    return true;
  });

  const ranked = allCandidates
    .map((c) => ({ ...c, scoreRank: 0 }))
    .sort((a, b) => compareByObjective(a, b, objective))
    .slice(0, limit)
    .map((c, index) => ({ ...c, scoreRank: index + 1 }));

  return ranked;
}

export function compareObjectives(
  dataset: FlightNetworkDataset,
  closure: ClosureSpec,
  limitPerProfile = 3,
): Record<ObjectiveProfile, RecoveryCandidate[]> {
  return {
    LEGAL_COMPLIANCE: evaluateRecoveryCandidates(
      dataset,
      closure,
      'LEGAL_COMPLIANCE',
      limitPerProfile,
    ),
    PASSENGER_PROTECTION: evaluateRecoveryCandidates(
      dataset,
      closure,
      'PASSENGER_PROTECTION',
      limitPerProfile,
    ),
    DELAY_MINIMIZATION: evaluateRecoveryCandidates(
      dataset,
      closure,
      'DELAY_MINIMIZATION',
      limitPerProfile,
    ),
  };
}
