# app/api/routes/visit_router.py
"""Visits: one row per tracked person."""

import csv
import io
import logging
from typing import Any, Dict, Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse

from app.api.deps import ensure_in_workspace, get_filters, get_workspace_id, require_role
from app.core.database import db_manager
from app.services.filters import Filters
from app.services.visit_service import visit_service
from app.utils.response import create_response

logger = logging.getLogger(__name__)
router = APIRouter(tags=["visits"], prefix="/visits", dependencies=[Depends(require_role("viewer"))])

GenderFilter = Optional[Literal["male", "female", "child", "unknown"]]

_CSV_COLUMNS = (
    "visit_id", "camera_name", "location", "area", "building", "floor_level", "zone",
    "gender", "confidence", "first_seen", "last_seen", "dwell_s",
)


@router.get("")
async def list_visits(
    gender: GenderFilter = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    filters: Filters = Depends(get_filters),
) -> Dict[str, Any]:
    try:
        rows, total = await visit_service.list(filters, gender=gender, limit=limit, offset=offset)
    except Exception as e:
        logger.error("Error listing visits: %s", e, exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not list visits.")
    return create_response(
        True, f"{total} visit(s).", {"total": total, "limit": limit, "offset": offset, "items": rows}
    )


@router.get("/export.csv")
async def export_visits(
    gender: GenderFilter = Query(None), filters: Filters = Depends(get_filters)
) -> StreamingResponse:
    """The filtered visits as CSV (at most 100 000 rows, oldest first)."""
    rows = await visit_service.export(filters, gender=gender)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(_CSV_COLUMNS)
    for row in rows:
        writer.writerow(
            [row[c].isoformat() if hasattr(row[c], "isoformat") else row[c] for c in _CSV_COLUMNS]
        )
    buffer.seek(0)
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="visits.csv"'},
    )


@router.get("/{visit_id}")
async def get_visit(visit_id: UUID, workspace_id: UUID = Depends(get_workspace_id)) -> Dict[str, Any]:
    await ensure_in_workspace("visit", visit_id, workspace_id, "Visit not found.")
    row = await db_manager.execute_query(
        """
        SELECT f.*, c.name AS camera_name, c.location, c.area, c.building, c.floor_level, c.zone
        FROM visit f JOIN camera c ON c.camera_id = f.camera_id WHERE f.visit_id = $1
        """,
        (visit_id,),
        fetch_one=True,
    )
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Visit not found.")
    return create_response(True, "Visit.", visit_service._out(row))
