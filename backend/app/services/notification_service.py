# app/services/notification_service.py
"""Notifications: what happened, who may see it, who has read it, and getting
it to them -- live to open consoles, and by mail to those who opted in.

After InsightEye's notification_service, which kept one row per recipient (the
stream owner). Here a notification belongs to a workspace, like everything
else, and reaches everyone who can see that workspace: its members, and every
admin. Read state is per account (notification_read).

Two producers, both in stream_manager: a worker's OccupancyAlerts (people
count past the camera's alert thresholds) and the supervisor's HealthWatch
(camera offline / back online). ``publish`` never raises -- a notification
that cannot be stored must not take a camera worker down with it.

Live delivery is in-process: each open console holds one Server-Sent Events
stream (GET /notifications/stream), fed from NotificationHub. That works
because the API runs as a single replica (see docker-compose.yml).
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from html import escape
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple
from uuid import UUID

from app.core.config import config
from app.core.database import db_manager
from app.services import mailer
from app.services.alerts import HIGH, LOW, OFFLINE, ONLINE, OccupancyAlert
from app.services.workspace_service import is_admin

logger = logging.getLogger(__name__)

SYSTEM = "system"
KINDS = (HIGH, LOW, OFFLINE, ONLINE, SYSTEM)
SEVERITIES = ("info", "warning", "critical")

# Columns every listing returns, with the reader's own read state.
_SELECT = """
    SELECT n.*, w.name AS workspace_name, r.read_at, (r.read_at IS NOT NULL) AS is_read
    FROM notification n
    JOIN workspace w ON w.workspace_id = n.workspace_id
    LEFT JOIN notification_read r
           ON r.notification_id = n.notification_id AND r.user_id = $1
"""


def _scope(user: Dict[str, Any]) -> str:
    """The workspaces a reader sees, as a condition on n. $1 is their user_id.
    The same rule as workspace_service.can_access."""
    if is_admin(user):
        return "TRUE"
    return """n.workspace_id IN (
        SELECT m.workspace_id FROM workspace_member m
        JOIN workspace w2 ON w2.workspace_id = m.workspace_id
        WHERE m.user_id = $1 AND w2.is_active)"""


def serialize(row: Dict[str, Any]) -> Dict[str, Any]:
    """A row as the API and the live stream hand it out."""
    details = row.get("details") or {}
    if isinstance(details, str):
        try:
            details = json.loads(details)
        except json.JSONDecodeError:
            details = {}
    created = row.get("created_at")
    read_at = row.get("read_at")
    return {
        "notification_id": str(row["notification_id"]),
        "workspace_id": str(row["workspace_id"]),
        "workspace_name": row.get("workspace_name"),
        "camera_id": str(row["camera_id"]) if row.get("camera_id") else None,
        "camera_name": row.get("camera_name"),
        "kind": row["kind"],
        "severity": row["severity"],
        "title": row["title"],
        "message": row["message"],
        "details": details,
        "created_at": created.isoformat() if created else None,
        "is_read": bool(row.get("is_read")),
        # Where the console opens it: the camera, or the list for a test.
        "link": f"/cameras/{row['camera_id']}" if row.get("camera_id") else "/notifications",
        "read_at": read_at.isoformat() if read_at else None,
    }


def place_of(camera: Dict[str, Any]) -> str:
    """Where a camera is, in words: InsightEye's building - floor - zone."""
    parts = [camera.get("location"), camera.get("building")]
    if camera.get("floor_level"):
        parts.append(f"floor {camera['floor_level']}")
    parts += [camera.get("area"), camera.get("zone")]
    return " · ".join(p for p in parts if p)


def _duration(seconds: float) -> str:
    seconds = int(max(0, seconds))
    if seconds < 90:
        return f"{seconds} s"
    if seconds < 5400:
        return f"{round(seconds / 60)} min"
    return f"{seconds / 3600:.1f} h"


def _when(iso: Optional[str]) -> str:
    """A stored timestamp for a mail: 2026-10-25 16:38:53 UTC."""
    if not iso:
        return ""
    try:
        return datetime.fromisoformat(iso).astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    except ValueError:
        return iso


