# InsightEye — Gender Analytics

Gender-aware people counting on RTSP cameras. Each person in view is tracked,
and InsightEye's production `gender.pt` votes on their label across many frames.
The counts are stored two ways:

- **Visits:** one row per person, with gender and dwell. Answers "how many women
  came in today".
- **Occupancy:** a snapshot every 60 s of who is in view, split into male,
  female, child and not-yet-labelled. Answers "how many men are in view now",
  the figure InsightEye's charts average.

```
RTSP camera → people.pt + ByteTrack ─┐
            → gender.pt (every 3rd) ─┴→ votes per track → visit rows + occupancy snapshots (+ annotated frame → MinIO)
                                                                   │
browser ──same origin──> web (nginx) ──proxy──> api ───────────────┴──> postgres
```

InsightEye counts gender per frame, so a person standing in view for an hour is
counted in every snapshot of that hour, and one misread frame flips the tally.
Here a person keeps one label for their whole track. Children get their own
count instead of being dropped. InsightEye's two analytics endpoints keep their
response shapes:

- `GET /analytics/cameras/average-gender`
- `GET /analytics/zones/gender-by-weekday`

Alongside them sit ratio trends, distribution by location, peak hours and an
hour-of-week heatmap.

| Tier | Directory | Stack |
|---|---|---|
| Console | [`frontend/`](frontend) | React 18, Vite, React Router, MUI, Chart.js |
| API + counting | [`backend/`](backend) | FastAPI, asyncpg, Ultralytics, OpenCV |
| Models | [`backend/models/`](backend/models) | InsightEye's `people.pt` and `gender.pt` |
| Database | [`database/`](database) | PostgreSQL 17: schema, migrations, demo seed, reference queries |
| End-to-end tests | [`e2e/`](e2e) | Playwright, run against the live stack |

Each directory has its own README with the details.

---

## Run the whole thing

```bash
cp .env.example .env                   # host ports and MinIO credentials
cp backend/.env.example backend/.env   # then set SECRET_KEY (see the comment in the file)
docker compose up -d --build
```

| Service | URL | Notes |
|---|---|---|
| Console | http://localhost:8083 | nginx serving the built SPA and proxying the API |
| API | http://localhost:8004 | `/docs` for Swagger |
| Postgres | localhost:5437 | `gender` / `gender_pass` / `gender_db` |
| RTSP demo | rtsp://localhost:8557/gender | mediamtx looping `backend/videos/gender.mp4` |
| MinIO | http://localhost:9003 | console; the S3 API is on 9002 |

Sign in to the console as the bootstrap admin:

| Username | Email | Password |
|---|---|---|
| `admin` | `admin@insighteye.local` | `WCtnCGXUGHqDBrso!A1` |

These are the values from this machine's `backend/.env`. A fresh install uses whatever its own
`backend/.env` sets (`admin` / `ChangeMe!123` by default); change the password after signing in.

The ports avoid the other stacks on this machine (lost-found holds 5436/8003/8082/8556/9000/9001).
You can override them in the root `.env` with `POSTGRES_HOST_PORT`, `API_HOST_PORT`,
`WEB_HOST_PORT`, `RTSP_HOST_PORT`, `MINIO_API_HOST_PORT` and `MINIO_CONSOLE_HOST_PORT`.

The api service reserves the host's NVIDIA GPU and runs the models with `MODEL_DEVICE=cuda`.
Without a GPU, remove the `deploy.resources` block from `docker-compose.yml` and set
`MODEL_DEVICE=cpu`. Counting still works on CPU, just at a lower frame rate.

**Demo data.** A fresh stack comes up empty. To get 14 days of snapshots and visits across three
cameras, so the charts have something to draw:

```bash
docker compose exec -T postgres psql -U gender -d gender_db < database/seed.sql
```

**Schema.** `database/schema.sql` creates the schema on the first boot of an empty volume. Later
changes ship as numbered files in `database/migrations/`, which the API applies at startup (see
[database/README.md](database/README.md)).

