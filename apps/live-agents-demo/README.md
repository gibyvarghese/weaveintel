# @weaveintel/live-agents-demo

Reference application for `@weaveintel/live-agents` with a minimal HTTP API, worker entrypoint, and pluggable state persistence.

## Run locally

```bash
npm run dev -w @weaveintel/live-agents-demo
```

The server starts on `http://localhost:3600` by default.

**Web UI:** Open `http://localhost:3600/ui` in your browser for an interactive interface to test the API.

## Optional Postgres mode

Set `LIVE_AGENTS_DEMO_DATABASE_URL` to enable Postgres-backed persistence.

```bash
LIVE_AGENTS_DEMO_DATABASE_URL=postgres://localhost:5432/live_agents_demo npm run dev -w @weaveintel/live-agents-demo
```

## Worker

Run a single heartbeat processing pass:

```bash
npm run worker -w @weaveintel/live-agents-demo
```

## API routes

- `GET /` — service metadata and endpoint list
- `GET /health` — health check
- `GET /ui` — interactive web UI
- `POST /api/meshes` — create mesh
- `POST /api/agents` — create agent
- `POST /api/contracts` — create contract
- `POST /api/accounts` — create account
- `POST /api/account-bindings` — bind account to agent
- `POST /api/messages` — send message to agent
- `POST /api/heartbeat/ticks` — schedule heartbeat tick
- `POST /api/heartbeat/run-once` — process one heartbeat pass
- `GET /api/agents/:agentId/inbox` — retrieve agent's inbox

## Quick test

Run the end-to-end example:

```bash
npx tsx examples/58-live-agents-demo-e2e.ts
```

Or use the web UI at `http://localhost:3600/ui`.