def _mix(occupancy: Dict[str, Any]) -> str:
    parts = [
        f"{occupancy.get(f'{label}_count', 0)} {label}"
        for label in ("male", "female", "child", "unknown")
        if occupancy.get(f"{label}_count")
    ]
    return ", ".join(parts)


# ------------------------------------------------------------------ live hub
class Subscriber:
    def __init__(self, user_id: UUID) -> None:
        self.user_id = user_id
        # Bounded: a tab that stopped reading must not grow without limit.
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        # Set when the queue overflowed; the stream then tells the console
        # to reload its list instead of pretending nothing was lost.
        self.lagged = False


class NotificationHub:
    def __init__(self) -> None:
        self._subscribers: Set[Subscriber] = set()

    def subscribe(self, user_id: UUID) -> Optional[Subscriber]:
        if len(self._subscribers) >= config.max_notification_streams:
            return None
        subscriber = Subscriber(user_id)
        self._subscribers.add(subscriber)
        return subscriber

    def unsubscribe(self, subscriber: Subscriber) -> None:
        self._subscribers.discard(subscriber)

    def broadcast(self, item: Dict[str, Any]) -> None:
        """To every open stream; each stream checks its reader may see it."""
        for subscriber in list(self._subscribers):
            try:
                subscriber.queue.put_nowait(item)
            except asyncio.QueueFull:
                subscriber.lagged = True

    @property
    def count(self) -> int:
        return len(self._subscribers)


hub = NotificationHub()


