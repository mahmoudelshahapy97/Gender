"""When a notification is due - the state machines in app/services/alerts.py,
and the supervisor's health tick that drives HealthWatch. No DB, no camera:
time is passed in, and the publisher is replaced by a list."""

from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.core.config import config
from app.services import stream_manager as sm
from app.services.alerts import HIGH, LOW, OFFLINE, ONLINE, HealthWatch, OccupancyAlerts


def alerts(**settings):
    return OccupancyAlerts(settings, sustain_s=10, cooldown_s=600)


def feed(a, counts, start=0.0, step=1.0):
    """Counts one second apart; the alerts fired, with when."""
    fired = []
    for i, count in enumerate(counts):
        now = start + i * step
        fired += [(now, alert) for alert in a.observe(count, now)]
    return fired


# ---------------------------------------------------------------- occupancy
def test_no_thresholds_means_off():
    assert not alerts().enabled
    assert not alerts(alert_max_people="", alert_min_people=None).enabled
    assert not alerts(alert_max_people="many").enabled


def test_a_short_spike_does_not_alert():
    a = alerts(alert_max_people=5)
    assert feed(a, [9] * 9 + [3] * 20) == []


def test_a_sustained_crossing_alerts_once():
    a = alerts(alert_max_people=5)
    fired = feed(a, [8] * 120)
    assert len(fired) == 1
    when, alert = fired[0]
    assert when == 10
    assert (alert.kind, alert.person_count, alert.threshold) == (HIGH, 8, 5)


def test_equal_to_the_limit_is_not_past_it():
    assert feed(alerts(alert_max_people=5), [5] * 60) == []
    assert feed(alerts(alert_min_people=2), [2] * 60) == []


def test_rearms_after_returning_inside_but_respects_the_cooldown():
    a = alerts(alert_max_people=5)
    first = feed(a, [8] * 20)                       # alerts at t=10
    feed(a, [2] * 20, start=20)                     # back inside long enough: re-armed
    assert feed(a, [8] * 20, start=40) == []        # second crossing, inside the cooldown
    later = feed(a, [2] * 20 + [9] * 20, start=700)  # after it: alerts again
    assert len(first) == 1 and len(later) == 1 and later[0][1].person_count == 9


def test_flicker_inside_does_not_rearm():
    a = alerts(alert_max_people=5)
    feed(a, [8] * 15)
    # Dips under the limit for less than the sustain time, many times over.
    pattern = ([3] * 5 + [8] * 5) * 100
    assert feed(a, pattern, start=15) == []


def test_minimum_alerts_below_and_zero_minimum_is_off():
    fired = feed(alerts(alert_min_people=3), [1] * 30)
    assert [a.kind for _, a in fired] == [LOW]
    assert not alerts(alert_min_people=0).enabled


def test_both_directions_are_independent():
    a = alerts(alert_max_people=5, alert_min_people=2)
    fired = feed(a, [8] * 15 + [0] * 15)
    assert [alert.kind for _, alert in fired] == [HIGH, LOW]


def test_rebuilt_worker_keeps_the_cooldown(monkeypatch):
    manager = sm.StreamManager()
    camera = {"camera_id": uuid4(), "name": "c", "rtsp_url": "rtsp://x",
              "settings": {"alert_max_people": 5}}
    first = manager._new_worker(camera)
    assert manager._new_worker(camera).alerts is first.alerts
    changed = {**camera, "settings": {"alert_max_people": 6}}
    assert manager._new_worker(changed).alerts is not first.alerts


# ------------------------------------------------------------------- health
def test_offline_after_the_grace_then_online_once():
    w = HealthWatch(offline_after_s=90, cooldown_s=900)
    cam = "cam"
    assert w.observe(cam, True, 0) is None
    assert w.observe(cam, False, 15) is None
    assert w.observe(cam, False, 90) is None
    assert w.observe(cam, False, 105) == OFFLINE
    assert w.observe(cam, False, 120) is None       # once, not per tick
    assert w.down_for(cam, 300) == 285
    assert w.observe(cam, True, 300) == ONLINE
    assert w.observe(cam, True, 315) is None


def test_a_blip_is_not_an_outage():
    w = HealthWatch(offline_after_s=90, cooldown_s=900)
    for t in range(0, 600, 15):
        assert w.observe("cam", t % 60 != 0, t) is None


