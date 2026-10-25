# Gender Analytics — FastAPI backend

The API, and the camera workers that do the counting, in one service. Each RTSP camera
gets an asyncio worker that reads frames, tracks people, labels them by gender and writes
two kinds of rows:

- **`visit`:** one per person, written when their track ends: gender, the votes behind it,
  first and last seen, dwell.
- **`occupancy_snapshot`:** every `SNAPSHOT_INTERVAL_S` (60 s), who is in view: person,
  male, female, child and unknown counts, plus an annotated frame stored in MinIO.

Analytics are SQL over those two tables, filtered by date range (as whole days in the
viewer's timezone), cameras and InsightEye's five location levels.

---

## How a person gets a gender

```
every processed frame   people.pt + ByteTrack      → person tracks, each with a stable id
every GENDER_EVERY_N    gender.pt on the whole frame → female / male / child boxes
                        each gender box votes for the track it overlaps
                        (≥ GENDER_MATCH_OVERLAP of the smaller box), weighted by confidence
label                   the winning label, once a track has GENDER_MIN_VOTES votes;
                        "unknown" before that
visit                   written when a track is unseen for VISIT_GAP_SECONDS,
                        dropped if shorter than VISIT_MIN_DWELL_S (detector flicker)
```

That is the difference from InsightEye, which counts `gender.pt`'s boxes per frame: here
one misread frame cannot flip a person, and a person standing still for an hour is one
visit. Occupancy uses the same labels, and people not labelled yet go to `unknown_count`,
so the four counts always add up to `person_count` (a CHECK constraint enforces it).

The counting logic lives in [app/services/gender_service.py](app/services/gender_service.py)
and is pure Python, with no model, database or clock. [tests/test_gender_service.py](tests/test_gender_service.py)
drives it with synthetic boxes.

Every threshold can be set globally in `.env` and per camera in `camera.settings`. An absent
key inherits the global value:

```json
{ "snapshot_interval_s": 30, "gender_every_n": 2, "min_votes": 3,
  "visit_gap_seconds": 8, "visit_min_dwell_s": 2, "match_overlap": 0.5 }
```

The models are documented in [models/README.md](models/README.md).

---

## Layout

```
app/
├── api/routes/     analytics, auth, camera, snapshot, system, user, visit, workspace
├── api/deps.py     auth, role floors, workspace resolution, the image-cookie exception
├── core/           config (pydantic-settings), database (asyncpg pool), migrations, security
├── schemas/        pydantic request/response models
├── services/       model_registry, rtsp_reader, tracking_service, gender_service,
│                   stream_manager (workers + supervisor), visit/snapshot/analytics services,
│                   filters (shared WHERE builder), object_store (MinIO), retention
├── utils/          geometry, image (annotation), response
└── main.py         app factory, lifespan, /health
trackers/           gender_bytetrack.yaml (ByteTrack tuned for people at ~5 fps)
models/             people.pt, gender.pt
videos/             gender.mp4, the demo clip mediamtx serves
```

---

## Running

Use the root `docker-compose.yml`, which runs the full stack (see the [root README](../README.md)).
To run the API on the host instead:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env     # set SECRET_KEY; DB_HOST=localhost, DB_PORT=5437 for the compose Postgres
uvicorn app.main:app --reload
```

`MODEL_DEVICE=cuda` falls back to CPU if CUDA is unavailable. The Dockerfile installs CUDA
torch. Build with `--build-arg TORCH_VARIANT=cpu` for a smaller CPU-only image.

`deploy.replicas` must stay 1. Workers are in-process tasks holding per-camera tracker state,
so two replicas would open every camera twice and count every person twice.

---

## Auth

Every route under `/api/v1` needs a bearer token. The exceptions are `GET /health` and the
public auth routes below. There is no public signup. The first admin is created at startup
from `BOOTSTRAP_ADMIN_USERNAME` / `_EMAIL` / `_PASSWORD` when `app_user` is empty, and admins
create every other account through `POST /users`.

| method | path | purpose |
|---|---|---|
| POST | `/auth/login` | `{username, password}` → access + refresh token, sets the image cookie. `username` may be the email (any case) |
| POST | `/auth/refresh` | `{refresh_token}` → a new pair; rotates the refresh token |
| POST | `/auth/logout` · `/auth/logout-all` | revoke this session, or every session for the account |
| GET | `/auth/me` | the calling user |
| POST | `/auth/change-password` | verifies the current password, then logs out everywhere |
| GET | `/auth/options` | public: `{password_reset}`, whether "Forgot your password?" is offered |
| POST | `/auth/forgot-password` · `/auth/reset-password` | public: mail a 6-digit code; set a new password with it |

Password reset stays off until `SMTP_HOST` is set, and until then the two public routes answer
503. A code expires after `OTP_TTL_SECONDS`, one can be sent per `OTP_RESEND_SECONDS`, and
`OTP_MAX_ATTEMPTS` wrong guesses burn it. Only its HMAC is stored.

There are three roles, each a superset of the one before:

- **`viewer`:** reads everything.
- **`operator`:** also starts and stops workers.
- **`admin`:** also registers, edits and deletes cameras, and manages accounts and workspaces.

[app/api/deps.py](app/api/deps.py) enforces each route's floor.

**Workspaces.** Data routes work in the workspace named by the `X-Workspace-Id` header. Without
it, the caller's first workspace is used (Default for admins). A workspace the caller cannot see,
or a camera, visit or snapshot in one, answers **404**, the same as a missing one.

**Image routes.** `/cameras/{id}/snapshot`, `/cameras/{id}/stream` and `/snapshots/{id}/frame`
also accept the httpOnly cookie that `/auth/login` sets, because an `<img src>` cannot send a
header. They check the workspace of the image itself. No other route accepts the cookie; see
`get_image_viewer` in `app/api/deps.py`.

---

## API

The base prefix is `/api/v1`. The analytics, visit and snapshot routes share these filters
(see [app/services/filters.py](app/services/filters.py)):

| param | meaning |
|---|---|
| `start_date`, `end_date` | `YYYY-MM-DD`, whole days in `tz`, end inclusive |
| `tz` | IANA zone, default `UTC`; an unknown zone is a 422 |
| `camera_ids` | comma-separated UUIDs |
| `locations`, `areas`, `buildings`, `floor_levels`, `zones` | comma-separated values of the camera's location levels |

### Analytics
| method | path | purpose |
|---|---|---|
| GET | `/analytics/summary` | dashboard KPIs: today and range counts by gender, average dwell, who is in view now, cameras running |
| GET | `/analytics/cameras/average-gender` | InsightEye's shape: `?gender=` average/max/min per camera from snapshots, plus unique visits |
| GET | `/analytics/zones/gender-by-weekday` | InsightEye's shape: `?gender=` average per zone × weekday |
| GET | `/analytics/gender/ratio-trends` | `?interval=hour\|day\|week\|month&source=visits\|occupancy`: counts and shares per period |
| GET | `/analytics/gender/distribution-by-location` | `?group_by=location\|area\|building\|floor_level\|zone` |
| GET | `/analytics/gender/peak-hours` | arrivals and average occupancy per local hour, with each gender's peak |
| GET | `/analytics/visits/hourly-heatmap` | `?gender=` visits per weekday × hour |
| GET | `/analytics/filters/options` | the cameras and the distinct values of each location level, for the filter bar's cascade |

### Visits and snapshots
| method | path | purpose |
|---|---|---|
| GET | `/visits` | `?gender=&limit=&offset=`, newest first |
| GET | `/visits/export.csv` | the same filter, as CSV |
| GET | `/visits/{id}` | one visit, with its votes |
| GET | `/snapshots` | `?min_people=&limit=&offset=`, newest first; `has_frame` per row |
| GET | `/snapshots/{id}` · `/snapshots/{id}/frame` | one snapshot; its annotated JPEG |

### Cameras
| method | path | purpose |
|---|---|---|
| POST · GET | `/cameras` | register (starts a worker if `enabled`) · list |
| GET · PATCH · DELETE | `/cameras/{id}` | read · update (a running worker restarts with the new settings) · delete, cascading to its visits and snapshots |
| POST | `/cameras/{id}/start` · `/stop` | control the worker |
| GET | `/cameras/{id}/status` | worker state, live occupancy and every person tracked, with their votes |
| GET | `/cameras/{id}/snapshot` · `/stream` | latest annotated frame; live MJPEG (at most `MAX_MJPEG_CLIENTS` viewers) |

### Accounts, workspaces, system
`/users` (admin CRUD, `workspace_ids` on create and update), `/workspaces` and
`/workspaces/{id}/members` (admin), `/workspaces/mine`. `GET /system/workers` returns each
worker's state, fps, reconnects and supervisor restarts. `GET /system/config` returns the
tuning values actually in force. `GET /health` reports database and worker status.

---

## Walkthrough

```bash
API=localhost:8004
TOKEN=$(curl -s -X POST $API/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"ChangeMe!123"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
AUTH="Authorization: Bearer $TOKEN"

# 1. register the demo camera; its worker starts at once
CAM=$(curl -s -X POST $API/api/v1/cameras -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"Lobby","rtsp_url":"rtsp://mediamtx:8554/gender","building":"HQ","zone":"Lobby"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["camera_id"])')

# 2. who is in view, and how each person is labelled
curl -s $API/api/v1/cameras/$CAM/status -H "$AUTH" | python3 -m json.tool

# 3. after a minute or two: visits and snapshots
curl -s "$API/api/v1/visits?camera_ids=$CAM&limit=5" -H "$AUTH" | python3 -m json.tool
curl -s "$API/api/v1/snapshots?camera_ids=$CAM&limit=1" -H "$AUTH" | python3 -m json.tool

# 4. InsightEye's per-camera average, this week, in Cairo time
curl -s -G $API/api/v1/analytics/cameras/average-gender -H "$AUTH" \
  --data-urlencode gender=female --data-urlencode tz=Africa/Cairo \
  --data-urlencode start_date=$(date -d '-6 days' +%F) --data-urlencode end_date=$(date +%F) \
  | python3 -m json.tool
```

---

## Tests

```bash
# from the repository root
docker compose -p gender-test -f backend/docker-compose.test.yml run --rm tests
docker compose -p gender-test -f backend/docker-compose.test.yml down -v
```

[docker-compose.test.yml](docker-compose.test.yml) brings up a throwaway Postgres (the schema
applied, data on tmpfs) and MinIO, publishes nothing on the host, and runs pytest with the source
bind-mounted, so a code change needs no rebuild. The first run builds a CPU-torch image. That
build takes several GB of disk, so check free space first.

| File | Covers |
|---|---|
| `test_gender_service.py` | voting, label settling, unknown until enough votes, visits on track end, the dwell floor, occupancy that adds up |
| `test_utils.py` | geometry (IoU, gaps, ROI), the filter WHERE builder and timezone days, frame annotation |
| `test_auth.py` · `test_otp.py` | hashing, password rules, JWT, roles, refresh rotation, reset codes |
| `test_workspaces.py` | partitioning, membership, 404 for hidden rows |
| `test_integration.py` | camera CRUD, visit and snapshot writes, every analytics endpoint, the filters, MinIO with the Postgres fallback, retention |
| `test_migrations.py` | the runner: name order, each file applied once, rollback on failure, a warning for an edited file |
| `test_supervisor.py` | restart of dead, errored and stalled workers, with backoff |
| `test_models.py` | **slow**: loads the real weights and counts people by gender on `videos/gender.mp4` |

The slow tests are skipped by default. To run everything, append
`python -m pytest -q -m "slow or not slow"` to the `run --rm tests` command.

---

## Tuning notes

- `FRAME_SKIP` and `TARGET_PROCESS_FPS` set how many frames reach the models. ByteTrack in
  [trackers/gender_bytetrack.yaml](trackers/gender_bytetrack.yaml) is tuned for about 5 processed fps.
  Raise `track_buffer` if people walking behind pillars split into several visits.
- `GENDER_EVERY_N=3` matches InsightEye. Lower it for faster labels, at the cost of more GPU
  time per camera.
- If many visits are `unknown`, `gender.pt` rarely sees those people well enough: check the
  camera angle, or lower `GENDER_MIN_VOTES`. If many visits are under 5 s, tracks are splitting:
  raise `VISIT_GAP_SECONDS`. `database/queries.sql` has both checks.
- `GENDER_CLASS_MAP` maps `gender.pt`'s class ids to stored labels. It must match the model's
  `names` (`0 female, 1 male, 2 child`). `test_models.py` checks the model's names and that the map
  covers all three labels.
