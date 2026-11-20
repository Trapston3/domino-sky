import type { VercelRequest, VercelResponse } from '@vercel/node';
import { flightNetwork } from '../src/data/flightNetwork.js';
import { simulateNetwork } from '../src/engine/index.js';

export const config = { maxDuration: 10 };

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  const outcome = simulateNetwork(
    flightNetwork,
    { airport: 'DEL', start: '12:00', end: '13:30' },
    [],
  );

  if (!outcome.ok) {
    res.status(500).json({ ok: false, error: outcome.reason });
    return;
  }

  res.status(200).json({
    ok: true,
    service: 'domino-sky-api',
    timestamp: new Date().toISOString(),
    smokeCheck: {
      closure: outcome.closure,
      delayedFlightsCount: outcome.metrics.delayedFlightsCount,
      totalDelayMinutes: outcome.metrics.totalDelayMinutes,
      brokenConnectionsCount: outcome.metrics.brokenConnectionsCount,
      crewBreachesCount: outcome.metrics.crewBreachesCount,
    },
  });
}
