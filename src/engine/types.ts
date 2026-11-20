export type AirportTier = 'mega_hub' | 'regional_hub' | 'spoke';

export interface NetworkMeta {
  dataset: string;
  operating_day: string;
  min_turnaround_minutes: number;
  seats_per_aircraft: number;
  notes: string[];
}

export interface Airport {
  id: string;
  name: string;
  city: string;
  lat: number;
  lng: number;
  tier: AirportTier;
  capacity_per_hour: number;
}

export interface FlightRecord {
  flight_id: string;
  tail_id: string;
  leg_order: number;
  origin: string;
  destination: string;
  dep: string;
  arr: string;
  block_minutes: number;
  pax: number;
  turnaround_before_min: number | null;
}

export interface ConnectionRecord {
  connection_id: string;
  airport: string;
  from_flight: string;
  to_flight: string;
  passengers: number;
  min_connect_minutes: number;
}

export interface CrewRecord {
  crew_id: string;
  tail_id: string;
  base: string;
  duty_start: string;
  max_duty_mins: number;
  flight_ids: string[];
}

export interface SpareAircraftRecord {
  tail_id: string;
  base: string;
  available_from: string;
  seats: number;
}

export interface FlightNetworkDataset {
  meta: NetworkMeta;
  airports: Airport[];
  flights: FlightRecord[];
  connections: ConnectionRecord[];
  crews: CrewRecord[];
  spare_aircraft: SpareAircraftRecord[];
}

export type ClosureSpec = {
  airport: string;
  start: string;
  end: string;
} | null;

export type RecoveryAction =
  | {
      type: 'SWAP_SPARE';
      spare_tail_id: string;
      flight_id: string;
    }
  | {
      type: 'CANCEL_TAIL_END';
      flight_id: string;
    }
  | {
      type: 'CANCEL_LOOP';
      flight_ids: string[];
    }
  | {
      type: 'HOLD_CONNECTION';
      connection_id: string;
    };

export type ObjectiveProfile =
  | 'LEGAL_COMPLIANCE'
  | 'PASSENGER_PROTECTION'
  | 'DELAY_MINIMIZATION';

export type ValidationErrorCode =
  | 'FLIGHT_NOT_FOUND'
  | 'SPARE_NOT_FOUND'
  | 'SPARE_ALREADY_USED'
  | 'SPARE_WRONG_HUB'
  | 'BREAKS_AIRCRAFT_CONTINUITY'
  | 'CONNECTION_NOT_FOUND'
  | 'CONFLICTING_ACTIONS'
  | 'INVALID_ACTION'
  | 'INVALID_CLOSURE';

export type ActionValidationResult =
  | { ok: true }
  | { ok: false; code: ValidationErrorCode; reason: string };

export interface CauseStep {
  kind: 'CLOSURE_DEP' | 'CLOSURE_ARR' | 'TURNAROUND' | 'HOLD_CONNECTION' | 'SPARE_AVAIL';
  flightId: string;
  tailId: string;
  description: string;
  addedDelayMin: number;
  fromTimeMin: number;
  toTimeMin: number;
  sourceFlightId?: string;
  connectionId?: string;
}

export type SimulatedFlightStatus = 'ON_TIME' | 'DELAYED' | 'CANCELLED' | 'CREW_BREACH';

export interface SimulatedFlight extends FlightRecord {
  scheduledDepMin: number;
  scheduledArrMin: number;
  actualDepMin: number;
  actualArrMin: number;
  actualDep: string;
  actualArr: string;
  delayMin: number;
  turnaroundDelayMin: number;
  holdDelayMin: number;
  closureDelayMin: number;
  cancelled: boolean;
  cancelledBy?: 'CANCEL_TAIL_END' | 'CANCEL_LOOP';
  assignedTail: string;
  isSpareTakeover: boolean;
  spareTailId: string | null;
  crewId: string;
  isStandbyCrew: boolean;
  crewBreach: boolean;
  rootCauseFlightId: string | null;
  causeChain: CauseStep[];
  status: SimulatedFlightStatus;
}

export interface SimulatedConnection extends ConnectionRecord {
  fromArrMin: number | null;
  toDepMin: number | null;
  connectMinutes: number | null;
  slackMinutes: number | null;
  status: 'MADE' | 'BROKEN' | 'CANCELLED';
  held: boolean;
}

export interface SimulatedCrew extends CrewRecord {
  dutyStartMin: number;
  operatedFlightIds: string[];
  lastOperatedFlightId: string | null;
  lastArrMin: number | null;
  dutyMins: number;
  marginMin: number;
  overageMin: number;
  breached: boolean;
  isStandby: boolean;
  modelingAssumptionNote?: string;
}

export interface ReopeningSurgeMetrics {
  airport: string;
  windowStart: string;
  windowEnd: string;
  windowStartMin: number;
  windowEndMin: number;
  operationsCount: number;
  departuresCount: number;
  arrivalsCount: number;
  capacityPerHour: number;
  utilizationPct: number;
}

export interface SimulationMetrics {
  totalFlights: number;
  operatedFlights: number;
  delayedFlightsCount: number;
  cancelledFlightsCount: number;
  totalDelayMinutes: number;
  maxFlightDelayMinutes: number;
  totalConnections: number;
  madeConnectionsCount: number;
  brokenConnectionsCount: number;
  cancelledConnectionsCount: number;
  crewBreachesCount: number;
  totalCrewOverageMinutes: number;
  missedConnectionPax: number;
  cancelledFlightPax: number;
  crewBreachAtRiskPax: number;
  paxOverlapDeduction: number;
  totalStrandedOrAtRiskPax: number;
}

export interface SimulationResult {
  ok: true;
  closure: ClosureSpec;
  actions: RecoveryAction[];
  flights: SimulatedFlight[];
  connections: SimulatedConnection[];
  crews: SimulatedCrew[];
  metrics: SimulationMetrics;
  reopeningSurge: ReopeningSurgeMetrics | null;
  standbyAssumptionsUsed: boolean;
}

export interface SimulationErrorResult {
  ok: false;
  code: ValidationErrorCode;
  reason: string;
}

export type SimulationOutcome = SimulationResult | SimulationErrorResult;

export interface RecoveryCandidate {
  id: string;
  label: string;
  actions: RecoveryAction[];
  result: SimulationResult;
  deltas: {
    delayedFlights: number;
    totalDelayMinutes: number;
    brokenConnections: number;
    crewBreaches: number;
    strandedOrAtRiskPax: number;
    cancelledPax: number;
  };
  positives: string[];
  tradeOffWarnings: string[];
  usesStandbyAssumption: boolean;
  scoreRank: number;
}

export interface FlightInspection {
  flight: SimulatedFlight;
  previousTailLeg: SimulatedFlight | null;
  nextTailLeg: SimulatedFlight | null;
  turnaroundSlackMin: number | null;
  incomingConnections: SimulatedConnection[];
  outgoingConnections: SimulatedConnection[];
  crew: SimulatedCrew | null;
  tailChain: SimulatedFlight[];
}
