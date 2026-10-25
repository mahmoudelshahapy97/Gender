# app/api/routes/snapshot_router.py
"""Occupancy snapshots: counts by gender every SNAPSHOT_INTERVAL_S, each with
its annotated frame."""

import logging
from typing import Any, Dict
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from app.api.deps import (
    ensure_in_workspace,
    ensure_visible_resource,
    get_filters,
    get_image_viewer,
    get_workspace_id,
    require_role,
)
from app.services.filters import Filters
from app.services.snapshot_service import snapshot_service
from app.utils.response import create_response

logger = logging.getLogger(__name__)
router = APIRouter(tags=["snapshots"], prefix="/snapshots")

_NOT_FOUND = "Snapshot not found."


@router.get("")
async def list_snapshots(
    limit: int = Query(48, ge=1, le=500),
    offset: int = Query(0, ge=0),
    min_people: int = Query(0, ge=0, description="Only snapshots with at least this many people"),
    filters: Filters = Depends(get_filters),
    _: Dict[str, Any] = Depends(require_role("viewer")),
) -> Dict[str, Any]:
    try:
        rows, total = await snapshot_service.list(filters, limit=limit, offset=offset, min_people=min_people)
    except Exception as e:
        logger.error("Error listing snapshots: %s", e, exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not list snapshots.")
    return create_response(
        True, f"{total} snapshot(s).", {"total": total, "limit": limit, "offset": offset, "items": rows}
    )


@router.get("/{snapshot_id}")
async def get_snapshot(
    snapshot_id: UUID,
    workspace_id: UUID = Depends(get_workspace_id),
    _: Dict[str, Any] = Depends(require_role("viewer")),
) -> Dict[str, Any]:
    await ensure_in_workspace("snapshot", snapshot_id, workspace_id, _NOT_FOUND)
    row = await snapshot_service.get(snapshot_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_NOT_FOUND)
    return create_response(True, "Snapshot.", row)


@router.get(
    "/{snapshot_id}/frame",
    responses={200: {"content": {"image/jpeg": {}}, "description": "Annotated frame"}},
)
async def snapshot_frame(
    snapshot_id: UUID, current_user: Dict[str, Any] = Depends(get_image_viewer)
) -> Response:
    """The annotated frame, for an ``<img src>`` (cookie-authenticated)."""
    await ensure_visible_resource(current_user, "snapshot", snapshot_id)
    data = await snapshot_service.frame(snapshot_id)
    if not data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This snapshot has no frame.")
    return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})