## Test camera without hardware

`mediamtx` starts with the stack and serves `backend/videos/gender.mp4` as an RTSP path, looping
on demand. In the console, register a camera as `rtsp://mediamtx:8554/gender`. The api container
resolves that name; from the host the same stream is `rtsp://localhost:8557/gender`.

## Cameras stay running

A camera's `enabled` flag is the operator's intent. **Start** sets it and **Stop** clears it, so
after an API restart a camera comes back exactly as it was left. While the API runs, a supervisor
checks every worker every `WORKER_SUPERVISION_INTERVAL_S`. It restarts, with exponential backoff,
any worker that died, errored or stopped analysing frames, and it starts any enabled camera that
has no worker. When a worker stops, it writes the visits still open, so stopping a camera does
not lose the people in view.

The camera page shows the annotated output live, as MJPEG from `GET /api/v1/cameras/{id}/stream`.
Each person is boxed in the colour of their label, and a table lists the people in view with
the votes `gender.pt` has cast for them.

## Notifications

The console's bell and its Notifications page show two kinds of event, live (Server-Sent
Events from `GET /api/v1/notifications/stream`, with a toast as each arrives):

- **Occupancy alerts.** On a camera's edit page, *Alert above* and *Alert below* set its
  thresholds (`settings.alert_max_people` / `alert_min_people`; blank is off). The people count
  must stay past one for `ALERT_SUSTAIN_S` (10 s). It then alerts once per crossing, at most
  every `ALERT_COOLDOWN_S` (600 s), so a crowd that stays all afternoon is one alert.
- **Camera health.** An enabled camera that delivers no frames for `CAMERA_OFFLINE_AFTER_S`
  (90 s) is reported offline, and back online when frames resume. Inside
  `CAMERA_HEALTH_COOLDOWN_S` (900 s) a flapping camera stays quiet. Cameras stopped on purpose
  are never reported. This rides on the worker supervisor, so it needs
  `WORKER_SUPERVISION_ENABLED`.

A notification belongs to its camera's workspace and reaches everyone who can see it: the
members, and every admin. Read state is per account. With `SMTP_HOST` set, *Email me alerts* in
the account menu also mails them (set `CONSOLE_URL` to link back to the console). Retention
deletes notifications older than `NOTIFICATION_RETENTION_DAYS` (90).

## Workspaces

Data is partitioned into workspaces, as in InsightEye. A camera belongs to one, and its visits and
snapshots follow it. Members see their own workspaces; admins see all of them. The console's
workspace switcher sets the `X-Workspace-Id` header for every call.

## Object storage (MinIO)

Snapshot frames are stored in MinIO under `snapshots/<camera_id>/<snapshot_id>.jpg`. Postgres
keeps the counts plus the object key (`occupancy_snapshot.frame_key`). If MinIO is unreachable
when a frame is saved, the frame goes into `occupancy_snapshot.frame_jpeg` instead, and reads
try both. On first start, `minio-init` creates the bucket (`MINIO_BUCKET`, default `gender`).
Log in to the console with `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` from the root `.env`.

Retention runs every 6 hours. It deletes frames older than `FRAME_RETENTION_DAYS` (30) and keeps
their counts. It deletes snapshot and visit rows older than `DATA_RETENTION_DAYS` (365; 0 keeps
them forever).

MinIO no longer publishes community images, so the service runs Chainguard's build of MinIO,
pinned by digest in `docker-compose.yml`.

## Tests

```bash
# Backend: unit + integration, against a throwaway Postgres and MinIO (nothing published on the host)
docker compose -p gender-test -f backend/docker-compose.test.yml run --rm tests
docker compose -p gender-test -f backend/docker-compose.test.yml down -v

# End to end: Playwright, against the running stack with the seed loaded
E2E_ADMIN_PASSWORD=<BOOTSTRAP_ADMIN_PASSWORD> ./e2e/run.sh
```
