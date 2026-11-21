# SmartRoute — On-Demand Delivery with Dynamic Route Optimization

A CS capstone research prototype that compares FIFO routing against a precedence-aware Nearest Neighbor + 2-Opt heuristic, visualizes delivery stops on OpenStreetMap, supports Socket.io rider updates, and persists benchmark trials in PostgreSQL.

## Features
- Customer demo portal: pickup/drop pin selection, Nominatim address search, priority/fare estimate, order creation.
- Rider demo: optimized stop queue, status changes, GPS watch mode, polyline movement simulation.
- Admin/research: KPI summary, route overlays, batch experiments (10/25/50), charts, CSV export.
- Backend: Express, Socket.io, Prisma, PostgreSQL, OSRM routing/table with Haversine fallback.
- Five sample orders seeded on first database boot.

## Stack
React + Vite + Tailwind + Leaflet + Recharts; Node + Express + Socket.io; Prisma/PostgreSQL; OSRM and Nominatim (public endpoints).

## Quick start
Prerequisites: Node.js 20+, npm, and PostgreSQL 14+.

1. Copy `.env.example` to `.env` at repository root and set `DATABASE_URL`.
2. Install dependencies: `npm install`.
3. Generate Prisma client and create schema: `npm run prisma:generate --workspace server && npm run db:push --workspace server`.
4. Seed demo rows: `npm run db:seed --workspace server`.
5. Run both apps: `npm run dev`.
6. Frontend: http://localhost:5173. API: http://localhost:4000/api/health.


The Vite dev proxy forwards `/api` and `/socket.io` to port 4000. Set `client/.env.local` to `VITE_API_URL=https://your-backend.example` when deploying frontend and backend separately. When frontend and API share an origin, leave it blank to use relative paths.


## Environment
Backend `.env`:
```
PORT=4000
DATABASE_URL=postgresql://user:password@localhost:5432/smartroute?schema=public
CLIENT_URL=http://localhost:5173
OSRM_BASE=https://router.project-osrm.org
NOMINATIM_BASE=https://nominatim.openstreetmap.org
```
Client `client/.env.local`:
```
VITE_API_URL=https://your-backend.example
```

## API
- `GET /api/health`
- `GET /api/orders`
- `POST /api/orders`
- `PATCH /api/orders/:id/status`
- `GET /api/riders`
- `PATCH /api/riders/:id/location`
- `GET /api/routes`
- `GET /api/geocode?q=...`
- `GET /api/benchmark`
- `POST /api/benchmark` with `{ "size": 10|25|50, "seed": optional }`
- `GET /api/benchmark.csv`
- `POST /api/reset`

Socket.io events:
- `connection:ready`
- `rider:location` (client-to-server and server broadcast)
- `orders:update`
- `routes:update`

## Algorithms
FIFO follows stop insertion order. Optimized routing uses a precedence-aware greedy nearest-neighbor construction (pickup stops are initially eligible; a drop-off becomes eligible only after its pickup), then a 2-Opt local search. The 2-Opt candidate is accepted only if pickup/drop precedence is maintained. Express stops receive a priority bias in the greedy candidate ordering.

Distances/durations are requested from OSRM's public Table API. If the call fails, the optimizer uses a cached Haversine-based approximation with a road detour factor. OSRM public endpoints are community infrastructure, not an SLA-backed service; large benchmark batches may fall back. Please avoid heavy or bursty production traffic to public endpoints.

## Academic experiment notes
The benchmark stores a seed and compares algorithms on the same randomized stop set within each trial. The current research runner is a prototype: it uses a single trial per batch run and synthetic coordinates in the NCR bounding box. For publication-grade results, add repeated trials per seed, statistical summaries (mean/median/stddev), confidence intervals, a documented map sampling strategy, and compare at least 30 independent seeds. The runtime metric is optimizer execution time in this prototype; it does not include the time spent waiting for OSRM requests consistently unless both algorithms share the warmed matrix cache. Keep that caveat in the report.

## Deployment
### Vercel (client)
- Root directory: `client`
- Build: `npm run build`
- Output: `dist`
- Environment: `VITE_API_URL=https://your-render-or-railway-api`

### Render/Railway (server)
- Root directory: `server`
- Build command: `npm install && npx prisma generate`
- Start command: `npm run start`
- Add `DATABASE_URL`, `PORT`, `CLIENT_URL`, `OSRM_BASE`, and `NOMINATIM_BASE` environment variables.
- Run `npx prisma db push` once on the service before launching (or use the platform's release command).

For split deployments, set `CLIENT_URL` to the deployed frontend origin(s), comma-separated if needed. Public CORS is configurable; do not use wildcard origins for a production app with authentication.


## Production hardening before public launch
- Add real authentication/authorization, validate request schemas, rate limit geocoding/order endpoints, and restrict CORS.
- Replace demo-role switching and seed data with secured role access.
- Use a managed routing provider or self-host OSRM for production SLA, traffic-aware ETA, and larger matrices.
- Background queues for matrix calls and route optimization, Redis/socket scaling, structured logging, observability, and database backups.
- Restrict location access and establish rider/customer privacy retention controls.
- The demo reset endpoint is destructive; disable or protect it in production.

## Project structure
```
client/  React/Vite app, maps, dashboards, charts
server/ Express API, Socket.io, route engine, Prisma
```
