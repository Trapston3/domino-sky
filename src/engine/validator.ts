import { isValidTimeString, parseTimeToMinutes } from './time.js';
import type {
  ActionValidationResult,
  ClosureSpec,
  FlightNetworkDataset,
  FlightRecord,
  RecoveryAction,
  ValidationErrorCode,
} from './types.js';

export function validateClosure(
  dataset: FlightNetworkDataset,
  closure: ClosureSpec,
): ActionValidationResult {
  if (closure === null) {
    return { ok: true };
  }
  if (!closure || typeof closure !== 'object') {
    return { ok: false, code: 'INVALID_CLOSURE', reason: 'Closure must be null or an object.' };
  }
  const airportSet = new Set(dataset.airports.map((a) => a.id));
  if (!airportSet.has(closure.airport)) {
    return {
      ok: false,
      code: 'INVALID_CLOSURE',
      reason: `Unknown airport "${String(closure.airport)}". Valid airports: ${Array.from(airportSet).join(', ')}.`,
    };
  }
  if (!isValidTimeString(closure.start) || !isValidTimeString(closure.end)) {
    return {
      ok: false,
      code: 'INVALID_CLOSURE',
      reason: 'Closure start and end must be valid 24-hour HH:MM strings.',
    };
  }
  const startMin = parseTimeToMinutes(closure.start);
  const endMin = parseTimeToMinutes(closure.end);
  if (startMin >= endMin) {
    return {
      ok: false,
      code: 'INVALID_CLOSURE',
      reason: `Closure start (${closure.start}) must be strictly earlier than closure end (${closure.end}).`,
    };
  }
  return { ok: true };
}

