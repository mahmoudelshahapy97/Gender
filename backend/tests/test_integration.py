"""Integration tests against a live Postgres (and MinIO, when configured).

Skipped automatically when no database is reachable, so ``pytest`` stays green
without one. To run them, point the usual DB_* variables at a server that has
``database/schema.sql`` applied - backend/docker-compose.test.yml does that.

No model weights are needed: visits and snapshots are written directly, so the
storage, analytics and retention can be exercised on their own.
"""

import uuid
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pytest

from app.core.config import config
from app.core.database import close_db_pool, db_manager, init_db_pool, wait_for_schema
from app.core.migrations import run_migrations
from app.services import retention
from app.services.analytics_service import analytics_service
from app.services.camera_service import camera_service
from app.services.filters import Filters
from app.services.gender_service import Visit
from app.services.object_store import camera_prefixes, object_store
from app.services.snapshot_service import snapshot_service
from app.services.visit_service import visit_service
from app.services.workspace_service import workspace_service
from app.utils.image_utils import encode_jpeg

pytestmark = pytest.mark.asyncio


@pytest.fixture(scope="module")
async def database():
    """Connect once for the module, or skip the whole file."""
    try:
        await init_db_pool()
    except Exception as e:
        pytest.skip(f"No database reachable ({config.db_host}:{config.db_port}): {e}")

    if not await wait_for_schema(timeout=5):
        await close_db_pool()
        pytest.skip("Database reachable but database/schema.sql has not been applied.")

    # The same idempotent upgrades the api runs at startup.
    await run_migrations()
    yield
    await close_db_pool()


@pytest.fixture
async def workspace(database):
    """A throwaway workspace, so the analytics see only this test's rows."""
    created = await workspace_service.create(f"it-{uuid.uuid4().hex[:8]}", None, None)
    yield created["workspace_id"]
    for camera_id in await workspace_service.camera_ids(created["workspace_id"]):
        for prefix in camera_prefixes(camera_id):
            await object_store.remove_prefix(prefix)
    await workspace_service.delete(created["workspace_id"])


async def make_camera(workspace_id, name="cam", **location):
    return await camera_service.create_camera(
        name=f"{name}-{uuid.uuid4().hex[:6]}",
        rtsp_url="rtsp://example.invalid:8554/test",
        enabled=False,
        workspace_id=workspace_id,
        **location,
    )


@pytest.fixture
async def camera(workspace):
    return await make_camera(workspace, location="HQ", area="North", building="B1", floor_level="G", zone="Lobby")


def _visit(track: str, gender: str, start: datetime, dwell: float = 30.0) -> Visit:
    return Visit(
        track_key=track,
        gender=gender,
        confidence=0.9 if gender != "unknown" else None,
        votes={gender: 1.8} if gender != "unknown" else {},
        first_seen=start,
        last_seen=start + timedelta(seconds=dwell),
        dwell_s=dwell,
    )


async def _snapshot(camera_id, at: datetime, male=0, female=0, child=0, unknown=0):
    return await db_manager.execute_query(
        """
        INSERT INTO occupancy_snapshot
            (camera_id, captured_at, person_count, male_count, female_count, child_count, unknown_count)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING snapshot_id
        """,
        (camera_id, at, male + female + child + unknown, male, female, child, unknown),
        fetch_one=True,
    )


# ------------------------------------------------------------------- cameras
async def test_camera_crud_keeps_the_location_hierarchy(workspace):
    created = await make_camera(workspace, location="HQ", zone="Lobby")
    assert (created["location"], created["zone"], created["area"]) == ("HQ", "Lobby", None)

    updated = await camera_service.update_camera(created["camera_id"], area="North", floor_level="2")
    assert (updated["area"], updated["floor_level"], updated["zone"]) == ("North", "2", "Lobby")

    assert await camera_service.delete_camera(created["camera_id"])
    assert await camera_service.get_camera(created["camera_id"]) is None


# ------------------------------------------------------------------- visits
async def test_visits_are_stored_once_even_when_replayed(camera):
    start = datetime.now(timezone.utc) - timedelta(minutes=5)
    visits = [_visit("s:1", "female", start), _visit("s:2", "male", start)]
    assert await visit_service.record(camera["camera_id"], visits) == 2
    await visit_service.record(camera["camera_id"], visits[:1])  # replay

    filters = Filters(workspace_id=camera["workspace_id"])
    rows, total = await visit_service.list(filters)
    assert total == 2
    assert {r["gender"] for r in rows} == {"female", "male"}
    assert rows[0]["votes"] in ({"female": 1.8}, {"male": 1.8})

    women, total = await visit_service.list(filters, gender="female")
    assert total == 1 and women[0]["camera_name"] == camera["name"]


async def test_the_database_rejects_an_unknown_gender(camera):
    with pytest.raises(Exception):
        await db_manager.execute_query(
            "INSERT INTO visit (camera_id, track_key, gender, first_seen, last_seen) "
            "VALUES ($1, 'x', 'other', NOW(), NOW())",
            (camera["camera_id"],),
        )


