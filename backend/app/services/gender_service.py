# app/services/gender_service.py
"""Turns tracked people plus gender boxes into visits and occupancy.

InsightEye counts gender per frame: male_count is how many "male" boxes one
frame had, so a person who stands in view for an hour is counted in every
snapshot of that hour, and one misread frame flips the tally. Here every
person is a track (people.pt + ByteTrack) and the gender boxes vote for the
track they overlap. A track's label is the confidence-weighted winner of its
votes, and only once it has GENDER_MIN_VOTES of them; before that it is
"unknown". That gives two figures:

* a **visit** per track when it ends - "how many women came in today";
* **occupancy** at any moment - "how many men are in view now", the figure
  the InsightEye charts average.

Pure logic: no model, no database, no clock of its own, so the tests drive it
with synthetic boxes.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

from app.core.config import config
from app.services.tracking_service import Detection, GenderBox
from app.utils.geometry_utils import iou, overlap_of_smaller

logger = logging.getLogger(__name__)

LABELS = ("male", "female", "child")
UNKNOWN = "unknown"


@dataclass
class CountingParams:
    match_overlap: float = 0.6
    min_votes: int = 2
    visit_gap_seconds: float = 6.0
    visit_min_dwell_s: float = 1.5

    @classmethod
    def from_settings(cls, overrides: Optional[Dict[str, Any]] = None) -> "CountingParams":
        """Global .env values, overridden per camera by ``camera.settings``."""
        overrides = overrides or {}
        defaults = {
            "match_overlap": config.gender_match_overlap,
            "min_votes": config.gender_min_votes,
            "visit_gap_seconds": config.visit_gap_seconds,
            "visit_min_dwell_s": config.visit_min_dwell_s,
        }
        values = {}
        for name, default in defaults.items():
            raw = overrides.get(name, default)
            try:
                values[name] = type(default)(raw)
            except (TypeError, ValueError):
                logger.warning("Ignoring bad camera setting %s=%r", name, raw)
                values[name] = default
        return cls(**values)


@dataclass
class PersonTrack:
    track_id: int
    first_seen: float
    last_seen: float
    box: tuple
    votes: Dict[str, float] = field(default_factory=dict)
    vote_count: int = 0

    def vote(self, label: str, weight: float) -> None:
        self.votes[label] = self.votes.get(label, 0.0) + weight
        self.vote_count += 1

    def label(self, min_votes: int) -> str:
        if self.vote_count < min_votes or not self.votes:
            return UNKNOWN
        return max(self.votes.items(), key=lambda kv: kv[1])[0]

    def label_confidence(self) -> Optional[float]:
        total = sum(self.votes.values())
        if total <= 0:
            return None
        return max(self.votes.values()) / total

    @property
    def dwell_s(self) -> float:
        return max(0.0, self.last_seen - self.first_seen)


@dataclass
class Visit:
    """A finished track, ready for the visit table."""

    track_key: str
    gender: str
    confidence: Optional[float]
    votes: Dict[str, float]
    first_seen: datetime
    last_seen: datetime
    dwell_s: float


def _utc(ts: float) -> datetime:
    return datetime.fromtimestamp(ts, tz=timezone.utc)


def assign_gender_boxes(
    tracks: Sequence[Detection], gender_boxes: Sequence[GenderBox], min_overlap: float
) -> Dict[int, GenderBox]:
    """track_id -> the gender box that belongs to it.

    A gender box is a person's when it covers ``min_overlap`` of the smaller of
    the two boxes (gender.pt often boxes just the upper body); between several
    candidates the higher IoU wins. Greedy, best pair first, so one box is
    never given to two people and each person gets at most one box per frame.
    """
    pairs = []
    for gi, g in enumerate(gender_boxes):
        for t in tracks:
            cover = overlap_of_smaller(g.box, t.box)
            if cover >= min_overlap:
                pairs.append((cover, iou(g.box, t.box), gi, t.track_id))
    pairs.sort(reverse=True)

    taken_boxes, out = set(), {}
    for _, _, gi, track_id in pairs:
        if gi in taken_boxes or track_id in out:
            continue
        taken_boxes.add(gi)
        out[track_id] = gender_boxes[gi]
    return out


class GenderCounter:
    """Per-camera state: one PersonTrack per live track id."""

    def __init__(self, params: Optional[CountingParams] = None, session: str = "") -> None:
        self.params = params or CountingParams()
        # Track ids restart with every tracker; the session tag keeps the
        # track_key of a visit unique across worker restarts.
        self.session = session
        self.tracks: Dict[int, PersonTrack] = {}
        self._visible: List[int] = []

    def update(
        self,
        detections: Sequence[Detection],
        now: float,
        gender_boxes: Optional[Sequence[GenderBox]] = None,
    ) -> List[Visit]:
        """Feed one processed frame; returns the visits that ended with it.

        ``gender_boxes`` is None on frames gender.pt did not run on.
        """
        for d in detections:
            track = self.tracks.get(d.track_id)
            if track is None:
                track = PersonTrack(d.track_id, first_seen=now, last_seen=now, box=d.box)
                self.tracks[d.track_id] = track
            track.last_seen = now
            track.box = d.box
        self._visible = [d.track_id for d in detections]

        if gender_boxes:
            for track_id, g in assign_gender_boxes(detections, gender_boxes, self.params.match_overlap).items():
                self.tracks[track_id].vote(g.label, g.confidence)

        return self._expire(now)

    def _expire(self, now: float, force: bool = False) -> List[Visit]:
        ended = [
            t for t in self.tracks.values()
            if force or now - t.last_seen > self.params.visit_gap_seconds
        ]
        visits = []
        for track in ended:
            del self.tracks[track.track_id]
            if track.dwell_s < self.params.visit_min_dwell_s:
                continue
            visits.append(self._visit(track))
        if force:
            self._visible = []
        return visits

    def flush(self, now: float) -> List[Visit]:
        """End every open track - the stream stopped or reconnected."""
        return self._expire(now, force=True)

    def _visit(self, track: PersonTrack) -> Visit:
        label = track.label(self.params.min_votes)
        return Visit(
            track_key=f"{self.session}:{track.track_id}" if self.session else str(track.track_id),
            gender=label,
            confidence=round(track.label_confidence(), 3) if label != UNKNOWN and track.votes else None,
            votes={k: round(v, 3) for k, v in track.votes.items()},
            first_seen=_utc(track.first_seen),
            last_seen=_utc(track.last_seen),
            dwell_s=round(track.dwell_s, 2),
        )

    def label_of(self, track_id: int) -> str:
        track = self.tracks.get(track_id)
        return track.label(self.params.min_votes) if track else UNKNOWN

    def occupancy(self) -> Dict[str, int]:
        """The people in the latest frame by settled label. The parts always
        add up to person_count (the occupancy_parts_check constraint)."""
        counts = {"male_count": 0, "female_count": 0, "child_count": 0, "unknown_count": 0}
        for track_id in self._visible:
            counts[f"{self.label_of(track_id)}_count"] += 1
        counts["person_count"] = len(self._visible)
        return counts

    def snapshot(self) -> List[Dict[str, Any]]:
        """The live view's per-person state, for /cameras/{id}/status."""
        return [
            {
                "track_id": track_id,
                "gender": self.label_of(track_id),
                "votes": {k: round(v, 2) for k, v in self.tracks[track_id].votes.items()},
                "box": list(self.tracks[track_id].box),
                "seconds_in_view": round(self.tracks[track_id].dwell_s, 1),
            }
            for track_id in self._visible
            if track_id in self.tracks
        ]

    def reset(self) -> None:
        self.tracks.clear()
        self._visible = []
