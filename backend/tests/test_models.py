"""Smoke tests with the real weights: run with ``pytest -m slow``.

They read backend/models/{people,gender}.pt and the demo clip in
backend/videos, and need no database.
"""

from pathlib import Path

import cv2
import pytest

from app.core.config import config
from app.services.gender_service import GenderCounter
from app.services.tracking_service import GenderDetector, PersonTracker

pytestmark = pytest.mark.slow

CLIP = Path(__file__).resolve().parent.parent / "videos" / "gender.mp4"


@pytest.fixture(scope="module")
def frames():
    if not CLIP.exists():
        pytest.skip(f"{CLIP} not found")
    capture = cv2.VideoCapture(str(CLIP))
    out = []
    index = 0
    # Every 6th frame of the first ~20 s: roughly the 5 fps a worker processes.
    while len(out) < 100:
        ok, frame = capture.read()
        if not ok:
            break
        if index % 6 == 0:
            out.append(frame)
        index += 1
    capture.release()
    assert out, "could not decode the demo clip"
    return out


def test_gender_model_has_the_three_production_classes():
    detector = GenderDetector()
    assert detector.model.names == {0: "female", 1: "male", 2: "child"}
    assert set(config.gender_class_map.values()) == {"female", "male", "child"}


def test_the_pipeline_counts_people_by_gender_on_the_demo_clip(frames):
    tracker, detector, counter = PersonTracker(), GenderDetector(), GenderCounter()
    seen_people = 0
    labels = set()
    for i, frame in enumerate(frames):
        detections = tracker.track(frame)
        seen_people = max(seen_people, len(detections))
        boxes = detector.detect(frame) if detections and i % config.gender_every_n == 0 else None
        if boxes:
            labels.update(b.label for b in boxes)
        counter.update(detections, i * 0.2, boxes)

    visits = counter.flush(len(frames) * 0.2)
    assert seen_people > 0
    assert labels & {"male", "female"}
    assert visits
    assert any(v.gender in ("male", "female") for v in visits)
