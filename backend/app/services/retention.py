# app/services/retention.py
"""Bounded storage for snapshot frames and old counts.

A counting service that writes a frame per camera per minute eventually fills
its storage and takes counting down with it. Each pass:

* deletes snapshot frames older than FRAME_RETENTION_DAYS from MinIO and
  clears them on their rows (the counts stay);
* deletes snapshot and visit rows older than DATA_RETENTION_DAYS, with any
  frame they still have (0 = keep the rows forever);
* deletes notifications older than NOTIFICATION_RETENTION_DAYS (0 = keep).

Turn it off with RETENTION_ENABLED=false where an external archiver owns the data.
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Optional

from app.core.config import config
from app.core.database import db_manager
from app.services.notification_service import notification_service
from app.services.object_store import object_store

logger = logging.getLogger(__name__)

_task: Optional[asyncio.Task] = None
_BATCH = 1000


@dataclass
class PurgeReport:
    frames_deleted: int = 0
    snapshots_deleted: int = 0
    visits_deleted: int = 0
    notifications_deleted: int = 0

    def as_dict(self) -> dict:
        return {
            "frames_deleted": self.frames_deleted,
            "snapshots_deleted": self.snapshots_deleted,
            "visits_deleted": self.visits_deleted,
            "notifications_deleted": self.notifications_deleted,
        }


async def _drop_frames(older_than_days: int, report: PurgeReport) -> None:
    """Remove the frames of snapshots older than the cut-off, in batches."""
    while True:
        rows = await db_manager.execute_query(
            """
            SELECT snapshot_id, frame_key FROM occupancy_snapshot
            WHERE captured_at < NOW() - make_interval(days => $1)
              AND (frame_key IS NOT NULL OR frame_jpeg IS NOT NULL)
            LIMIT $2
            """,
            (older_than_days, _BATCH),
            fetch_all=True,
        )
        if not rows:
            return
        keys = [r["frame_key"] for r in rows if r["frame_key"]]
        removed = set(await object_store.remove(keys)) if keys else set()
        # A key MinIO would not delete stays on its row for the next pass.
        cleared = [
            r["snapshot_id"] for r in rows if not r["frame_key"] or r["frame_key"] in removed
        ]
        if not cleared:
            return
        await db_manager.execute_query(
            "UPDATE occupancy_snapshot SET frame_key = NULL, frame_jpeg = NULL "
            "WHERE snapshot_id = ANY($1::uuid[])",
            (cleared,),
        )
        report.frames_deleted += len(cleared)
        if len(rows) < _BATCH:
            return


async def purge_old_data() -> PurgeReport:
    """Run one retention pass. Never raises -- a purge failure is not fatal."""
    report = PurgeReport()
    try:
        if config.frame_retention_days > 0:
            await _drop_frames(config.frame_retention_days, report)
        if config.data_retention_days > 0:
            await _drop_frames(config.data_retention_days, report)
            report.snapshots_deleted = await db_manager.execute_query(
                "DELETE FROM occupancy_snapshot WHERE captured_at < NOW() - make_interval(days => $1)",
                (config.data_retention_days,),
                return_rowcount=True,
            )
            report.visits_deleted = await db_manager.execute_query(
                "DELETE FROM visit WHERE first_seen < NOW() - make_interval(days => $1)",
                (config.data_retention_days,),
                return_rowcount=True,
            )
        if config.notification_retention_days > 0:
            report.notifications_deleted = await notification_service.purge(
                config.notification_retention_days
            )
    except Exception:
        logger.exception("Retention pass failed")
    if any(report.as_dict().values()):
        logger.info("Retention pass: %s", report.as_dict())
    return report


async def _loop() -> None:
    interval = max(60.0, config.retention_interval_s)
    while True:
        await purge_old_data()
        await asyncio.sleep(interval)


def start() -> None:
    global _task
    if not config.retention_enabled or _task is not None:
        return
    _task = asyncio.create_task(_loop(), name="retention")


async def stop() -> None:
    global _task
    if _task is None:
        return
    _task.cancel()
    try:
        await _task
    except asyncio.CancelledError:
        pass
    _task = None
