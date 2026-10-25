# app/services/model_registry.py
"""Thread-safe loading of the people and gender detectors, and resolution of
the model device.

Each camera worker gets its own instances: the tracker state lives next to the
model, and sharing one across workers would mix their track ids.
"""

import logging
import os
import threading
from typing import Any, Optional

from app.core.config import config

logger = logging.getLogger(__name__)


class ModelRegistry:
    def __init__(self) -> None:
        self._yolo_lock = threading.Lock()
        self._device: Optional[str] = None

    # ------------------------------------------------------------------ device
    @property
    def device(self) -> str:
        """Resolve the configured device once, falling back to CPU when CUDA is absent."""
        if self._device is not None:
            return self._device

        requested = (config.model_device or "cpu").lower()
        if requested.startswith("cuda"):
            try:
                import torch

                if not torch.cuda.is_available():
                    logger.warning("MODEL_DEVICE=%s but CUDA is unavailable; using cpu.", requested)
                    requested = "cpu"
            except Exception as e:
                logger.warning("Could not probe CUDA (%s); using cpu.", e)
                requested = "cpu"

        self._device = requested
        return self._device

    # -------------------------------------------------------------------- yolo
    def _load(self, weights: str, what: str) -> Any:
        """Build a fresh YOLO instance from local weights. These are custom
        models, so unlike a COCO checkpoint a missing file cannot be downloaded."""
        from ultralytics import YOLO

        if not os.path.exists(weights):
            raise FileNotFoundError(f"{what} weights not found at {weights} (see models/README.md)")
        with self._yolo_lock:
            model = YOLO(weights, task="detect")
        logger.info("%s model loaded (%s) on %s", what, weights, self.device)
        return model

    def create_people_model(self) -> Any:
        return self._load(config.people_model_path, "People")

    def create_gender_model(self) -> Any:
        return self._load(config.gender_model_path, "Gender")


model_registry = ModelRegistry()
