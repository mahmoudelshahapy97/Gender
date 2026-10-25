# app/services/visit_service.py
"""visit rows: one per tracked person, written when their track ends."""

import json
import logging
from typing import Any, Dict, List, Optional, Sequence, Tuple
from uuid import UUID

from app.core.database import db_manager
from app.services.filters import Filters
from app.services.gender_service import Visit

logger = logging.getLogger(__name__)

GENDERS = ("male", "female", "child", "unknown")

_COLUMNS = """
    f.visit_id, f.camera_id, f.workspace_id, f.track_key, f.gender, f.confidence,
    f.votes, f.first_seen, f.last_seen, f.dwell_s,
    c.name AS camera_name, c.location, c.area, c.building, c.floor_level, c.zone
"""


class VisitService:
    def __init__(self) -> None:
        self.db_manager = db_manager

    async def record(self, camera_id: UUID, visits: Sequence[Visit]) -> int:
        """Store finished visits; a replayed one is ignored (UNIQUE key)."""
        if not visits:
            return 0
        try:
            await self.db_manager.execute_many(
                """
                INSERT INTO visit
                    (camera_id, track_key, gender, confidence, votes, first_seen, last_seen, dwell_s)
                VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
                ON CONFLICT (camera_id, track_key, first_seen) DO NOTHING
                """,
                [
                    (
                        camera_id,
                        v.track_key,
                        v.gender,
                        v.confidence,
                        json.dumps(v.votes),
                        v.first_seen,
                        v.last_seen,
                        v.dwell_s,
                    )
                    for v in visits
                ],
            )
        except Exception as e:
            logger.error("Could not record %s visit(s) for camera %s: %s", len(visits), camera_id, e)
            return 0
        return len(visits)

    def _query(self, filters: Filters, gender: Optional[str]) -> Tuple[str, List[Any]]:
        where, params = filters.where("f.first_seen")
        if gender:
            params.append(gender)
            where += f" AND f.gender = ${len(params)}"
        return f"FROM visit f JOIN camera c ON c.camera_id = f.camera_id {where}", params

    async def list(
        self, filters: Filters, gender: Optional[str] = None, limit: int = 50, offset: int = 0
    ) -> Tuple[List[Dict[str, Any]], int]:
        base, params = self._query(filters, gender)
        total = await self.db_manager.execute_query(
            f"SELECT COUNT(*) AS n {base}", tuple(params), fetch_one=True
        )
        rows = await self.db_manager.execute_query(
            f"""
            SELECT {_COLUMNS} {base}
            ORDER BY f.first_seen DESC
            LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}
            """,
            (*params, limit, offset),
            fetch_all=True,
        )
        return [self._out(r) for r in rows], total["n"]

    async def export(self, filters: Filters, gender: Optional[str] = None, cap: int = 100_000):
        base, params = self._query(filters, gender)
        rows = await self.db_manager.execute_query(
            f"SELECT {_COLUMNS} {base} ORDER BY f.first_seen LIMIT ${len(params) + 1}",
            (*params, cap),
            fetch_all=True,
        )
        return [self._out(r) for r in rows]

    @staticmethod
    def _out(row: Dict[str, Any]) -> Dict[str, Any]:
        votes = row.get("votes")
        if isinstance(votes, str):
            try:
                votes = json.loads(votes)
            except json.JSONDecodeError:
                votes = {}
        return {**row, "votes": votes or {}}


visit_service = VisitService()
