"""Notifications against a live Postgres (skipped without one, like
test_integration.py): who sees what, per-account read state, the routes, the
mail to opted-in accounts, and the live stream.

Mail never leaves the process (FakeSMTP, as in test_otp.py).
"""

import asyncio
import json
import re
import uuid

import pytest

from app.core.config import config
from app.core.database import close_db_pool, db_manager, init_db_pool, wait_for_schema
from app.core.migrations import run_migrations
from app.core.security import create_access_token
from app.services.alerts import HIGH, OFFLINE, ONLINE, OccupancyAlert
from app.services.notification_service import hub, notification_service
from app.services.user_service import user_service
from app.services.workspace_service import workspace_service

PASSWORD = "Valid1Password!"


@pytest.fixture(scope="module")
async def database():
    try:
        await init_db_pool()
    except Exception as e:
        pytest.skip(f"No database reachable ({config.db_host}:{config.db_port}): {e}")
    if not await wait_for_schema(timeout=5):
        await close_db_pool()
        pytest.skip("Database reachable but database/schema.sql has not been applied.")
    await run_migrations()
    yield
    await close_db_pool()


def _bearer(user) -> dict:
    token = create_access_token(user["user_id"], user["role"], user["token_version"])
    return {"Authorization": f"Bearer {token}"}


class FakeSMTP:
    sent = []

    def __init__(self, host, port, timeout=None):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def starttls(self):
        pass

    def login(self, username, password):
        pass

    def send_message(self, message):
        FakeSMTP.sent.append(message)


@pytest.fixture
def mailer(monkeypatch):
    FakeSMTP.sent = []
    monkeypatch.setattr("smtplib.SMTP", FakeSMTP)
    monkeypatch.setattr(config, "smtp_host", "smtp.test")
    return FakeSMTP


@pytest.fixture
async def world(database, monkeypatch):
    """Workspaces A and B, a camera in each; an admin, a viewer in A, an
    operator in B. Everything is removed afterwards."""
    monkeypatch.setattr(config, "notifications_enabled", True)
    monkeypatch.setattr(config, "smtp_host", "")
    suffix = uuid.uuid4().hex[:8]
    ws_a = await workspace_service.create(f"NA-{suffix}", None, None)
    ws_b = await workspace_service.create(f"NB-{suffix}", None, None)

    async def account(name, role, workspace=None):
        user = await user_service.create_user(
            f"n-{name}-{suffix}", f"n-{name}-{suffix}@example.com", PASSWORD, role
        )
        if workspace:
            await workspace_service.add_member(workspace["workspace_id"], user["user_id"])
        return user

    async def camera(name, workspace):
        return await db_manager.execute_query(
            "INSERT INTO camera (name, rtsp_url, enabled, workspace_id, building, zone) "
            "VALUES ($1, 'rtsp://x', FALSE, $2, 'B1', 'Lobby') RETURNING *",
            (f"{name}-{suffix}", workspace["workspace_id"]),
            fetch_one=True,
        )

    w = {
        "a": ws_a,
        "b": ws_b,
        "admin": await account("admin", "admin"),
        "viewer_a": await account("viewer", "viewer", ws_a),
        "operator_b": await account("op", "operator", ws_b),
        "cam_a": await camera("cam-a", ws_a),
        "cam_b": await camera("cam-b", ws_b),
    }
    yield w
    for key in ("admin", "viewer_a", "operator_b"):
        await db_manager.execute_query("DELETE FROM app_user WHERE user_id = $1", (w[key]["user_id"],))
    for ws in (ws_a, ws_b):
        await db_manager.execute_query("DELETE FROM workspace WHERE workspace_id = $1", (ws["workspace_id"],))


async def crowding(camera, count=12, threshold=10):
    occupancy = {"person_count": count, "male_count": 7, "female_count": 4, "child_count": 1, "unknown_count": 0}
    return await notification_service.occupancy_alert(camera, OccupancyAlert(HIGH, count, threshold), occupancy)


def ids(page):
    return {item["notification_id"] for item in page["items"]}


