# app/api/routes/analytics_router.py
"""Gender analytics. Every route takes the shared filter bar (get_filters):
start_date, end_date, camera_ids, the five location lists and tz."""

import logging
from typing import Any, Awaitable, Dict, Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.api.deps import get_filters, get_workspace_id, require_role
from app.services.analytics_service import analytics_service
from app.services.filters import Filters
from app.services.stream_manager import stream_manager
from app.services.workspace_service import workspace_service
from app.utils.response import create_response

logger = logging.getLogger(__name__)
router = APIRouter(
    tags=["analytics"], prefix="/analytics", dependencies=[Depends(require_role("viewer"))]
)

Gender = Literal["male", "female", "child"]


async def _run(what: str, call: Awaitable[Any]) -> Any:
    try:
        return await call
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
    except Exception as e:
        logger.error("Error computing %s: %s", what, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Could not compute {what}."
        )


@router.get("/summary")
async def summary(filters: Filters = Depends(get_filters)) -> Dict[str, Any]:
    """Dashboard KPIs: today's visits by gender, the range's visits and average
    dwell, who is in view now, and the workspace's camera workers."""
    data = await _run("the summary", analytics_service.summary(filters, filters.tz))
    cameras = {str(c) for c in await workspace_service.camera_ids(filters.workspace_id)}
    workers = [w for w in stream_manager.status() if w["camera_id"] in cameras]
    data["cameras"] = {
        "total": len(cameras),
        "running": sum(1 for w in workers if w["running"]),
        "connected": sum(1 for w in workers if w["connected"]),
    }
    return create_response(True, "Gender summary.", data)


# ------------------------------------------------- InsightEye's two endpoints
@router.get("/cameras/average-gender")
async def average_gender_by_camera(
    gender: Gender = Query("male"), filters: Filters = Depends(get_filters)
) -> Dict[str, Any]:
    """Average people of one gender in view, per camera (from snapshots).
    The response shape is InsightEye's, plus visit_count per camera."""
    rows = await _run("average gender", analytics_service.average_gender_by_camera(filters, gender))
    return {
        "success": True,
        "gender": gender,
        "count": len(rows),
        "filters_applied": filters.applied(),
        "data": rows,
    }


@router.get("/zones/gender-by-weekday")
async def gender_by_weekday(
    gender: Gender = Query("male"), filters: Filters = Depends(get_filters)
) -> Dict[str, Any]:
    """Average people of one gender in view, per zone and weekday. The
    response shape is InsightEye's."""
    rows = await _run("gender by weekday", analytics_service.gender_by_weekday(filters, gender, filters.tz))
    return {
        "success": True,
        "gender": gender,
        "count": len(rows),
        "filters_applied": filters.applied(),
        "data": rows,
    }


# ------------------------------------------- the extended reports
@router.get("/gender/ratio-trends")
async def ratio_trends(
    interval: Literal["hour", "day", "week", "month"] = Query("day"),
    source: Literal["visits", "occupancy"] = Query("visits"),
    filters: Filters = Depends(get_filters),
) -> Dict[str, Any]:
    """Gender mix per period: visit counts, or average occupancy."""
    rows = await _run(
        "ratio trends", analytics_service.ratio_trends(filters, interval, source, filters.tz)
    )
    return create_response(
        True,
        "Gender ratio trends.",
        {"interval": interval, "source": source, "filters_applied": filters.applied(), "series": rows},
    )


@router.get("/gender/distribution-by-location")
async def distribution_by_location(
    group_by: Literal["location", "area", "building", "floor_level", "zone"] = Query("zone"),
    filters: Filters = Depends(get_filters),
) -> Dict[str, Any]:
    rows = await _run(
        "distribution by location", analytics_service.distribution_by_location(filters, group_by)
    )
    return create_response(
        True,
        "Gender distribution by location.",
        {"group_by": group_by, "filters_applied": filters.applied(), "groups": rows},
    )


@router.get("/gender/peak-hours")
async def peak_hours(filters: Filters = Depends(get_filters)) -> Dict[str, Any]:
    data = await _run("peak hours", analytics_service.peak_hours(filters, filters.tz))
    return create_response(True, "Peak hours by gender.", {**data, "filters_applied": filters.applied()})


@router.get("/visits/hourly-heatmap")
async def hourly_heatmap(
    gender: Optional[Gender] = Query(None), filters: Filters = Depends(get_filters)
) -> Dict[str, Any]:
    """Visits per weekday x hour of day (weekday 0 = Sunday)."""
    cells = await _run("the heatmap", analytics_service.hourly_heatmap(filters, filters.tz, gender))
    return create_response(True, "Visits heatmap.", {"gender": gender, "cells": cells})


@router.get("/filters/options")
async def filter_options(workspace_id: UUID = Depends(get_workspace_id)) -> Dict[str, Any]:
    """Cameras and the location values in use, for the filter bar."""
    data = await _run("filter options", analytics_service.filter_options(workspace_id))
    return create_response(True, "Filter options.", data)