export function validateActions(
  dataset: FlightNetworkDataset,
  actions: RecoveryAction[],
): ActionValidationResult {
  if (!Array.isArray(actions)) {
    return { ok: false, code: 'INVALID_ACTION', reason: 'Actions must be an array.' };
  }

  const flightsById = new Map<string, FlightRecord>();
  const byTail = new Map<string, FlightRecord[]>();
  for (const flight of dataset.flights) {
    flightsById.set(flight.flight_id, flight);
    const list = byTail.get(flight.tail_id) ?? [];
    list.push(flight);
    byTail.set(flight.tail_id, list);
  }
  for (const chain of byTail.values()) {
    chain.sort((a, b) => a.leg_order - b.leg_order);
  }

  const sparesById = new Map(dataset.spare_aircraft.map((s) => [s.tail_id, s]));
  const connsById = new Map(dataset.connections.map((c) => [c.connection_id, c]));

  const usedSpares = new Set<string>();
  const swappedFlightIds = new Set<string>();
  const cancelledIds = new Set<string>();
  const heldConnIds = new Set<string>();

  for (const action of actions) {
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
      return { ok: false, code: 'INVALID_ACTION', reason: 'Malformed recovery action object.' };
    }

    switch (action.type) {
      case 'SWAP_SPARE': {
        const spare = sparesById.get(action.spare_tail_id);
        if (!spare) {
          return {
            ok: false,
            code: 'SPARE_NOT_FOUND',
            reason: `Spare aircraft "${String(action.spare_tail_id)}" does not exist. Available spares: ${dataset.spare_aircraft.map((s) => `${s.tail_id} (${s.base})`).join(', ')}.`,
          };
        }
        if (usedSpares.has(spare.tail_id)) {
          return {
            ok: false,
            code: 'SPARE_ALREADY_USED',
            reason: `Spare aircraft ${spare.tail_id} can only be assigned once per recovery plan.`,
          };
        }
        const flight = flightsById.get(action.flight_id);
        if (!flight) {
          return {
            ok: false,
            code: 'FLIGHT_NOT_FOUND',
            reason: `Flight "${String(action.flight_id)}" was not found in the schedule.`,
          };
        }
        if (flight.origin !== spare.base) {
          return {
            ok: false,
            code: 'SPARE_WRONG_HUB',
            reason: `Spare ${spare.tail_id} is positioned at ${spare.base} and cannot take over ${flight.flight_id} departing from ${flight.origin} without teleporting aircraft.`,
          };
        }
        if (swappedFlightIds.has(flight.flight_id)) {
          return {
            ok: false,
            code: 'CONFLICTING_ACTIONS',
            reason: `Flight ${flight.flight_id} already has a spare takeover assigned.`,
          };
        }
        usedSpares.add(spare.tail_id);
        swappedFlightIds.add(flight.flight_id);
        break;
      }

      case 'CANCEL_TAIL_END': {
        const flight = flightsById.get(action.flight_id);
        if (!flight) {
          return {
            ok: false,
            code: 'FLIGHT_NOT_FOUND',
            reason: `Flight "${String(action.flight_id)}" was not found in the schedule.`,
          };
        }
        const chain = byTail.get(flight.tail_id) ?? [];
        const tailEndLegs = chain.filter((leg) => leg.leg_order >= flight.leg_order);
        const allAlreadyCancelled = tailEndLegs.every((leg) => cancelledIds.has(leg.flight_id));
        if (allAlreadyCancelled) {
          return {
            ok: false,
            code: 'CONFLICTING_ACTIONS',
            reason: `Tail-end cancellation from ${flight.flight_id} on ${flight.tail_id} overlaps with an already cancelled segment.`,
          };
        }
        for (const leg of tailEndLegs) {
          cancelledIds.add(leg.flight_id);
        }
        break;
      }

      case 'CANCEL_LOOP': {
        if (!Array.isArray(action.flight_ids) || action.flight_ids.length === 0) {
          return {
            ok: false,
            code: 'INVALID_ACTION',
            reason: 'CANCEL_LOOP requires a non-empty list of flight_ids.',
          };
        }
        const uniqueIds = new Set(action.flight_ids);
        if (uniqueIds.size !== action.flight_ids.length) {
          return {
            ok: false,
            code: 'CONFLICTING_ACTIONS',
            reason: 'CANCEL_LOOP flight_ids must not contain duplicates.',
          };
        }
        const legs: FlightRecord[] = [];
        for (const fid of action.flight_ids) {
          const leg = flightsById.get(fid);
          if (!leg) {
            return {
              ok: false,
              code: 'FLIGHT_NOT_FOUND',
              reason: `Flight "${String(fid)}" in CANCEL_LOOP was not found in the schedule.`,
            };
          }
          legs.push(leg);
        }
        const tailId = legs[0].tail_id;
        if (legs.some((leg) => leg.tail_id !== tailId)) {
          return {
            ok: false,
            code: 'BREAKS_AIRCRAFT_CONTINUITY',
            reason: `CANCEL_LOOP flights must belong to the same tail; got multiple tails (${Array.from(new Set(legs.map((l) => l.tail_id))).join(', ')}).`,
          };
        }
        const sorted = [...legs].sort((a, b) => a.leg_order - b.leg_order);
        for (let i = 1; i < sorted.length; i += 1) {
          if (sorted[i].leg_order !== sorted[i - 1].leg_order + 1) {
            return {
              ok: false,
              code: 'BREAKS_AIRCRAFT_CONTINUITY',
              reason: `CANCEL_LOOP flights must be contiguous in leg_order on ${tailId}; gap between ${sorted[i - 1].flight_id} (leg ${sorted[i - 1].leg_order}) and ${sorted[i].flight_id} (leg ${sorted[i].leg_order}).`,
            };
          }
        }
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        if (first.origin !== last.destination) {
          return {
            ok: false,
            code: 'BREAKS_AIRCRAFT_CONTINUITY',
            reason: `Cancelling ${sorted.map((l) => l.flight_id).join(' + ')} breaks aircraft continuity: starts at ${first.origin} and ends at ${last.destination}, which strands ${tailId} away from its downstream rotation.`,
          };
        }
        for (const leg of sorted) {
          if (cancelledIds.has(leg.flight_id)) {
            return {
              ok: false,
              code: 'CONFLICTING_ACTIONS',
              reason: `Flight ${leg.flight_id} is already cancelled by an earlier action.`,
            };
          }
        }
        for (const leg of sorted) {
          cancelledIds.add(leg.flight_id);
        }
        break;
      }

      case 'HOLD_CONNECTION': {
        const conn = connsById.get(action.connection_id);
        if (!conn) {
          return {
            ok: false,
            code: 'CONNECTION_NOT_FOUND',
            reason: `Connection "${String(action.connection_id)}" was not found.`,
          };
        }
        if (heldConnIds.has(conn.connection_id)) {
          return {
            ok: false,
            code: 'CONFLICTING_ACTIONS',
            reason: `Connection ${conn.connection_id} is already held.`,
          };
        }
        heldConnIds.add(conn.connection_id);
        break;
      }

      default:
        return {
          ok: false,
          code: 'INVALID_ACTION',
          reason: `Unsupported recovery action type "${String((action as { type?: unknown }).type)}".`,
        };
    }
  }

  // Cross-action consistency checks regardless of action ordering
  for (const swappedId of swappedFlightIds) {
    if (cancelledIds.has(swappedId)) {
      return {
        ok: false,
        code: 'CONFLICTING_ACTIONS',
        reason: `Cannot assign a spare swap to cancelled flight ${swappedId}.`,
      };
    }
  }
  for (const connId of heldConnIds) {
    const conn = connsById.get(connId)!;
    if (cancelledIds.has(conn.from_flight) || cancelledIds.has(conn.to_flight)) {
      return {
        ok: false,
        code: 'CONFLICTING_ACTIONS',
        reason: `Cannot hold connection ${conn.connection_id} (${conn.from_flight} -> ${conn.to_flight}) because one of its flights is cancelled.`,
      };
    }
  }

  return { ok: true };
}

