# app/services/tracking_service.py
"""Thin wrappers turning ultralytics output into plain records.

Keeping the ultralytics types confined to this module lets the counting logic
(gender_service) be exercised with synthetic boxes and no model at all.
"""

import logging
from dataclasses import dataclass
from typing import Any, List, Optional, Sequence

import numpy as np

from app.core.config import config
from app.services.model_registry import model_registry
from app.utils.geometry_utils import Box, box_in_polygon

logger = logging.getLogger(__name__)


@dataclass
class Detection:
    """One tracked person in one frame."""

    track_id: int
    confidence: float
    box: Box


@dataclass
class GenderBox:
    """One gender.pt box: a person, labelled female / male / child."""

    label: str
    confidence: float
    box: Box


def _half(device: str) -> Optional[int]:
    return 16 if config.yolo_half and device.startswith("cuda") else None


class PersonTracker:
    """people.pt + ByteTrack, one per worker (not thread-safe by design).

    Runs the detector and ByteTrack as separate steps rather than through
    ``model.track()``, so the tracker config is ours and the tracker can be
    reset on a reconnect without reloading the model.
    """

    def __init__(self, model: Optional[Any] = None, roi: Optional[Sequence[Sequence[float]]] = None) -> None:
        self.model = model if model is not None else model_registry.create_people_model()
        self.roi = roi
        self._tracker = self._new_tracker()

    @staticmethod
    def _new_tracker() -> Any:
        from ultralytics.trackers.byte_tracker import BYTETracker
        from ultralytics.utils import YAML, IterableSimpleNamespace
        from ultralytics.utils.checks import check_yaml

        cfg = IterableSimpleNamespace(**YAML.load(check_yaml(config.yolo_tracker)))
        return BYTETracker(args=cfg)

    def track(self, frame: np.ndarray) -> List[Detection]:
        """Detect and track the people in one frame (inside the ROI, if any)."""
        if frame is None or frame.size == 0:
            return []

        device = model_registry.device
        results = self.model.predict(
            frame,
            classes=[config.people_class_id],
            conf=config.people_confidence,
            imgsz=config.yolo_input_size,
            quantize=_half(device),
            device=device,
            verbose=False,
        )
        if not results:
            return []

        try:
            boxes = results[0].boxes.cpu().numpy()
            tracks = self._tracker.update(boxes, frame)
        except Exception as e:
            logger.error("Failed to track people: %s", e, exc_info=True)
            return []

        detections: List[Detection] = []
        for row in tracks:
            box = (float(row[0]), float(row[1]), float(row[2]), float(row[3]))
            if self.roi and not box_in_polygon(box, self.roi):
                continue
            detections.append(Detection(track_id=int(row[4]), confidence=float(row[5]), box=box))
        return detections

    def reset(self) -> None:
        """Drop tracker state, e.g. after a stream reconnect where ids are meaningless."""
        self._tracker.reset()


class GenderDetector:
    """gender.pt on the whole frame - the way InsightEye runs it. Its boxes are
    matched to the person tracks by gender_service."""

    def __init__(self, model: Optional[Any] = None) -> None:
        self.model = model if model is not None else model_registry.create_gender_model()

    def detect(self, frame: np.ndarray) -> List[GenderBox]:
        if frame is None or frame.size == 0:
            return []

        device = model_registry.device
        try:
            results = self.model.predict(
                frame,
                conf=config.gender_confidence,
                imgsz=config.yolo_input_size,
                quantize=_half(device),
                device=device,
                verbose=False,
            )
            if not results:
                return []
            boxes = results[0].boxes.cpu().numpy()
        except Exception as e:
            logger.error("Gender detection failed: %s", e, exc_info=True)
            return []

        out: List[GenderBox] = []
        for xyxy, cls, conf in zip(boxes.xyxy, boxes.cls.astype(int), boxes.conf):
            label = config.gender_class_map.get(int(cls))
            if label is None:
                continue
            out.append(
                GenderBox(
                    label=label,
                    confidence=float(conf),
                    box=(float(xyxy[0]), float(xyxy[1]), float(xyxy[2]), float(xyxy[3])),
                )
            )
        return out
