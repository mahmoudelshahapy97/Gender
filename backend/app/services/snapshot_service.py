# app/services/snapshot_service.py
"""occupancy_snapshot rows: written by the camera workers, read by the
Snapshots page and the analytics."""

import logging
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from app.core.database import db_manager
from app.services import media_service
from app.services.filters import Filters
from app.services.object_store import snapshot_key

logger = logging.getLogger(__name__)

_COLUMNS = """
    f.snapshot_id, f.camera_id, f.workspace_id, f.captured_at,
    f.person_count, f.male_count, f.female_count, f.child_count, f.unknown_count,
    (f.frame_key IS NOT NULL OR f.frame_jpeg IS NOT NULL) AS has_frame,
    c.name AS camera_name, c.location, c.area, c.building, c.floor_level, c.zone
"""


class SnapshotService:
    def __init__(self) -> None:
        self.db_manager = db_manager

    async def record(
        self, camera_id: UUID, counts: Dict[str, int], frame_jpeg: Optional[bytes] = None
    ) -> Optional[Dict[str, Any]]:
        """Store one snapshot; the frame goes to MinIO (or the row) afterwards."""
        try:
            row = await self.db_manager.execute_query(
                """
                INSERT INTO occupancy_snapshot
                    (camera_id, person_count, male_count, female_count, child_count, unknown_count)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING snapshot_id, captured_at
                """,
                (
                    camera_id,
                    counts["person_count"],
                    counts["male_count"],
                    counts["female_count"],
                    counts["child_count"],
                    counts["unknown_count"],
                ),
                fetch_one=True,
            )
        except Exception as e:
            logger.error("Could not record snapshot for camera %s: %s", camera_id, e)
            return None
        if row and frame_jpeg:
            await media_service.save_image(
                media_service.SNAPSHOT_FRAME,
                row["snapshot_id"],
                snapshot_key(camera_id, row["snapshot_id"]),
                frame_jpeg,
            )
        return row

    async def list(
        self, filters: Filters, limit: int = 50, offset: int = 0, min_people: int = 0
    ) -> Tuple[List[Dict[str, Any]], int]:
        where, params = filters.where("f.captured_at")
        if min_people:
            params.append(min_people)
            where += f" AND f.person_count >= ${len(params)}"
        base = f"FROM occupancy_snapshot f JOIN camera c ON c.camera_id = f.camera_id {where}"
        total = await self.db_manager.execute_query(
            f"SELECT COUNT(*) AS n {base}", tuple(params), fetch_one=True
        )
        rows = await self.db_manager.execute_query(
            f"""
            SELECT {_COLUMNS} {base}
            ORDER BY f.captured_at DESC
            LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}
            """,
            (*params, limit, offset),
            fetch_all=True,
        )
        return rows, total["n"]

    async def get(self, snapshot_id: UUID) -> Optional[Dict[str, Any]]:
        return await self.db_manager.execute_query(
            f"""
            SELECT {_COLUMNS}
            FROM occupancy_snapshot f JOIN camera c ON c.camera_id = f.camera_id
            WHERE f.snapshot_id = $1
            """,
            (snapshot_id,),
            fetch_one=True,
        )

    async def frame(self, snapshot_id: UUID) -> Optional[bytes]:
        return await media_service.load_image(media_service.SNAPSHOT_FRAME, snapshot_id)

    async def latest_by_camera(self, workspace_id: UUID) -> List[Dict[str, Any]]:
        """Each camera's newest snapshot - the dashboard's "in view now"."""
        return await self.db_manager.execute_query(
            f"""
            SELECT DISTINCT ON (f.camera_id) {_COLUMNS}
            FROM occupancy_snapshot f JOIN camera c ON c.camera_id = f.camera_id
            WHERE f.workspace_id = $1
            ORDER BY f.camera_id, f.captured_at DESC
            """,
            (workspace_id,),
            fetch_all=True,
        )


snapshot_service = SnapshotService()
