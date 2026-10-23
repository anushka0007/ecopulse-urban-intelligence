# EcoPulse

EcoPulse is a full-stack Bengaluru-area urban waste operations prototype. Locations, readings, vehicle activity, route distance/time and scenario comparisons are synthetic or illustrative. Municipal notifications are recorded in-app only; no SMS or email is sent.

## Architecture

- `src/`: React + Vite interface. Overview, map, route optimizer, What-If Simulator and voice-alert preferences continue to use one validated browser `localStorage` state.
- `shared/risk.js`: deterministic risk score, category thresholds, overflow estimate, action and explanation shared by browser and API.
- `server/`: Express JSON API and Node built-in SQLite persistence for collection requests, request timelines, active vehicle assignments and simulated notification events.
- Vite proxies `/api` to the local Express server during development.

SQLite availability is derived from active (`ASSIGNED` or `DISPATCHED`) requests, so request status and fleet availability stay consistent. Assignment is transactional and protected by a unique partial database index. Completion and cancellation release the vehicle. Cancellation is allowed before completion, including after dispatch; completed/cancelled requests cannot transition again.

## Requirements and startup

Use Node.js 22.13 or newer and npm. Node currently marks its built-in `node:sqlite` module experimental; this avoids a native database dependency.

From `ecopulse-app`, install dependencies once:

```sh
npm install
```

Run the API in one terminal:

```sh
npm run server
```

Run the frontend in another terminal:

```sh
npm run dev
```

Open the local URL printed by Vite. By default, the API listens on port 3001 and creates `server/data/ecopulse.sqlite`. `PORT` and `ECOPULSE_DB_PATH` can override those defaults. With the API unavailable, Dispatch Centre actions fall back to browser storage and show that those changes are browser-only.

## API

All endpoints use the `/api` prefix and JSON responses.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/health` | API and SQLite readiness |
| GET | `/api/zones` | Fixed synthetic zones with calculated risk details |
| GET | `/api/vehicles` | Capacity, availability and active assigned request |
| GET | `/api/requests` | Request snapshots and timestamped event timelines |
| POST | `/api/requests` | Create `NEW` request (`zoneId`, optional numeric `fill` 0–100) |
| POST | `/api/requests/:id/assign` | Assign an available vehicle (`vehicleId`) |
| POST | `/api/requests/:id/dispatch` | Move `ASSIGNED` to `DISPATCHED` |
| POST | `/api/requests/:id/complete` | Move `DISPATCHED` to `COMPLETED` and release vehicle |
| POST | `/api/requests/:id/cancel` | Cancel `NEW`, `ASSIGNED` or `DISPATCHED` request |
| GET | `/api/notifications` | Recent simulated notification events |
| POST | `/api/notifications/simulate` | Record an in-app notification event only |
| POST | `/api/demo/reset` | Clear local demo requests and notification history after explicit confirmation |

The reset endpoint only runs in non-production mode, only for loopback clients, and only with `{ "confirm": true }`. The UI asks for confirmation before resetting browser and local SQLite demo history. It does not reset the fixed synthetic zone/vehicle seed data.

## Risk and route assumptions

Risk score is `min(100, round(fill × 0.68 + min(growth/hour × 7, 25) + max(0, fill − 70) × 0.18))`. Categories are Low 0–39, Moderate 40–64, High 65–79 and Critical 80–100. Time to overflow is `(100 − fill) ÷ growth/hour`, clamped to zero. Explanations report the score contributions and category-based recommendation; this is transparent rule-based logic, not machine learning.

Route optimization uses Haversine straight-line distance, nearest-neighbour ordering with a short 2-opt improvement, synthetic loads and configured vehicle capacity/stop limits. It is not road navigation and has no live traffic input. Simulator comparisons are illustrative and are not measured savings or validated outcomes.

## Verification

```sh
npm run test:server
npm run build
```

Tests use temporary SQLite databases; the persistent local database is not modified by the test suite.

## Limitations

No sensor feed, live municipal data, road graph, traffic model, external notification, production authentication or deployment configuration is included. Server request history is persisted in SQLite; risk readings, route settings/results, simulator controls and voice preferences remain in browser storage. Do not expose this demo API to untrusted networks.
