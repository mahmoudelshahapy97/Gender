# app/schemas/camera_schemas.py
from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


ALERT_KEYS = ("alert_max_people", "alert_min_people")


def check_alert_settings(settings: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """alert_max_people / alert_min_people: whole numbers >= 0, or absent (off)."""
    if not settings:
        return settings
    for key in ALERT_KEYS:
        if key not in settings or settings[key] is None:
            continue
        value = settings[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value != int(value) or value < 0:
            raise ValueError(f"{key} must be a whole number of people, 0 or more")
        settings[key] = int(value)
    high, low = settings.get("alert_max_people"), settings.get("alert_min_people")
    if high is not None and low is not None and low > high:
        raise ValueError("alert_min_people is above alert_max_people")
    return settings


class CameraCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    rtsp_url: str = Field(..., description="rtsp://user:pass@host:554/stream, or a local file path")
    location: Optional[str] = Field(None, max_length=200)
    area: Optional[str] = Field(None, max_length=200)
    building: Optional[str] = Field(None, max_length=200)
    floor_level: Optional[str] = Field(None, max_length=200)
    zone: Optional[str] = Field(None, max_length=200)
    enabled: bool = True
    roi: Optional[List[List[float]]] = Field(
        None, description="Optional polygon [[x,y], ...]: only people whose box centre is inside are counted"
    )
    settings: Optional[Dict[str, Any]] = Field(
        None,
        description="Per-camera overrides, e.g. {'snapshot_interval_s': 30, 'min_votes': 3}",
    )

    @field_validator("roi")
    @classmethod
    def validate_roi(cls, value: Optional[List[List[float]]]) -> Optional[List[List[float]]]:
        if value is None:
            return None
        if len(value) < 3:
            raise ValueError("roi needs at least 3 points")
        if any(len(point) != 2 for point in value):
            raise ValueError("each roi point must be [x, y]")
        return value

    @field_validator("settings")
    @classmethod
    def validate_alerts(cls, value: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        return check_alert_settings(value)


class CameraUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    rtsp_url: Optional[str] = None
    location: Optional[str] = None
    area: Optional[str] = None
    building: Optional[str] = None
    floor_level: Optional[str] = None
    zone: Optional[str] = None
    enabled: Optional[bool] = None
    roi: Optional[List[List[float]]] = None
    settings: Optional[Dict[str, Any]] = None

    @field_validator("settings")
    @classmethod
    def validate_alerts(cls, value: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        return check_alert_settings(value)


class CameraResponse(BaseModel):
    camera_id: UUID
    workspace_id: Optional[UUID] = None
    name: str
    rtsp_url: str
    location: Optional[str] = None
    area: Optional[str] = None
    building: Optional[str] = None
    floor_level: Optional[str] = None
    zone: Optional[str] = None
    enabled: bool
    roi: Optional[Any] = None
    settings: Optional[Any] = None
    created_at: datetime
    updated_at: Optional[datetime] = None


class TrackedPerson(BaseModel):
    track_id: int
    gender: str
    votes: Dict[str, float] = {}
    box: List[float]
    seconds_in_view: float = 0.0
