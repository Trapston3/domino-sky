# Domino Sky — ATC Disruption Cascade & AI Recovery Console

Domino Sky is a daylight **Flight-Strip Paper** airline operations control simulator and AI-assisted recovery dispatcher operating on [`flight_network.json`](flight_network.json) (16 Indian airports, 70 scheduled legs, 21 hub connections, 16 flight crews, and 2 spare aircraft).

---

## 1. Chosen Vertical

**Aviation & Airline Operations Control (Irregular Operations / IROPS Recovery).**
When an airport closes due to a NOTAM (weather, runway inspection, or airspace restriction), delays do not remain isolated to the closed station: they domino across aircraft tail rotations, break hub passenger connections, trigger reopening capacity surges, and push flight crews past legal Flight Duty Time Limitations (FDTL). Domino Sky lets dispatchers trace exact causal cascades and evaluate physically valid recovery interventions with transparent trade-offs.

---

## 2. Approach & Logic

### Deterministic Cascade Engine (`src/engine/`)
All simulation math is isolated in pure, side-effect-free TypeScript (`simulateNetwork(dataset, closure, actions)`) shared across the browser UI, Vitest suite, and Vercel serverless routes:
- **Delay Propagation & Turnaround Rules:** Processes each aircraft tail chain in ascending `leg_order` to a fixed point (supporting downstream `HOLD_CONNECTION` loops), enforcing `meta.min_turnaround_minutes` (`30m`), departure gate holds inside `[closureStart, closureEnd)`, and arrival ground stops at origin when tentative arrival lands inside the closure window. Post-midnight rollover times format as `HH:MM (+1)`.
- **Connections & Crew Duty Legality:** Connections succeed iff neither leg is cancelled and `to_flight.actualDep - from_flight.actualArr >= min_connect_minutes`. Crew duty is evaluated against **`actualArr`** of each crew's last operated non-cancelled flight (`dutyMins > max_duty_mins` of `600m` flags the crew `BREACHED` and marks violating legs `CREW_BREACH`).
- **Non-Double-Counted Stranded / At-Risk Pax:** Reports a headline total broken into three transparent buckets (`Missed Connection Pax`, `Cancelled Flight Pax`, and `Crew-Breach At-Risk Pax`), deduplicating any overlap if a broken connection touches a `CREW_BREACH` leg.
- **Physically Valid Recovery Actions (Zero Teleportation):** Rejects invalid operations with structured codes (`SPARE_ALREADY_USED`, `SPARE_WRONG_HUB`, `BREAKS_AIRCRAFT_CONTINUITY`, `FLIGHT_NOT_FOUND`, `CONNECTION_NOT_FOUND`, `CONFLICTING_ACTIONS`):
  - `SWAP_SPARE` (`VT-DS17` at `BLR`, `VT-DS18` at `DEL`, available `05:00`, allowed during closures at its base).
  - `CANCEL_TAIL_END` (cancels final `1..k` legs of a tail).
  - `CANCEL_LOOP` (cancels a contiguous closed loop where `first.origin === last.destination`).
  - `HOLD_CONNECTION` (holds `to_flight` to `from_flight.actualArr + min_connect_minutes`, propagating downstream).
- **3-Objective Trade-Off Optimizer:** Ranks single and non-conflicting 2-action recovery plans live across `LEGAL_COMPLIANCE`, `PASSENGER_PROTECTION`, and `DELAY_MINIMIZATION`, explicitly surfacing negative side effects (e.g. `VT-DS17 -> DS0802` clearing `CR08` while advancing `DS0803` and breaking `CX17`).

### Zero-Trust Vertex AI Agent (`api/dispatch.ts`)
- **Zero-Trust Architecture:** The client sends ONLY `{ mode, closure, actions, objective, question? }`. `api/dispatch.ts` validates inputs against strict enums/schemas, enforces per-IP sliding-window rate limiting (`20 req/min/IP`), caps `question` at `300` characters, and recomputes all baseline, recovery, and candidate states server-side.
- **Gemini 3.8 Flash (`@google/genai`) + Automatic Fallback:**
  - `mode: "brief"` uses `thinkingConfig: { thinkingLevel: 'LOW' }` on server-computed JSON; deterministic KPI tables are rendered strictly from server JSON, never parsed from prose.
  - `mode: "ask"` uses `thinkingConfig: { thinkingLevel: 'MEDIUM' }` with a hard cap of **4 tool-calling rounds** wired to `simulate_custom_actions`, `inspect_flight`, and `compare_objectives`, preserving raw `candidate.content` (`thoughtSignature`) and echoing `functionCall.id`.
  - When no Vertex AI credentials are present (or an API error occurs), `api/dispatch.ts` seamlessly returns grounded deterministic briefings and tool-backed Q&A labeled `DETERMINISTIC FALLBACK`.

---

## 3. How the Solution Works

