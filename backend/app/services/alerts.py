# app/services/alerts.py
"""When a camera's numbers deserve a notification. Pure state machines: no
database, no clock of their own -- the caller passes ``now`` -- so the tests
can walk them through hours in microseconds.

OccupancyAlerts: per camera, the people count against the optional
``alert_max_people`` / ``alert_min_people`` settings (InsightEye's
greater_than / less_than). A threshold has to stay crossed for
ALERT_SUSTAIN_S before it alerts, and alerts once per crossing: a count that
sits above the limit all afternoon is one notification, not one a minute. It
re-arms after the count has been back inside the limit for the same sustain
time, and never alerts more often than ALERT_COOLDOWN_S.

HealthWatch: per camera, whether its worker is delivering frames. Down for
CAMERA_OFFLINE_AFTER_S is "offline"; healthy again after that is "online".
A camera that flaps inside CAMERA_HEALTH_COOLDOWN_S stays quiet, offline and
online alike, so the two always come in pairs.
"""

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

HIGH = "occupancy_high"
LOW = "occupancy_low"
OFFLINE = "camera_offline"
ONLINE = "camera_online"


def _limit(settings: Dict[str, Any], key: str) -> Optional[int]:
    """A blank, missing or malformed threshold is off; 0 is a real minimum."""
    value = settings.get(key)
    if value is None or value == "":
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


@dataclass
class _Direction:
    kind: str
    threshold: int
    crossed_since: Optional[float] = None   # when the count first went past the threshold
    inside_since: Optional[float] = None    # when it first came back
    active: bool = False                    # an alert covers the current crossing
    last_alert_at: Optional[float] = None

    def past(self, count: int) -> bool:
        return count > self.threshold if self.kind == HIGH else count < self.threshold


@dataclass(frozen=True)
class OccupancyAlert:
    kind: str
    person_count: int
    threshold: int


class OccupancyAlerts:
    def __init__(self, settings: Dict[str, Any], sustain_s: float, cooldown_s: float) -> None:
        self.sustain_s = max(0.0, sustain_s)
        self.cooldown_s = max(0.0, cooldown_s)
        self._directions: List[_Direction] = []
        high = _limit(settings, "alert_max_people")
        low = _limit(settings, "alert_min_people")
        if high is not None:
            self._directions.append(_Direction(HIGH, high))
        if low is not None and low > 0:  # fewer than 0 people cannot happen
            self._directions.append(_Direction(LOW, low))

    @property
    def enabled(self) -> bool:
        return bool(self._directions)

    @property
    def thresholds(self) -> tuple:
        """What the camera asked for; a worker rebuilt with the same keeps this
        instance, and with it the cooldown."""
        return tuple((d.kind, d.threshold) for d in self._directions)

    def observe(self, person_count: int, now: float) -> List[OccupancyAlert]:
        fired: List[OccupancyAlert] = []
        for d in self._directions:
            if d.past(person_count):
                d.inside_since = None
                if d.crossed_since is None:
                    d.crossed_since = now
                if d.active or now - d.crossed_since < self.sustain_s:
                    continue
                d.active = True
                if d.last_alert_at is None or now - d.last_alert_at >= self.cooldown_s:
                    d.last_alert_at = now
                    fired.append(OccupancyAlert(d.kind, person_count, d.threshold))
            else:
                d.crossed_since = None
                if not d.active:
                    continue
                if d.inside_since is None:
                    d.inside_since = now
                if now - d.inside_since >= self.sustain_s:
                    d.active = False
                    d.inside_since = None
        return fired


@dataclass
class _Health:
    down_since: Optional[float] = None
    offline: bool = False                  # an offline notification is outstanding
    suppressed: bool = False               # down, but inside the cooldown: stay quiet
    last_offline_at: Optional[float] = None


class HealthWatch:
    """Fed every supervisor tick with each enabled camera's health."""

    def __init__(self, offline_after_s: float, cooldown_s: float) -> None:
        self.offline_after_s = max(0.0, offline_after_s)
        self.cooldown_s = max(0.0, cooldown_s)
        self._cameras: Dict[Any, _Health] = {}

    def known(self, camera_id: Any) -> bool:
        return camera_id in self._cameras

    def cameras(self) -> List[Any]:
        return list(self._cameras)

    def restore(self, camera_id: Any, offline: bool, now: float) -> None:
        """After an API restart: the last notification said the camera was
        offline, so its recovery is still owed."""
        self._cameras[camera_id] = _Health(offline=offline, last_offline_at=now if offline else None)

    def forget(self, camera_id: Any) -> None:
        """The operator stopped or deleted the camera: nothing to report."""
        self._cameras.pop(camera_id, None)

    def observe(self, camera_id: Any, healthy: bool, now: float) -> Optional[str]:
        h = self._cameras.setdefault(camera_id, _Health())
        if healthy:
            h.down_since = None
            if h.suppressed:
                h.suppressed = False
                return None
            if h.offline:
                h.offline = False
                return ONLINE
            return None

        if h.down_since is None:
            h.down_since = now
        if h.offline or h.suppressed or now - h.down_since < self.offline_after_s:
            return None
        if h.last_offline_at is not None and now - h.last_offline_at < self.cooldown_s:
            h.suppressed = True
            return None
        h.offline = True
        h.last_offline_at = now
        return OFFLINE

    def down_for(self, camera_id: Any, now: float) -> float:
        h = self._cameras.get(camera_id)
        return now - h.down_since if h and h.down_since is not None else 0.0
