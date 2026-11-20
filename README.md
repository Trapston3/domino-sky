# Domino Sky — ATC Disruption Cascade & AI Recovery Console

Domino Sky is a daylight **Flight-Strip Paper** airline operations control simulator and recovery dispatcher built on [`flight_network.json`](flight_network.json) (16 airports, 70 scheduled legs, 21 hub connections, 16 crews, 2 spare aircraft).

## Architecture

- **Frontend:** Vite + React + TypeScript + Tailwind CSS (single-page workspace; `SPLIT`, `CHART`, `STRIP BOARD`, and `AUDIT` views).
- **Pure Deterministic Engine (`src/engine/`):**
  - `simulateNetwork(dataset, closure, actions)` propagates departure holds, arrival ground stops, 30-minute turnaround cascades, fixed-point `HOLD_CONNECTION` holds, connection breaks, crew duty legality (`actualArr`), informational reopening surge utilization, and non-double-counted stranded/at-risk passenger metrics.
  - Typed data module [`src/data/flightNetwork.ts`](src/data/flightNetwork.ts) mirrors `flight_network.json` cleanly for plain Node ESM compatibility on Vercel without `import ... with { type: 'json' }`.
  - Relative imports in `api/`, `src/engine/`, and `src/data/` use explicit `.js` extensions guarded by `tsconfig.api.json` (`NodeNext`).
- **Serverless Backend (`api/dispatch.ts`, `api/ping.ts`):**
  - `api/dispatch.ts` (`export const config = { maxDuration: 30 };`) validates zero-trust client inputs, enforces per-IP rate limiting (20 req/min/IP) and a 300-character question cap, recomputes baseline + recovery states server-side, and queries **GCP Vertex AI (`gemini-3.8-flash`)** via `@google/genai`.
  - **Mode 1 (`brief`):** `thinkingLevel: 'LOW'` on server-computed baseline + candidate JSON.
  - **Mode 2 (`ask`):** `thinkingLevel: 'MEDIUM'` with up to 4 tool-calling rounds (`simulate_custom_actions`, `inspect_flight`, `compare_objectives`), preserving raw `candidate.content` (`thoughtSignature`) and `functionCall.id`.
  - **Automatic Fallback:** Automatically serves a deterministic dispatch briefing/Q&A (`DETERMINISTIC FALLBACK`) whenever Vertex credentials are absent or the API is unavailable.

## Local Development & Verification

```bash
npm install
npm test        # Runs Vitest (11 golden engine assertions + validation + dispatch API tests)
npm run build   # Runs tsc --noEmit, tsc -p tsconfig.api.json --noEmit, and vite build
npm run dev     # Starts Vite dev server with local /api/ping and /api/dispatch middleware
```

## GitHub + Vercel + Vertex AI Setup

1. Push the repository to GitHub (`Trapston3/domino-sky`).
2. Import the repository in Vercel (`Framework Preset: Vite`, `Build Command: npm run build`, `Output Directory: dist`).
3. Configure optional Vertex AI environment variables in **Vercel Project Settings -> Environment Variables** (see [`.env.example`](.env.example)):
   - **Option A (Vertex Express Mode):**
     - `GOOGLE_VERTEX_API_KEY=<your-vertex-express-api-key>`
   - **Option B (GCP Service Account JSON):**
     - `GCP_SERVICE_ACCOUNT_B64=<base64-encoded service account JSON>`
     - `GOOGLE_CLOUD_PROJECT=<your-gcp-project-id>`
     - `GOOGLE_CLOUD_LOCATION=global`
4. Without Vertex credentials configured, the app deploys immediately and runs with deterministic server-side briefings (`DETERMINISTIC FALLBACK`).
