import type {
  FlightInspection,
  FlightNetworkDataset,
  SimulationResult,
} from './types.js';

export function inspectFlight(
  simulation: SimulationResult,
  dataset: FlightNetworkDataset,
  flightId: string,
): FlightInspection | null {
  const flight = simulation.flights.find((f) => f.flight_id === flightId);
  if (!flight) return null;

  const tailChain = simulation.flights
    .filter((f) => f.tail_id === flight.tail_id)
    .sort((a, b) => a.leg_order - b.leg_order);

  const activeAssignedChain = simulation.flights
    .filter((f) => !f.cancelled && f.assignedTail === flight.assignedTail)
    .sort((a, b) => a.leg_order - b.leg_order);

  const idx = activeAssignedChain.findIndex((f) => f.flight_id === flightId);
  const previousTailLeg = idx > 0 ? activeAssignedChain[idx - 1] : null;
  const nextTailLeg = idx >= 0 && idx < activeAssignedChain.length - 1 ? activeAssignedChain[idx + 1] : null;

  let turnaroundSlackMin: number | null = null;
  if (!flight.cancelled && previousTailLeg && !flight.isSpareTakeover) {
    turnaroundSlackMin =
      flight.actualDepMin - (previousTailLeg.actualArrMin + dataset.meta.min_turnaround_minutes);
  }

  const incomingConnections = simulation.connections.filter((c) => c.to_flight === flightId);
  const outgoingConnections = simulation.connections.filter((c) => c.from_flight === flightId);
  const crew = simulation.crews.find((c) => c.crew_id === flight.crewId) ?? null;

  return {
    flight,
    previousTailLeg,
    nextTailLeg,
    turnaroundSlackMin,
    incomingConnections,
    outgoingConnections,
    crew,
    tailChain,
  };
}
