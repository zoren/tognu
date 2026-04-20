an app that shows train schedules for S-trains

## Setup

1. Copy `.env.example` to `.env` and fill in the Azure Service Bus credentials.
2. `npm install`

## Develop

Run the backend and the Vite dev server side by side:

```
npm run dev
```

- Backend (SIRI subscriber + HTTP/SSE) listens on http://localhost:8080
- Vite dev server with HMR on http://localhost:5173 (proxies `/api` → :8080)

## Production

```
npm run build   # bundle the frontend into dist/
npm start       # run the backend; it serves dist/ and the API
```

Then open http://localhost:8080.
