# app/api/routes/system_router.py
import logging
from typing import Any, Dict
from uuid import UUID

from fastapi import APIRouter, Depends

from app.api.deps import get_workspace_id, require_role
from app.core.config import config
from app.services.model_registry import model_registry
from app.services.notification_service import hub
from app.services.object_store import object_store
from app.services.stream_manager import stream_manager
from app.services.workspace_service import workspace_service
from app.utils.response import create_response

logger = logging.getLogger(__name__)
router = APIRouter(
    tags=["system"], prefix="/system", dependencies=[Depends(require_role("viewer"))]
)


@router.get("/workers")
async def worker_status(workspace_id: UUID = Depends(get_workspace_id)) -> Dict[str, Any]:
    """State of the active workspace's camera workers held by the stream manager."""
    cameras = {str(camera_id) for camera_id in await workspace_service.camera_ids(workspace_id)}
    workers = [w for w in stream_manager.status() if str(w.get("camera_id")) in cameras]
    return create_response(
        True,
        f"{len(workers)} worker(s).",
        {
            "count": len(workers),
            "running": sum(1 for w in workers if w["running"]),
            "connected": sum(1 for w in workers if w["connected"]),
            "workers": workers,
        },
    )


@router.get("/config")
async def effective_config() -> Dict[str, Any]:
    """The tuning values in force - useful when the counts look off."""
    return create_response(
        True,
        "Effective configuration.",
        {
            "environment": config.environment,
            "device": model_registry.device,
            "detection": {
                "people_model_path": config.people_model_path,
                "people_confidence": config.people_confidence,
                "gender_model_path": config.gender_model_path,
                "gender_confidence": config.gender_confidence,
                "gender_classes": config.gender_class_map,
                "yolo_input_size": config.yolo_input_size,
                "tracker": config.yolo_tracker,
            },
            "counting": {
                "gender_every_n": config.gender_every_n,
                "gender_match_overlap": config.gender_match_overlap,
                "gender_min_votes": config.gender_min_votes,
                "visit_gap_seconds": config.visit_gap_seconds,
                "visit_min_dwell_s": config.visit_min_dwell_s,
                "snapshot_interval_s": config.snapshot_interval_s,
            },
            "stream": {
                "frame_skip": config.frame_skip,
                "target_process_fps": config.target_process_fps,
            },
            "storage": {
                # Snapshot frames in MinIO; records and object keys in Postgres.
                "object_store": "minio" if object_store.enabled else "disabled",
                "endpoint": config.minio_endpoint or None,
                "bucket": config.minio_bucket if object_store.enabled else None,
                "reachable": await object_store.healthy() if object_store.enabled else False,
            },
            "retention": {
                "enabled": config.retention_enabled,
                "frame_retention_days": config.frame_retention_days,
                "data_retention_days": config.data_retention_days,
                "notification_retention_days": config.notification_retention_days,
            },
            "notifications": {
                "enabled": config.notifications_enabled,
                "alert_sustain_s": config.alert_sustain_s,
                "alert_cooldown_s": config.alert_cooldown_s,
                "camera_offline_after_s": config.camera_offline_after_s,
                "camera_health_cooldown_s": config.camera_health_cooldown_s,
                "email": config.notification_email_available,
                "live_streams": hub.count,
            },
        },
    )