# -------------------------------------------------------------- the service
async def test_occupancy_alert_reads_well_and_keeps_its_numbers(world):
    item = await crowding(world["cam_a"])
    assert item["kind"] == HIGH and item["severity"] == "warning"
    assert item["title"] == f"Crowding: {world['cam_a']['name']}"
    assert "12 people in view at B1 · Lobby, above the limit of 10" in item["message"]
    assert "7 male, 4 female, 1 child" in item["message"]
    assert item["details"]["person_count"] == 12 and item["details"]["threshold"] == 10
    assert item["workspace_name"] == world["a"]["name"]


async def test_each_reader_sees_only_their_workspaces(world):
    in_a = await crowding(world["cam_a"])
    in_b = await notification_service.camera_health(world["cam_b"], OFFLINE, 120, "could not open stream")
    assert in_b["severity"] == "critical" and "No frames for 2 min" in in_b["message"]

    seen_by_viewer = ids(await notification_service.list_for(world["viewer_a"], limit=200))
    seen_by_operator = ids(await notification_service.list_for(world["operator_b"], limit=200))
    seen_by_admin = ids(await notification_service.list_for(world["admin"], limit=200))

    assert in_a["notification_id"] in seen_by_viewer and in_b["notification_id"] not in seen_by_viewer
    assert in_b["notification_id"] in seen_by_operator and in_a["notification_id"] not in seen_by_operator
    assert {in_a["notification_id"], in_b["notification_id"]} <= seen_by_admin
    assert await notification_service.get_for(world["viewer_a"], uuid.UUID(in_b["notification_id"])) is None


async def test_read_state_is_per_account(world):
    item = await crowding(world["cam_a"])
    nid = uuid.UUID(item["notification_id"])
    viewer, admin = world["viewer_a"], world["admin"]
    before = await notification_service.unread_count(viewer)

    assert await notification_service.mark_read(viewer, [nid]) == 1
    assert await notification_service.mark_read(viewer, [nid]) == 0  # already read
    assert await notification_service.unread_count(viewer) == before - 1
    assert (await notification_service.get_for(viewer, nid))["is_read"] is True
    assert (await notification_service.get_for(admin, nid))["is_read"] is False

    await notification_service.mark_unread(viewer, nid)
    assert (await notification_service.get_for(viewer, nid))["is_read"] is False


async def test_mark_read_skips_what_the_reader_cannot_see(world):
    hidden = await crowding(world["cam_b"])
    assert await notification_service.mark_read(world["viewer_a"], [uuid.UUID(hidden["notification_id"])]) == 0


async def test_mark_all_read_by_workspace(world):
    admin = world["admin"]
    await crowding(world["cam_a"])
    await crowding(world["cam_b"])
    await notification_service.mark_all_read(admin, world["a"]["workspace_id"])
    assert await notification_service.unread_count(admin, world["a"]["workspace_id"]) == 0
    assert await notification_service.unread_count(admin, world["b"]["workspace_id"]) >= 1


async def test_deactivated_workspace_is_hidden_from_members(world):
    item = await crowding(world["cam_a"])
    await workspace_service.update(world["a"]["workspace_id"], is_active=False)
    assert item["notification_id"] not in ids(await notification_service.list_for(world["viewer_a"], limit=200))
    assert item["notification_id"] in ids(await notification_service.list_for(world["admin"], limit=200))


async def test_camera_delete_keeps_the_history(world):
    item = await crowding(world["cam_b"])
    await db_manager.execute_query("DELETE FROM camera WHERE camera_id = $1", (world["cam_b"]["camera_id"],))
    kept = await notification_service.get_for(world["admin"], uuid.UUID(item["notification_id"]))
    assert kept["camera_id"] is None and kept["camera_name"] == world["cam_b"]["name"]


async def test_last_health_kind(world):
    camera_id = world["cam_a"]["camera_id"]
    assert await notification_service.last_health_kind(camera_id) is None
    await notification_service.camera_health(world["cam_a"], OFFLINE, 100)
    assert await notification_service.last_health_kind(camera_id) == OFFLINE
    online = await notification_service.camera_health(world["cam_a"], ONLINE, 400)
    assert online["severity"] == "info" and "after 7 min offline" in online["message"]
    assert await notification_service.last_health_kind(camera_id) == ONLINE


