# app/api/routes/notification_router.py
"""Notifications: the reader's list, unread count and read state, and the live
stream an open console listens on.

Every route covers all the workspaces the caller can see (members: theirs;
admins: all), not just the active one -- a camera going dark in another
workspace is still news. ``workspace_id`` narrows a listing to one.
"""

import asyncio
import json
import logging
import time
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.api.deps import get_current_user, get_event_viewer
from app.services.filters import split_csv
from app.services.notification_service import KINDS, hub, notification_service
from app.services.user_service import user_service
from app.services.workspace_service import workspace_service
from app.utils.response import create_response

logger = logging.getLogger(__name__)
router = APIRouter(tags=["notifications"], prefix="/notifications")

# An idle proxy closes a silent connection; a comment line every so often
# keeps it open and lets the browser notice a dead one.
HEARTBEAT_S = 20.0

_NOT_FOUND = HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found.")


class MarkRead(BaseModel):
    notification_ids: List[UUID] = Field(..., min_length=1, max_length=500)


class MarkAllRead(BaseModel):
    workspace_id: Optional[UUID] = None


async def _checked_workspace(user: Dict[str, Any], workspace_id: Optional[UUID]) -> Optional[UUID]:
    if workspace_id is not None and not await workspace_service.can_access(user, workspace_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found.")
    return workspace_id


def _kinds(kind: Optional[str]) -> Optional[List[str]]:
    kinds = split_csv(kind)
    unknown = [k for k in kinds or [] if k not in KINDS]
    if unknown:
        raise HTTPException(
            status_code=422, detail=f"Unknown kind {unknown[0]!r}; one of {', '.join(KINDS)}."
        )
    return kinds


@router.get("")
async def list_notifications(
    workspace_id: Optional[UUID] = Query(None, description="Only this workspace"),
    unread_only: bool = Query(False),
    kind: Optional[str] = Query(None, description=f"Comma-separated: {', '.join(KINDS)}"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: Dict[str, Any] = Depends(get_current_user),
) -> Dict[str, Any]:
    """Newest first, each with the caller's own is_read."""
    workspace_id = await _checked_workspace(user, workspace_id)
    page = await notification_service.list_for(
        user, workspace_id=workspace_id, unread_only=unread_only, kinds=_kinds(kind),
        limit=limit, offset=offset,
    )
    return create_response(
        True, f"{page['total']} notification(s).", {**page, "limit": limit, "offset": offset}
    )


@router.get("/unread-count")
async def unread_count(
    workspace_id: Optional[UUID] = Query(None),
    user: Dict[str, Any] = Depends(get_current_user),
) -> Dict[str, Any]:
    workspace_id = await _checked_workspace(user, workspace_id)
    count = await notification_service.unread_count(user, workspace_id)
    return create_response(True, f"{count} unread.", {"unread": count})


@router.post("/read")
async def mark_read(payload: MarkRead, user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
    """Ids the caller cannot see are skipped, not refused."""
    marked = await notification_service.mark_read(user, payload.notification_ids)
    return create_response(
        True, f"{marked} marked read.",
        {"marked": marked, "unread": await notification_service.unread_count(user)},
    )


@router.post("/read-all")
async def mark_all_read(
    payload: Optional[MarkAllRead] = None, user: Dict[str, Any] = Depends(get_current_user)
) -> Dict[str, Any]:
    workspace_id = await _checked_workspace(user, payload.workspace_id if payload else None)
    marked = await notification_service.mark_all_read(user, workspace_id)
    return create_response(
        True, f"{marked} marked read.",
        {"marked": marked, "unread": await notification_service.unread_count(user)},
    )


@router.post("/test", status_code=status.HTTP_201_CREATED)
async def send_test(user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
    """A "system" notification in the caller's first workspace, to check the
    bell and the live stream end to end. Everyone in that workspace sees it."""
    workspace_id = await workspace_service.default_for(user)
    if workspace_id is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Your account is not in any workspace yet.")
    item = await notification_service.publish(
        workspace_id=workspace_id,
        kind="system",
        severity="info",
        title="Test notification",
        message=f"Sent by {user['username']}: notifications reach this console.",
    )
    return create_response(True, "Test notification sent.", {"sent": 1 if item else 0})


def _sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


@router.get(
    "/stream",
    responses={200: {"content": {"text/event-stream": {}}, "description": "Server-Sent Events"}},
)
async def stream(request: Request, user: Dict[str, Any] = Depends(get_event_viewer)) -> StreamingResponse:
    """Live notifications as Server-Sent Events, for an EventSource.

    Events: ``ready`` ({unread}) on connect; ``notification`` (one item, as the
    list returns it) as each happens; ``resync`` when this stream fell behind
    and the list should be reloaded. Ends when the access token expires; the
    browser then reconnects on its own, with the cookie a refresh has renewed.
    """
    subscriber = hub.subscribe(user["user_id"])
    if subscriber is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Too many live notification streams. Reload later.",
        )
    unread = await notification_service.unread_count(user)
    expires_at = user["token_expires_at"]

    async def events():
        try:
            # Reconnect after 5 s rather than the browser's default 3.
            yield "retry: 5000\n\n"
            yield _sse("ready", {"unread": unread})
            while True:
                remaining = expires_at - time.time()
                if remaining <= 0:
                    break
                try:
                    item = await asyncio.wait_for(subscriber.queue.get(), min(HEARTBEAT_S, remaining))
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                if subscriber.lagged:
                    subscriber.lagged = False
                    yield _sse("resync", {})
                    continue
                # Re-read the account each time: a deactivated one stops
                # here, and a membership change applies to the next event.
                reader = await user_service.get_by_id(subscriber.user_id)
                if not reader or not reader["is_active"]:
                    break
                if await workspace_service.can_access(reader, UUID(item["workspace_id"])):
                    yield _sse("notification", {**item, "is_read": False, "read_at": None})
        finally:
            hub.unsubscribe(subscriber)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.get("/{notification_id}")
async def get_notification(
    notification_id: UUID, user: Dict[str, Any] = Depends(get_current_user)
) -> Dict[str, Any]:
    item = await notification_service.get_for(user, notification_id)
    if item is None:
        raise _NOT_FOUND
    return create_response(True, "Notification.", item)


@router.post("/{notification_id}/read")
async def mark_one_read(
    notification_id: UUID, user: Dict[str, Any] = Depends(get_current_user)
) -> Dict[str, Any]:
    if await notification_service.get_for(user, notification_id) is None:
        raise _NOT_FOUND
    await notification_service.mark_read(user, [notification_id])
    return create_response(True, "Marked read.", {"unread": await notification_service.unread_count(user)})


@router.delete("/{notification_id}/read")
async def mark_one_unread(
    notification_id: UUID, user: Dict[str, Any] = Depends(get_current_user)
) -> Dict[str, Any]:
    if await notification_service.get_for(user, notification_id) is None:
        raise _NOT_FOUND
    await notification_service.mark_unread(user, notification_id)
    return create_response(True, "Marked unread.", {"unread": await notification_service.unread_count(user)})