class NotificationService:
    def __init__(self) -> None:
        self.db_manager = db_manager
        # Mail tasks, kept so they are not garbage-collected mid-send.
        self._background: Set[asyncio.Task] = set()

    # --------------------------------------------------------------- produce
    async def publish(
        self,
        *,
        workspace_id: UUID,
        kind: str,
        severity: str,
        title: str,
        message: str,
        camera_id: Optional[UUID] = None,
        camera_name: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Store, push to open consoles, and mail in the background. Never raises."""
        if not config.notifications_enabled:
            return None
        try:
            row = await self.db_manager.execute_query(
                """
                WITH n AS (
                    INSERT INTO notification
                        (workspace_id, camera_id, camera_name, kind, severity, title, message, details)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
                    RETURNING *
                )
                SELECT n.*, w.name AS workspace_name FROM n JOIN workspace w USING (workspace_id)
                """,
                (
                    workspace_id,
                    camera_id,
                    camera_name,
                    kind,
                    severity,
                    title,
                    message,
                    json.dumps(details or {}),
                ),
                fetch_one=True,
            )
        except Exception as e:
            logger.error("Could not store notification %r: %s", title, e)
            return None

        item = serialize(row)
        logger.info("Notification [%s] %s", kind, title)
        hub.broadcast(item)
        # Test notifications check the console, not the mail server.
        if config.notification_email_available and kind != SYSTEM:
            task = asyncio.create_task(self._mail(item), name="notification-mail")
            self._background.add(task)
            task.add_done_callback(self._background.discard)
        return item

    async def occupancy_alert(
        self, camera: Dict[str, Any], alert: OccupancyAlert, occupancy: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        name = camera.get("name") or "camera"
        place = place_of(camera)
        where = f" at {place}" if place else ""
        mix = _mix(occupancy)
        if alert.kind == HIGH:
            title = f"Crowding: {name}"
            message = (
                f"{alert.person_count} people in view{where}, "
                f"above the limit of {alert.threshold}."
            )
        else:
            title = f"Low occupancy: {name}"
            message = (
                f"{alert.person_count} "
                f"{'person' if alert.person_count == 1 else 'people'} in view{where}, "
                f"below the minimum of {alert.threshold}."
            )
        if mix:
            message += f" ({mix})"
        return await self.publish(
            workspace_id=camera["workspace_id"],
            camera_id=camera["camera_id"],
            camera_name=name,
            kind=alert.kind,
            severity="warning",
            title=title,
            message=message,
            details={
                "person_count": alert.person_count,
                "threshold": alert.threshold,
                **{k: occupancy.get(k, 0) for k in ("male_count", "female_count", "child_count", "unknown_count")},
            },
        )

    async def camera_health(
        self,
        camera: Dict[str, Any],
        kind: str,
        down_for_s: float = 0.0,
        last_error: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        name = camera.get("name") or "camera"
        if kind == OFFLINE:
            title = f"Camera offline: {name}"
            message = f"No frames for {_duration(down_for_s)}."
            if last_error:
                message += f" Last error: {last_error}."
            severity = "critical"
        else:
            title = f"Camera back online: {name}"
            message = "Delivering frames again"
            message += f" after {_duration(down_for_s)} offline." if down_for_s else "."
            severity = "info"
        return await self.publish(
            workspace_id=camera["workspace_id"],
            camera_id=camera["camera_id"],
            camera_name=name,
            kind=kind,
            severity=severity,
            title=title,
            message=message,
            details={"down_for_s": round(down_for_s, 1), "last_error": last_error},
        )

    async def last_health_kind(self, camera_id: UUID) -> Optional[str]:
        """camera_offline or camera_online, whichever this camera had last."""
        row = await self.db_manager.execute_query(
            """
            SELECT kind FROM notification
            WHERE camera_id = $1 AND kind IN ($2, $3)
            ORDER BY created_at DESC LIMIT 1
            """,
            (camera_id, OFFLINE, ONLINE),
            fetch_one=True,
        )
        return row["kind"] if row else None

    # ------------------------------------------------------------------ read
    def _filters(
        self,
        user: Dict[str, Any],
        workspace_id: Optional[UUID],
        unread_only: bool,
        kinds: Optional[List[str]],
    ) -> Tuple[str, List[Any]]:
        params: List[Any] = [user["user_id"]]
        conditions = [_scope(user)]
        if workspace_id is not None:
            params.append(workspace_id)
            conditions.append(f"n.workspace_id = ${len(params)}")
        if unread_only:
            conditions.append("r.read_at IS NULL")
        if kinds:
            params.append(list(kinds))
            conditions.append(f"n.kind = ANY(${len(params)}::text[])")
        return " AND ".join(conditions), params

    async def list_for(
        self,
        user: Dict[str, Any],
        workspace_id: Optional[UUID] = None,
        unread_only: bool = False,
        kinds: Optional[List[str]] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> Dict[str, Any]:
        where, params = self._filters(user, workspace_id, unread_only, kinds)
        count_params = list(params)
        params += [limit, offset]
        rows = await self.db_manager.execute_query(
            f"{_SELECT} WHERE {where} "
            f"ORDER BY n.created_at DESC, n.notification_id DESC "
            f"LIMIT ${len(params) - 1} OFFSET ${len(params)}",
            tuple(params),
            fetch_all=True,
        )
        total = await self.db_manager.execute_query(
            f"SELECT COUNT(*) AS n FROM notification n "
            f"LEFT JOIN notification_read r ON r.notification_id = n.notification_id AND r.user_id = $1 "
            f"WHERE {where}",
            tuple(count_params),
            fetch_one=True,
        )
        return {
            "total": total["n"],
            "unread": await self.unread_count(user, workspace_id),
            "items": [serialize(r) for r in rows],
        }

    async def unread_count(self, user: Dict[str, Any], workspace_id: Optional[UUID] = None) -> int:
        where, params = self._filters(user, workspace_id, True, None)
        row = await self.db_manager.execute_query(
            f"SELECT COUNT(*) AS n FROM notification n "
            f"LEFT JOIN notification_read r ON r.notification_id = n.notification_id AND r.user_id = $1 "
            f"WHERE {where}",
            tuple(params),
            fetch_one=True,
        )
        return row["n"]

    async def get_for(self, user: Dict[str, Any], notification_id: UUID) -> Optional[Dict[str, Any]]:
        row = await self.db_manager.execute_query(
            f"{_SELECT} WHERE n.notification_id = $2 AND {_scope(user)}",
            (user["user_id"], notification_id),
            fetch_one=True,
        )
        return serialize(row) if row else None

    # ----------------------------------------------------------- read state
    async def mark_read(self, user: Dict[str, Any], notification_ids: Iterable[UUID]) -> int:
        """Only notifications the reader can see; the rest are silently skipped."""
        ids = list(notification_ids)
        if not ids:
            return 0
        return await self.db_manager.execute_query(
            f"""
            INSERT INTO notification_read (notification_id, user_id)
            SELECT n.notification_id, $1 FROM notification n
            WHERE n.notification_id = ANY($2::uuid[]) AND {_scope(user)}
            ON CONFLICT DO NOTHING
            """,
            (user["user_id"], ids),
            return_rowcount=True,
        )

    async def mark_unread(self, user: Dict[str, Any], notification_id: UUID) -> int:
        return await self.db_manager.execute_query(
            "DELETE FROM notification_read WHERE user_id = $1 AND notification_id = $2",
            (user["user_id"], notification_id),
            return_rowcount=True,
        )

    async def mark_all_read(self, user: Dict[str, Any], workspace_id: Optional[UUID] = None) -> int:
        where, params = self._filters(user, workspace_id, True, None)
        return await self.db_manager.execute_query(
            f"""
            INSERT INTO notification_read (notification_id, user_id)
            SELECT n.notification_id, $1 FROM notification n
            LEFT JOIN notification_read r ON r.notification_id = n.notification_id AND r.user_id = $1
            WHERE {where}
            ON CONFLICT DO NOTHING
            """,
            tuple(params),
            return_rowcount=True,
        )

    async def purge(self, older_than_days: int) -> int:
        if older_than_days <= 0:
            return 0
        return await self.db_manager.execute_query(
            "DELETE FROM notification WHERE created_at < NOW() - make_interval(days => $1)",
            (older_than_days,),
            return_rowcount=True,
        )

    # ------------------------------------------------------------------ mail
    async def recipients(self, workspace_id: UUID) -> List[Dict[str, Any]]:
        """Active accounts that opted in and can see the workspace."""
        return await self.db_manager.execute_query(
            """
            SELECT u.user_id, u.username, u.email, u.full_name FROM app_user u
            WHERE u.is_active AND u.notify_email AND (
                u.role = 'admin' OR EXISTS (
                    SELECT 1 FROM workspace_member m
                    JOIN workspace w ON w.workspace_id = m.workspace_id
                    WHERE m.user_id = u.user_id AND m.workspace_id = $1 AND w.is_active))
            ORDER BY u.created_at
            """,
            (workspace_id,),
            fetch_all=True,
        )

    @staticmethod
    def _message(item: Dict[str, Any], to: Dict[str, Any]):
        name = to.get("full_name") or to["username"]
        link = ""
        if config.console_url:
            base = config.console_url.rstrip("/")
            link = f"{base}/cameras/{item['camera_id']}" if item.get("camera_id") else f"{base}/notifications"
        workspace = item.get("workspace_name") or ""
        at = _when(item.get("created_at"))
        text = (
            f"Hello {name},\n\n{item['title']}\n{item['message']}\n\n"
            f"Workspace: {workspace}\nAt: {at}\n"
            + (f"\nOpen: {link}\n" if link else "")
            + "\nYou get these because email alerts are on for your account; "
            "turn them off in the console's account menu.\n"
        )
        html = (
            f"<p>Hello {escape(name)},</p>"
            f"<p><strong>{escape(item['title'])}</strong><br>{escape(item['message'])}</p>"
            f"<p style=\"color:#666\">Workspace: {escape(workspace)}<br>At: {escape(at)}</p>"
            + (f"<p><a href=\"{escape(link)}\">Open in the console</a></p>" if link else "")
            + "<p style=\"color:#666;font-size:12px\">You get these because email alerts are on "
            "for your account; turn them off in the console's account menu.</p>"
        )
        return mailer.message(to["email"], f"[{config.app_name}] {item['title']}", text, html)

    async def _mail(self, item: Dict[str, Any]) -> None:
        try:
            people = await self.recipients(UUID(item["workspace_id"]))
            if not people:
                return
            await mailer.send(self._message(item, person) for person in people)
            logger.info("Notification %s mailed to %s account(s)", item["notification_id"], len(people))
        except Exception as e:
            logger.error("Could not mail notification %s: %s", item["notification_id"], e)

    async def drain(self) -> None:
        """Wait for mails in flight (tests, shutdown)."""
        if self._background:
            await asyncio.gather(*list(self._background), return_exceptions=True)


notification_service = NotificationService()