- **Flight-Strip Paper UI (`src/components/`):**
  - **Top Control Bar:** Select any of the 16 airports, drag `06:00–22:00` closure sliders, trigger 4 disruption presets (`BOM 07:30–09:00`, `DEL 12:00–13:30`, `BLR 13:00–14:30`, `CCU 16:00–17:30`) or `NOMINAL`, inspect the informational Reopening Surge capacity utilization badge, and switch between `SPLIT`, `CHART`, `STRIP BOARD`, and `AUDIT` views.
  - **Before/After KPI Strip:** Live metrics, hover-preview deltas, 3-part stranded passenger breakdown, and explicit policy/assumption notices.
  - **Schematic Ink Airspace Chart (`AirspaceChart.tsx`):** Accurate `lat`/`lng` cosine-corrected aviation graticule with hub tier glyphs, hatched `NOTAM CLOSED` marker, delay-encoded sector strokes, and synchronized `06:00–23:30` IST playback (`Play/Pause`, `1x/2x/5x`).
  - **ATC Tail-Chain Strip Board (`StripBoard.tsx`):** Perforated tail-progress strips with scheduled ghost outlines, shifted/recovery bars, crew duty badges, and synchronized playback cursor.
  - **Root-Cause Trace Drawer & Audit Tables:** Click any flight bar, aircraft pip, or chip to trace its exact propagation chain (`rootCauseFlightId` -> `causeChain`) and turnaround/connection/crew margins.
  - **AI Dispatcher Console (`DispatcherPanel.tsx`):** Objective switcher, server-verified Before/After table, hover-to-preview ranked recovery cards with `+ STACK` support, and 300-char Q&A console.
- **Node ESM Compatibility:** `src/data/flightNetwork.ts` exposes the exact typed contents of `flight_network.json`, and all relative imports reachable from `api/` use explicit `.js` extensions verified by `tsconfig.api.json` (`NodeNext`).

---

## 4. Assumptions Made

| Area | Assumption | Rationale & UI Disclosure |
| --- | --- | --- |
| **Crew Duty Evaluation** | Evaluated against **`actualArr`** of the crew's last operated non-cancelled flight (rather than scheduled arrival in dataset notes). | Under a literal scheduled-arrival check, operational delays could never cause FDTL breaches. Disclosed explicitly in UI footnote: *"Crew duty evaluated against actual arrival times."* |
| **Standby Crew Clock** | A spare takeover (`VT-DS17` / `VT-DS18`) is operated by a fresh standby hub crew whose 600-minute duty clock starts **45 minutes prior to the swap leg's `actualDep`**. | `flight_network.json` lists no standby crews. Disclosed in UI standby assumption banners, crew audit table `(ASSUMED)`, and recovery cards. |
| **Reopening Surge** | Informational utilization metric (`ops in [closureEnd, closureEnd + 60) / airport.capacity_per_hour`) only. | Surfaces post-closure runway saturation without altering the deterministic golden delay math. |
| **Stranded Pax Deduplication** | Headline total equals `Missed Conn Pax + Cancelled Pax + Crew-Breach At-Risk Pax - overlap` (where a broken connection touches a `CREW_BREACH` leg). | Prevents double-counting the same passengers across cancellation, missed connection, and crew-breach categories. |
| **Closure & Spare Interaction** | Swapping a spare onto a leg departing during its hub closure is permitted and held until `closureEnd`. | Mirrors real hub operations where a tail swap resolves upstream aircraft/crew scarcity while respecting the active runway closure. |
| **Stateless Rate Limiting** | Per-IP `20 req/min` rate limiting in `api/dispatch.ts` uses an in-memory bounded sliding window (`MAX_TRACKED_IPS = 1000`). | Best-effort serverless protection suitable for stateless deployments without external Redis dependencies. |

---

## 5. Local Setup, Testing & Deployment

### Prerequisites & Commands
```bash
npm install
npm test        # Runs Vitest: 11 golden assertions + continuity/validation + /api/dispatch & /api/ping tests
npm run build   # Runs tsc --noEmit, tsc -p tsconfig.api.json --noEmit, and vite build
npm run dev     # Starts Vite dev server with local /api/ping and /api/dispatch middleware
```

### GitHub + Vercel + Vertex AI Configuration
1. Push repository to GitHub on `main`.
2. Import into Vercel (`Framework Preset: Vite`, `Build Command: npm run build`, `Output Directory: dist`).
3. Configure optional Vertex AI environment variables (see [`.env.example`](.env.example)):
   - **Option 1 (Vertex Express Mode):** `GOOGLE_VERTEX_API_KEY=<key>`
   - **Option 2 (GCP Service Account):** `GCP_SERVICE_ACCOUNT_B64=<base64 JSON>`, `GOOGLE_CLOUD_PROJECT=<project>`, `GOOGLE_CLOUD_LOCATION=global`
4. Without Vertex credentials, `/api/dispatch` operates seamlessly in `DETERMINISTIC FALLBACK` mode using the server-side simulation and tool engine.
