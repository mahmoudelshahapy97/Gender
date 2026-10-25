# Database

PostgreSQL 17 (`postgres:17-alpine`). Two tables hold what the cameras count, and the rest
hold the cameras, the accounts and the workspaces:

```
workspace ──< camera ──< visit                 one row per person
    │            └─────< occupancy_snapshot    who was in view, every SNAPSHOT_INTERVAL_S
    └──< workspace_member >── app_user ──< refresh_session
                                  └──────< password_otp
```

| Table | What a row is |
|---|---|
| `camera` | An RTSP source. It has the five location levels InsightEye uses (`location`, `area`, `building`, `floor_level`, `zone`), an optional ROI polygon, and per-camera counting overrides in `settings` (jsonb) |
| `visit` | One tracked person: `gender` (`male`, `female`, `child`, `unknown`), the confidence-weighted `votes` behind it, `first_seen`, `last_seen`, `dwell_s` |
| `occupancy_snapshot` | Who was in view at one moment: `person_count` split into `male_count`, `female_count`, `child_count` and `unknown_count`, plus the annotated frame (`frame_key` in MinIO, or `frame_jpeg` as the fallback) |
| `workspace` · `workspace_member` | Partitions of the data, and who may see each one |
| `app_user` · `refresh_session` · `password_otp` | Console accounts (Argon2 hashes, roles), one row per logged-in device, emailed reset codes (HMAC only) |
| `schema_migration` | Created by the API's migration runner: which files in `migrations/` have been applied |

## Files

| Path | Runs when | Contents |
| --- | --- | --- |
| `schema.sql` | first boot of an empty volume, automatically | the full current schema |
| `migrations/NNN_*.sql` | API startup, once each | versioned changes for databases that already exist |
| `seed.sql` | on demand | 14 days of demo data |
| `queries.sql` | never automatically | reference queries, one per endpoint, plus health checks |

The root `docker-compose.yml` mounts `schema.sql` into `/docker-entrypoint-initdb.d/`, and the
whole folder read-only at `/sql` in the container. Postgres runs init scripts **once**, on an
empty data volume. Editing `schema.sql` does nothing to a database that already exists; that is
what migrations are for.

## Migrations

`schema.sql` is always the full schema for a fresh volume. Every later change to it **also**
goes into a new numbered file in `migrations/`, the same idea as the InsightEye repo's
`versions/` and `migrations.txt`.

- **Applied:** the API mounts `migrations/` at `/app/migrations` (`MIGRATIONS_DIR`). At startup,
  `app/core/migrations.py` takes an advisory lock and applies each file not yet in
  `schema_migration`, in name order, each in its own transaction.
- **Recorded:** each applied file is stored by name with its sha256.
- **Idempotent:** use `IF NOT EXISTS` and `DO $$ … $$` guards. On a fresh volume every file runs
  against a schema that already has the change, so it must be a no-op there.
- **Never edit an applied file.** It is not re-run, and the API only logs a checksum warning. Add
  the next number instead.

```bash
docker compose exec api python -m app.core.migrations --list   # applied / pending
docker compose exec api python -m app.core.migrations          # apply now, without a restart
```

| File | Change |
| --- | --- |
| `001_baseline.sql` | the schema at the first release, a copy of `schema.sql` then; a no-op on a fresh volume |
| `002_notifications.sql` | `notification` (one row per event, per workspace), `notification_read` (who read it), `app_user.notify_email` |

## Workspaces

Each camera belongs to a workspace, and its visits and snapshots follow it. The triggers
`trg_visit_workspace` and `trg_snapshot_workspace` copy the camera's `workspace_id` when an
insert leaves it out. Camera names are unique per workspace.

The **Default** workspace has the fixed id `00000000-0000-0000-0000-000000000001`. Hand-written
inserts, including `seed.sql`, land there, and the API never deletes it. Deleting any other
workspace cascades to everything in it.

## Seeding

`seed.sql` is deliberately **not** an init script, so a fresh stack comes up empty and nobody
ships invented footfall to a real deployment. Load it when you want the charts to have something
to draw:

```bash
docker compose exec -T postgres psql -U gender -d gender_db < database/seed.sql
```

It adds three cameras in the Default workspace:

- Main Entrance, enabled on the mediamtx demo stream;
- Food Court and Electronics Aisle, disabled placeholders.

They span two buildings and three zones. The script then writes the last 14 days (today
included) of snapshots, every 10 minutes from 08:00 to 22:00 UTC, and the visits behind them:
about 3,400 snapshots and 11,000 visits.

The numbers come from a fixed random seed and are shaped by hour of day (lunch and evening peaks),
weekday (busier Friday and Saturday) and zone (the food court skews female and has more
children). Row ids derive from camera and time, so loading again on the same day changes
nothing, and loading on a later day adds the days in between.

## Reference queries

`queries.sql` holds the SQL behind each analytics endpoint, with literal values instead of
asyncpg's `$n` parameters (set with `\set` at the top), so you can paste it into `psql` while
debugging. It ends with three health checks:

- **Visits per camera that stayed `unknown`:** `gender.pt` rarely sees those people well.
- **Visits under 5 s:** tracks are splitting.
- **Frame storage:** how much space the stored frames take.

## Resetting

Init scripts only run against an empty volume. To start over:

```bash
docker compose down -v     # -v drops the pgdata and miniodata volumes, and with them all data
docker compose up -d
```

## Connecting

| From | Command |
| --- | --- |
| Host | `psql postgresql://gender:gender_pass@localhost:5437/gender_db` |
| Container | `docker compose exec postgres psql -U gender -d gender_db` |
| API container | `DB_HOST=postgres`, `DB_PORT=5432` (set by compose) |

## Notes on the schema

- **`occupancy_parts_check`** makes `male + female + child + unknown = person_count` a database
  rule, not just a convention of the worker.
- **`UNIQUE (camera_id, track_key, first_seen)`** on `visit`: track ids restart with the worker,
  so the id alone is not unique, but with its start time it is. A replayed write cannot count a
  person twice.
- **`(workspace_id, captured_at DESC)`** and **`(workspace_id, first_seen DESC)`** serve every
  analytics query, which always filters on a workspace and a time range. The `camera_id`
  variants serve the camera page and the per-camera filters.
- **Frames live in MinIO.** `frame_jpeg` is only the fallback for when MinIO is down at write
  time. Retention clears frames after `FRAME_RETENTION_DAYS` and keeps the counts.