async def test_disabled_publishes_nothing(world, monkeypatch):
    monkeypatch.setattr(config, "notifications_enabled", False)
    assert await crowding(world["cam_a"]) is None


async def test_purge(world):
    old = await crowding(world["cam_a"])
    await db_manager.execute_query(
        "UPDATE notification SET created_at = NOW() - INTERVAL '100 days' WHERE notification_id = $1",
        (uuid.UUID(old["notification_id"]),),
    )
    assert await notification_service.purge(90) >= 1
    assert await notification_service.get_for(world["admin"], uuid.UUID(old["notification_id"])) is None


# --------------------------------------------------------------------- mail
async def test_mail_goes_to_opted_in_accounts_that_can_see_it(world, mailer, monkeypatch):
    monkeypatch.setattr(config, "console_url", "https://console.test")
    for key in ("admin", "viewer_a", "operator_b"):
        await user_service.update_user(world[key]["user_id"], notify_email=True)

    item = await crowding(world["cam_a"])
    await notification_service.drain()

    to = {m["To"] for m in mailer.sent}
    # Admins of other deployments' tests may have opted in too; ours must be there.
    assert world["viewer_a"]["email"] in to and world["admin"]["email"] in to
    assert world["operator_b"]["email"] not in to
    mail = next(m for m in mailer.sent if m["To"] == world["viewer_a"]["email"])
    assert item["title"] in mail["Subject"]
    body = mail.get_body(preferencelist=("plain",)).get_content()
    assert f"https://console.test/cameras/{world['cam_a']['camera_id']}" in body
    assert re.search(r"At: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC", body)


async def test_no_mail_without_opt_in(world, mailer):
    await crowding(world["cam_b"])
    await notification_service.drain()
    assert world["operator_b"]["email"] not in {m["To"] for m in mailer.sent}


# ------------------------------------------------------------------- routes
async def test_list_route_filters_and_pages(world, api):
    headers = _bearer(world["viewer_a"])
    for _ in range(3):
        await crowding(world["cam_a"])
    await notification_service.camera_health(world["cam_a"], OFFLINE, 95)

    page = (await api.get("/notifications", params={"limit": 2}, headers=headers)).json()["data"]
    assert len(page["items"]) == 2 and page["total"] >= 4 and page["unread"] >= 4
    newest = page["items"][0]
    assert newest["kind"] == OFFLINE

    only_health = (await api.get("/notifications", params={"kind": OFFLINE}, headers=headers)).json()["data"]
    assert {i["kind"] for i in only_health["items"]} == {OFFLINE}
    bad = await api.get("/notifications", params={"kind": "fire"}, headers=headers)
    assert bad.status_code == 422

    other = await api.get("/notifications", params={"workspace_id": str(world["b"]["workspace_id"])}, headers=headers)
    assert other.status_code == 404


async def test_read_routes(world, api):
    headers = _bearer(world["viewer_a"])
    item = await crowding(world["cam_a"])
    nid = item["notification_id"]

    r = await api.post(f"/notifications/{nid}/read", headers=headers)
    assert r.status_code == 200
    unread_after = r.json()["data"]["unread"]
    assert (await api.get(f"/notifications/{nid}", headers=headers)).json()["data"]["is_read"] is True
    r = await api.delete(f"/notifications/{nid}/read", headers=headers)
    assert r.json()["data"]["unread"] == unread_after + 1

    r = await api.post("/notifications/read", json={"notification_ids": [nid]}, headers=headers)
    assert r.json()["data"]["marked"] == 1
    r = await api.post("/notifications/read-all", headers=headers)
    assert r.json()["data"]["unread"] == 0
    assert (await api.get("/notifications/unread-count", headers=headers)).json()["data"]["unread"] == 0

    hidden = await crowding(world["cam_b"])
    assert (await api.get(f"/notifications/{hidden['notification_id']}", headers=headers)).status_code == 404
    assert (await api.post(f"/notifications/{hidden['notification_id']}/read", headers=headers)).status_code == 404


