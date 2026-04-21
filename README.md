an app that shows train schedules for S-trains

## Architecture

Two long-running processes share a SQLite file (`tognu.db`):

- **`ingest.js`** — subscribes to the SIRI Service Bus topic and upserts each
  parsed `EstimatedVehicleJourney` (verbatim, as JSON) into the `journeys`
  table, keyed by `(line, train_number, journey_key)`. Past journeys are
  pruned by `latest_time`; later updates for the same key replace the row.
- **`index.js`** — HTTP server that serves the built frontend and exposes
  `/api/stations`, `/api/state`, and `/api/stream`. It only reads from the
  SQLite file: every poll it loads the journeys, projects each call to a
  departure shape, and pushes SSE diffs. All display fields are derived at
  read time, so changing what's shown doesn't require fresh ingest data.

The frontend (`src/main.js`) lets you search any station and stack favorites
on a single screen. Favorites are stored in `localStorage`.

## Setup

1. Copy `.env.example` to `.env` and fill in the Azure Service Bus credentials.
2. `npm install`

## Develop

```
npm run dev
```

Runs the server, the ingest worker, and the Vite dev server side by side:

- Backend (HTTP/SSE) on http://localhost:8080
- Vite dev server with HMR on http://localhost:5173 (proxies `/api` → :8080)
- Ingest worker writes to `./tognu.db`

## Production

```
npm run build      # bundle the frontend into dist/
npm start          # serve dist/ + API (reads tognu.db)
npm run ingest     # populate tognu.db from the SIRI feed
```

`deploy.mjs` runs both `tognu` (server) and `tognu-ingest` (worker) under pm2.