# ---------------------------------------------------------------- snapshots
async def test_snapshot_parts_must_add_up(camera):
    with pytest.raises(Exception):
        await db_manager.execute_query(
            "INSERT INTO occupancy_snapshot (camera_id, person_count, male_count) VALUES ($1, 1, 2)",
            (camera["camera_id"],),
        )


async def test_snapshot_frame_goes_to_minio_with_the_key_in_postgres(camera):
    if not object_store.enabled:
        pytest.skip("MINIO_ENDPOINT not set")
    jpeg = encode_jpeg(np.full((48, 64, 3), 127, dtype=np.uint8))
    counts = {"person_count": 2, "male_count": 1, "female_count": 1, "child_count": 0, "unknown_count": 0}
    row = await snapshot_service.record(camera["camera_id"], counts, jpeg)

    stored = await db_manager.execute_query(
        "SELECT frame_key, frame_jpeg IS NOT NULL AS in_db FROM occupancy_snapshot WHERE snapshot_id = $1",
        (row["snapshot_id"],),
        fetch_one=True,
    )
    assert stored["frame_key"] == f"snapshots/{camera['camera_id']}/{row['snapshot_id']}.jpg"
    assert not stored["in_db"]
    assert (await snapshot_service.frame(row["snapshot_id"]))[:2] == b"\xff\xd8"


async def test_snapshot_frame_falls_back_to_postgres_when_minio_is_down(camera, monkeypatch):
    async def unavailable(*_args, **_kwargs):
        return False

    monkeypatch.setattr(object_store, "put_bytes", unavailable)
    jpeg = encode_jpeg(np.full((48, 64, 3), 127, dtype=np.uint8))
    counts = {"person_count": 0, "male_count": 0, "female_count": 0, "child_count": 0, "unknown_count": 0}
    row = await snapshot_service.record(camera["camera_id"], counts, jpeg)
    assert (await snapshot_service.frame(row["snapshot_id"]))[:2] == b"\xff\xd8"

    listed, total = await snapshot_service.list(Filters(workspace_id=camera["workspace_id"]))
    assert total == 1 and listed[0]["has_frame"]


# ---------------------------------------------------------------- analytics
@pytest.fixture
async def history(workspace):
    """Two cameras in two zones, a week of snapshots and some visits.

    Lobby: Monday 2026-03-02 (2 men, 1 woman), Tuesday (4 men, 3 women).
    Cafe: Monday (0 men, 2 women, 1 child).
    """
    lobby = await make_camera(workspace, "lobby", location="HQ", building="B1", zone="Lobby")
    cafe = await make_camera(workspace, "cafe", location="HQ", building="B2", zone="Cafe")
    monday = datetime(2026, 3, 2, 10, 0, tzinfo=timezone.utc)
    tuesday = monday + timedelta(days=1)

    await _snapshot(lobby["camera_id"], monday, male=2, female=1)
    await _snapshot(lobby["camera_id"], tuesday, male=4, female=3)
    await _snapshot(cafe["camera_id"], monday, female=2, child=1)

    await visit_service.record(
        lobby["camera_id"],
        [
            _visit("l:1", "male", monday, 60),
            _visit("l:2", "male", monday + timedelta(minutes=5), 120),
            _visit("l:3", "female", tuesday, 30),
            _visit("l:4", "unknown", tuesday, 10),
        ],
    )
    await visit_service.record(
        cafe["camera_id"],
        [_visit("c:1", "female", monday, 300), _visit("c:2", "child", monday + timedelta(hours=3), 90)],
    )
    return {"workspace": workspace, "lobby": lobby, "cafe": cafe, "monday": monday}


async def test_average_gender_per_camera_matches_insighteye(history):
    filters = Filters(workspace_id=history["workspace"])
    rows = await analytics_service.average_gender_by_camera(filters, "male")
    assert [(r["camera_name"], r["avg_count"], r["max_count"], r["min_count"], r["sample_size"]) for r in rows] == [
        (history["lobby"]["name"], 3.0, 4, 2, 2),
        (history["cafe"]["name"], 0.0, 0, 0, 1),
    ]
    assert rows[0]["visit_count"] == 2
    assert rows[0]["zone"] == "Lobby"


async def test_gender_by_weekday_per_zone(history):
    filters = Filters(workspace_id=history["workspace"])
    rows = await analytics_service.gender_by_weekday(filters, "female", "UTC")
    assert [(r["zone"], r["weekday_name"], r["avg_count"]) for r in rows] == [
        ("Cafe", "Monday", 2.0),
        ("Lobby", "Monday", 1.0),
        ("Lobby", "Tuesday", 3.0),
    ]