async def test_routes_need_a_session(api):
    assert (await api.get("/notifications")).status_code == 401
    assert (await api.get("/notifications/stream")).status_code == 401


async def test_profile_email_opt_in(world, api, monkeypatch):
    headers = _bearer(world["viewer_a"])
    refused = await api.patch("/auth/me", json={"notify_email": True}, headers=headers)
    assert refused.status_code == 409  # no SMTP in this fixture

    monkeypatch.setattr(config, "smtp_host", "smtp.test")
    assert (await api.get("/auth/options")).json()["notification_email"] is True
    r = await api.patch("/auth/me", json={"notify_email": True, "full_name": "  Vee  "}, headers=headers)
    assert r.status_code == 200 and r.json()["notify_email"] is True and r.json()["full_name"] == "Vee"
    assert (await api.get("/auth/me", headers=headers)).json()["notify_email"] is True
    # Opting out works even without SMTP.
    monkeypatch.setattr(config, "smtp_host", "")
    r = await api.patch("/auth/me", json={"notify_email": False}, headers=headers)
    assert r.json()["notify_email"] is False


async def test_camera_alert_settings_are_validated(world, api):
    headers = {**_bearer(world["admin"]), "X-Workspace-Id": str(world["a"]["workspace_id"])}
    bad = await api.post(
        "/cameras",
        json={"name": "alerts-bad", "rtsp_url": "rtsp://x", "enabled": False,
              "settings": {"alert_max_people": 2, "alert_min_people": 5}},
        headers=headers,
    )
    assert bad.status_code == 422
    negative = await api.post(
        "/cameras",
        json={"name": "alerts-neg", "rtsp_url": "rtsp://x", "enabled": False, "settings": {"alert_max_people": -1}},
        headers=headers,
    )
    assert negative.status_code == 422


# ------------------------------------------------------------------- stream
def _events(body: str):
    out = []
    for block in body.split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line and not line.startswith(":"))
        if "event" in lines:
            out.append((lines["event"], json.loads(lines["data"])))
    return out


async def test_stream_delivers_what_the_reader_may_see_then_ends_with_the_token(world, api, monkeypatch):
    # A 2-second token: the stream ends by itself, so the test can read it whole.
    monkeypatch.setattr(config, "access_token_expire_minutes", 2 / 60)
    viewer = world["viewer_a"]
    token = create_access_token(viewer["user_id"], viewer["role"], viewer["token_version"])

    async def produce():
        for _ in range(50):  # until the stream has subscribed
            if hub.count:
                break
            await asyncio.sleep(0.02)
        await crowding(world["cam_b"])           # not the viewer's: filtered out
        return await crowding(world["cam_a"])

    response, mine = await asyncio.gather(
        api.get("/notifications/stream", cookies={config.auth_cookie_name: token}, timeout=10),
        produce(),
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = _events(response.text)
    assert events[0][0] == "ready" and isinstance(events[0][1]["unread"], int)
    delivered = [data for name, data in events if name == "notification"]
    assert [d["notification_id"] for d in delivered] == [mine["notification_id"]]
    assert delivered[0]["is_read"] is False
    assert hub.count == 0  # unsubscribed when it ended


async def test_stream_tells_a_lagging_reader_to_resync(world, api, monkeypatch):
    monkeypatch.setattr(config, "access_token_expire_minutes", 2 / 60)
    admin = world["admin"]
    token = create_access_token(admin["user_id"], admin["role"], admin["token_version"])

    async def overflow():
        for _ in range(50):
            if hub.count:
                break
            await asyncio.sleep(0.02)
        item = {"workspace_id": str(world["a"]["workspace_id"]), "notification_id": "x"}
        for _ in range(150):  # more than the queue holds, before the stream reads
            hub.broadcast(item)

    response, _ = await asyncio.gather(
        api.get("/notifications/stream", headers={"Authorization": f"Bearer {token}"}, timeout=10),
        overflow(),
    )
    assert "resync" in [name for name, _ in _events(response.text)]
