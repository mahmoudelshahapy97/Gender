# Frontend — Gender Analytics console

The operator console: **Vite + React 18 + react-router-dom 6 + MUI 6 + Chart.js**, talking to
the FastAPI backend through a same-origin proxy.

## Quick start

The backend must be running first. The simplest way is the whole stack with
`docker compose up -d --build` from the repository root, which also serves this console on
http://localhost:8083. To work on the console with hot reload:

```bash
cd frontend
npm install
cp .env.example .env        # VITE_API_TARGET defaults to the compose API on 8004
npm run dev
```

Open <http://localhost:5173>.

## The proxy, and why there is one

`vite.config.js` forwards `/api`, `/health`, `/docs`, `/redoc` and `/openapi.json` to the
backend, so **the browser only ever makes same-origin requests**. Two things follow from that:

- **No CORS.** `CORS_ORIGINS` in `backend/.env` lists a fixed set of origins and cannot know
  which port a dev server happened to bind.
- **`<img>` works against the binary endpoints.** Camera snapshots, the live MJPEG stream and
  snapshot frames go straight into an `<img>`, which can carry neither headers nor a preflight
  response. They authenticate with the httpOnly cookie set at login.

In the container, `Dockerfile` builds the bundle and serves it from nginx, and
`nginx.conf.template` does what the dev proxy does. **Keep the two in step**: a path proxied in
dev but not in nginx is a 404 that only shows up after a build. The template also:

- has `try_files $uri $uri/ /index.html`, because this is a `BrowserRouter` and a hard refresh on
  `/cameras/<uuid>` asks the server for a path that is not on disk;
- turns proxy buffering off for `/api/v1/cameras/*/stream`, without which nginx would hold the
  MJPEG stream back.

`GD_API_URL` (default `http://api:8000`, set on the `web` service in `../docker-compose.yml`) is
what nginx proxies to.

## Routes

| Path | Page |
|---|---|
| `/` | Dashboard: men, women and children today and in the range, who is in view now, average dwell, visits per day, gender mix, latest snapshots |
| `/analytics` | Five tabs: per camera (InsightEye's average-gender), weekday by zone, ratio trends, by location, peak hours (with the weekday × hour heatmap) |
| `/visits` | One row per person: gender, votes, dwell. Filter by gender, page, export CSV |
| `/snapshots` | Occupancy snapshots as a grid; click one for its annotated frame |
| `/cameras` | Registered cameras, with worker controls |
| `/cameras/new` · `/cameras/:id/edit` | Create / edit a camera: RTSP URL, the five location levels, counting overrides (admin) |
| `/cameras/:id` | One camera: live MJPEG, configuration, worker state, the people in view and their votes |
| `/system` | Workers and the configuration in force |
| `/workspaces` · `/users` | Admin: workspaces and their members; accounts and roles |
| `/login` · `/forgot-password` | Sign in; reset a password with an emailed code (when SMTP is set up) |

## The filter bar

Dashboard, Analytics, Visits and Snapshots share one filter bar (`GenderFilterBar`, with state
in `hooks/useFilters.js`):

- a date range (Today, 7, 30 or 90 days, or custom), cameras, and InsightEye's five location
  levels: location, area, building, floor, zone;
- the levels cascade, so picking a building leaves only that building's floors and zones, using
  the options from `/analytics/filters/options`;
- the state lives in `sessionStorage`, so moving between pages keeps it;
- every call sends the browser's timezone as `tz`, so "today" and "busiest hour" are the
  viewer's own, not UTC's.

## Layout

```
src/
├── api/
│   ├── client.js       axios instance, auth refresh, workspace header, error flattening, media URLs
│   └── endpoints.js    one function per backend route
├── auth/               AuthContext, token store, role ladder
├── components/         GenderFilterBar, GenderChip, HourHeatmap, StatCard, ItemImage, DataStates, …
├── hooks/              useFilters, usePolling (pauses on hidden tabs), useAsync
├── layouts/            AppLayout (sidebar, health chip, theme, workspace switcher), AuthLayout
├── pages/              one file per route; cameras/ and admin/ grouped
├── routes/             AppRouter (lazy routes), RequireAuth (role floors)
├── utils/              constants (genders, colours, location levels), charts, format, theme
└── workspace/          WorkspaceContext
```

## Things worth knowing before changing this

**One colour per gender, everywhere.** `GENDER_COLOR` in `utils/constants.js` colours every
chart, chip and stat card, and the backend's annotated frames use the same hues
(`GENDER_COLORS` in `backend/app/utils/image_utils.py`). Series that are not genders, such as
the zones on the weekday chart, use a separate palette that avoids those hues.

**`roi` and `settings` can arrive as strings.** They are `jsonb` columns, and asyncpg returns
`jsonb` as text. Anything that reads them goes through `parseJsonField` (`utils/format.js`).
Without it, `Object.keys(settings)` enumerates character indices.

**A blank override is not zero.** The camera form leaves empty overrides out of the `settings`
payload entirely, because an absent key means "inherit the global value" and `0` is a real
setting. The form also enforces each override's range, for example a snapshot every 5–3600 s.

**Polling pauses on hidden tabs.** `usePolling` schedules the next request only after the
previous response, and skips ticks while `document.hidden`. Otherwise a forgotten wall-display
tab would keep asking every worker for live state.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_TARGET` | `http://127.0.0.1:8004` | Backend origin the dev proxy forwards to |
| `VITE_PORT` | `5173` | Dev server port |
| `VITE_PREVIEW_PORT` | `4173` | `npm run preview` port |
| `VITE_API_BASE` | `/api/v1` | Path prefix the client calls |
| `VITE_POLL_INTERVAL_MS` | `5000` | Base refresh cadence |

## Scripts

```bash
npm run dev       # dev server with the proxy
npm run build     # production bundle into dist/
npm run preview   # serve dist/, proxy still applied
```