export function parseAndValidateRawActions(
  dataset: FlightNetworkDataset,
  raw: unknown,
): { ok: true; actions: RecoveryAction[] } | { ok: false; code: ValidationErrorCode; reason: string } {
  if (raw === undefined) {
    return { ok: true, actions: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'INVALID_ACTION', reason: 'actions must be an array.' };
  }
  if (raw.length > 6) {
    return { ok: false, code: 'INVALID_ACTION', reason: 'A maximum of 6 recovery actions can be stacked per request.' };
  }

  const parsed: RecoveryAction[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      return { ok: false, code: 'INVALID_ACTION', reason: 'Each action must be an object.' };
    }
    const rec = item as Record<string, unknown>;
    if (rec.type === 'SWAP_SPARE') {
      if (typeof rec.spare_tail_id !== 'string' || typeof rec.flight_id !== 'string') {
        return { ok: false, code: 'INVALID_ACTION', reason: 'SWAP_SPARE requires string spare_tail_id and flight_id.' };
      }
      parsed.push({ type: 'SWAP_SPARE', spare_tail_id: rec.spare_tail_id, flight_id: rec.flight_id });
    } else if (rec.type === 'CANCEL_TAIL_END') {
      if (typeof rec.flight_id !== 'string') {
        return { ok: false, code: 'INVALID_ACTION', reason: 'CANCEL_TAIL_END requires string flight_id.' };
      }
      parsed.push({ type: 'CANCEL_TAIL_END', flight_id: rec.flight_id });
    } else if (rec.type === 'CANCEL_LOOP') {
      if (!Array.isArray(rec.flight_ids) || !rec.flight_ids.every((id) => typeof id === 'string')) {
        return { ok: false, code: 'INVALID_ACTION', reason: 'CANCEL_LOOP requires an array of string flight_ids.' };
      }
      parsed.push({ type: 'CANCEL_LOOP', flight_ids: rec.flight_ids });
    } else if (rec.type === 'HOLD_CONNECTION') {
      if (typeof rec.connection_id !== 'string') {
        return { ok: false, code: 'INVALID_ACTION', reason: 'HOLD_CONNECTION requires string connection_id.' };
      }
      parsed.push({ type: 'HOLD_CONNECTION', connection_id: rec.connection_id });
    } else {
      return {
        ok: false,
        code: 'INVALID_ACTION',
        reason: `Unknown action type "${String(rec.type)}". Allowed: SWAP_SPARE, CANCEL_TAIL_END, CANCEL_LOOP, HOLD_CONNECTION.`,
      };
    }
  }

  const validation = validateActions(dataset, parsed);
  if (!validation.ok) {
    return validation;
  }
  return { ok: true, actions: parsed };
}