def test_flapping_inside_the_cooldown_stays_quiet_in_pairs():
    w = HealthWatch(offline_after_s=30, cooldown_s=900)
    events = []
    t = 0
    for _ in range(5):  # down 60 s, up 60 s, five times
        for _ in range(4):
            events.append(w.observe("cam", False, t)); t += 15
        for _ in range(4):
            events.append(w.observe("cam", True, t)); t += 15
    assert [e for e in events if e] == [OFFLINE, ONLINE]


def test_restored_offline_owes_its_recovery():
    w = HealthWatch(offline_after_s=90, cooldown_s=900)
    w.restore("cam", offline=True, now=0)
    assert w.observe("cam", False, 500) is None     # already reported
    assert w.observe("cam", True, 515) == ONLINE


def test_forget_drops_the_state():
    w = HealthWatch(offline_after_s=10, cooldown_s=0)
    w.observe("cam", False, 0)
    assert w.observe("cam", False, 20) == OFFLINE
    w.forget("cam")
    assert w.observe("cam", True, 30) is None


# ----------------------------------------------- the supervisor's health tick
def worker(**overrides):
    base = dict(running=True, state=sm.RUNNING, connected=True, seconds_since_progress=0.5, last_error=None)
    base.update(overrides)
    return SimpleNamespace(**base)


@pytest.fixture
def tick(monkeypatch):
    """A manager whose camera list and publisher are fakes; returns
    (manager, camera, published, clock)."""
    monkeypatch.setattr(config, "notifications_enabled", True)
    monkeypatch.setattr(config, "camera_offline_after_s", 30.0)
    manager = sm.StreamManager()
    manager.health = HealthWatch(30.0, 0.0)
    camera = {"camera_id": uuid4(), "workspace_id": uuid4(), "name": "Door", "enabled": True}
    cameras = [camera]
    published = []
    clock = {"now": 1000.0}

    async def list_cameras(enabled_only=False, workspace_id=None):
        return list(cameras)

    async def camera_health(cam, kind, down_for_s=0.0, last_error=None):
        published.append((kind, round(down_for_s), last_error))

    async def last_health_kind(camera_id):
        return None

    monkeypatch.setattr(sm.camera_service, "list_cameras", list_cameras)
    monkeypatch.setattr(sm.notification_service, "camera_health", camera_health)
    monkeypatch.setattr(sm.notification_service, "last_health_kind", last_health_kind)
    monkeypatch.setattr(sm.time, "monotonic", lambda: clock["now"])
    return manager, camera, cameras, published, clock


async def test_tick_reports_a_dead_worker_and_its_recovery(tick):
    manager, camera, _, published, clock = tick
    manager.workers[camera["camera_id"]] = worker(state=sm.RECONNECTING, connected=False,
                                                  last_error="could not open stream (attempt 3)")
    for _ in range(4):
        await manager.watch_health()
        clock["now"] += 15
    assert published == [(OFFLINE, 30, "could not open stream (attempt 3)")]

    manager.workers[camera["camera_id"]] = worker()
    await manager.watch_health()
    assert published[-1] == (ONLINE, 60, None)


async def test_tick_counts_a_missing_worker_as_down(tick):
    manager, _, _, published, clock = tick
    for _ in range(3):
        await manager.watch_health()
        clock["now"] += 15
    assert published == [(OFFLINE, 30, "no worker")]


async def test_a_stalled_connected_worker_is_down(tick, monkeypatch):
    manager, camera, _, published, clock = tick
    monkeypatch.setattr(config, "rtsp_open_timeout", 15.0)
    manager.workers[camera["camera_id"]] = worker(seconds_since_progress=40)
    for _ in range(3):
        await manager.watch_health()
        clock["now"] += 15
    assert [p[0] for p in published] == [OFFLINE]


async def test_disabled_camera_is_forgotten(tick):
    manager, camera, cameras, published, clock = tick
    await manager.watch_health()
    assert manager.health.known(camera["camera_id"])
    cameras.clear()
    await manager.watch_health()
    assert not manager.health.known(camera["camera_id"])
    assert published == []


async def test_restart_resumes_an_outstanding_offline(tick, monkeypatch):
    manager, camera, _, published, _ = tick

    async def last_health_kind(camera_id):
        return OFFLINE

    monkeypatch.setattr(sm.notification_service, "last_health_kind", last_health_kind)
    manager.workers[camera["camera_id"]] = worker()
    await manager.watch_health()
    assert published == [(ONLINE, 0, None)]