async def test_filters_narrow_by_date_camera_and_location(history):
    monday_only = Filters(workspace_id=history["workspace"], start_date=date(2026, 3, 2), end_date=date(2026, 3, 2))
    rows = await analytics_service.average_gender_by_camera(monday_only, "male")
    assert {r["camera_name"]: r["avg_count"] for r in rows}[history["lobby"]["name"]] == 2.0

    cafe_only = Filters(workspace_id=history["workspace"], buildings=["B2"])
    rows = await analytics_service.average_gender_by_camera(cafe_only, "female")
    assert [r["camera_name"] for r in rows] == [history["cafe"]["name"]]

    by_camera = Filters(workspace_id=history["workspace"], camera_ids=[history["lobby"]["camera_id"]])
    visits, total = await visit_service.list(by_camera)
    assert total == 4


async def test_ratio_trends_count_visits_and_average_occupancy(history):
    filters = Filters(workspace_id=history["workspace"])
    visits = await analytics_service.ratio_trends(filters, "day", "visits", "UTC")
    assert [(v["male"], v["female"], v["child"], v["unknown"], v["total"]) for v in visits] == [
        (2, 1, 1, 0, 4),
        (0, 1, 0, 1, 2),
    ]
    assert visits[0]["male_pct"] == 50.0  # of the labelled people: unknown left out
    assert visits[0]["male_female_ratio"] == 2.0

    occupancy = await analytics_service.ratio_trends(filters, "day", "occupancy", "UTC")
    assert occupancy[0]["female"] == 1.5  # mean of Lobby 1 and Cafe 2 on Monday


async def test_distribution_by_zone(history):
    groups = await analytics_service.distribution_by_location(Filters(workspace_id=history["workspace"]), "zone")
    by_zone = {g["group"]: g for g in groups}
    assert by_zone["Lobby"]["visits"]["total"] == 4
    assert by_zone["Cafe"]["visits"]["child"] == 1
    assert by_zone["Lobby"]["occupancy"]["male"] == 3.0
    assert groups[0]["group"] == "Lobby"  # most visits first


async def test_peak_hours_and_heatmap_follow_the_viewer_timezone(history):
    filters = Filters(workspace_id=history["workspace"])
    utc = await analytics_service.peak_hours(filters, "UTC")
    assert utc["hours"][10]["visits_male"] == 2
    assert utc["peak_male_hour"] == 10
    assert utc["peak_child_hour"] == 13

    cairo = await analytics_service.peak_hours(filters, "Africa/Cairo")  # UTC+2 in March
    assert cairo["peak_male_hour"] == 12

    cells = await analytics_service.hourly_heatmap(filters, "UTC", "female")
    assert sorted((c["weekday"], c["hour"], c["events"]) for c in cells) == [(1, 10, 1), (2, 10, 1)]


async def test_summary_today_and_now(history):
    now = datetime.now(timezone.utc)
    await visit_service.record(history["lobby"]["camera_id"], [_visit("t:1", "female", now - timedelta(seconds=40))])
    await _snapshot(history["lobby"]["camera_id"], now, male=1, female=2)
    await _snapshot(history["cafe"]["camera_id"], now - timedelta(hours=1), male=9)  # too old for "now"

    summary = await analytics_service.summary(Filters(workspace_id=history["workspace"]), "UTC")
    assert summary["today"]["female"] >= 1
    assert summary["range"]["total"] == 7
    assert summary["occupancy_now"]["total"] == 3
    assert summary["occupancy_now"]["cameras"] == 1


async def test_filter_options_list_the_locations_in_use(history):
    options = await analytics_service.filter_options(history["workspace"])
    assert options["zones"] == ["Cafe", "Lobby"]
    assert options["buildings"] == ["B1", "B2"]
    assert len(options["cameras"]) == 2


# ---------------------------------------------------------------- retention
async def test_retention_drops_old_frames_then_old_rows(camera, monkeypatch):
    old = datetime.now(timezone.utc) - timedelta(days=40)
    ancient = datetime.now(timezone.utc) - timedelta(days=400)
    recent = await _snapshot(camera["camera_id"], datetime.now(timezone.utc), male=1)
    aged = await _snapshot(camera["camera_id"], old, male=1)
    gone = await _snapshot(camera["camera_id"], ancient, male=1)
    for row in (recent, aged, gone):
        await db_manager.execute_query(
            "UPDATE occupancy_snapshot SET frame_jpeg = $2 WHERE snapshot_id = $1", (row["snapshot_id"], b"\xff\xd8")
        )
    await visit_service.record(camera["camera_id"], [_visit("old:1", "male", ancient)])

    monkeypatch.setattr(config, "frame_retention_days", 30)
    monkeypatch.setattr(config, "data_retention_days", 365)
    report = await retention.purge_old_data()
    assert report.snapshots_deleted >= 1 and report.visits_deleted >= 1

    rows = await db_manager.execute_query(
        "SELECT snapshot_id, frame_jpeg IS NOT NULL AS has_frame FROM occupancy_snapshot WHERE camera_id = $1",
        (camera["camera_id"],),
        fetch_all=True,
    )
    frames = {r["snapshot_id"]: r["has_frame"] for r in rows}
    assert frames == {recent["snapshot_id"]: True, aged["snapshot_id"]: False}
