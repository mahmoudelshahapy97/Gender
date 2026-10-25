# app/services/filters.py
"""The filter every data page shares: date range, cameras, and InsightEye's
location hierarchy (location > area > building > floor_level > zone).

``where()`` renders it as SQL against a fact table joined to ``camera c``, so
analytics, visits and snapshots filter identically. Parameters are numbered
from ``start`` so callers can put their own first.
"""

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any, List, Optional, Tuple
from uuid import UUID
from zoneinfo import ZoneInfo

# Query parameter -> camera column. Mirrors InsightEye's build_location_filters.
LOCATION_COLUMNS = {
    "locations": "location",
    "areas": "area",
    "buildings": "building",
    "floor_levels": "floor_level",
    "zones": "zone",
}


def split_csv(value: Optional[str]) -> List[str]:
    """'a, b,,c' -> ['a', 'b', 'c'] (the console sends comma-joined lists)."""
    if not value:
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def split_uuids(value: Optional[str]) -> List[UUID]:
    out = []
    for part in split_csv(value):
        try:
            out.append(UUID(part))
        except ValueError:
            raise ValueError(f"'{part}' is not a camera id")
    return out


@dataclass
class Filters:
    workspace_id: UUID
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    camera_ids: List[UUID] = field(default_factory=list)
    locations: List[str] = field(default_factory=list)
    areas: List[str] = field(default_factory=list)
    buildings: List[str] = field(default_factory=list)
    floor_levels: List[str] = field(default_factory=list)
    zones: List[str] = field(default_factory=list)
    # The viewer's timezone: start_date / end_date are their calendar days.
    tz: str = "UTC"

    def where(self, time_column: str, start: int = 1, alias: str = "f") -> Tuple[str, List[Any]]:
        """``WHERE ...`` for ``<fact> <alias> JOIN camera c``; returns (sql, params).

        Dates are whole days in ``tz``: end_date is inclusive. The bounds are
        computed here rather than in SQL so the time index stays usable.
        """
        zone = ZoneInfo(self.tz)
        params: List[Any] = [self.workspace_id]
        clauses = [f"{alias}.workspace_id = ${start}"]

        def add(sql: str, value: Any) -> None:
            params.append(value)
            clauses.append(sql.format(n=start + len(params) - 1))

        if self.start_date:
            add(f"{time_column} >= ${{n}}", datetime.combine(self.start_date, time.min, zone))
        if self.end_date:
            add(
                f"{time_column} < ${{n}}",
                datetime.combine(self.end_date + timedelta(days=1), time.min, zone),
            )
        if self.camera_ids:
            add(f"{alias}.camera_id = ANY(${{n}}::uuid[])", self.camera_ids)
        for attr, column in LOCATION_COLUMNS.items():
            values = getattr(self, attr)
            if values:
                add(f"c.{column} = ANY(${{n}}::text[])", values)
        return "WHERE " + " AND ".join(clauses), params

    def applied(self) -> dict:
        """What was filtered on, echoed back like InsightEye's filters_applied."""
        return {
            "start_date": self.start_date.isoformat() if self.start_date else None,
            "end_date": self.end_date.isoformat() if self.end_date else None,
            "camera_ids": [str(c) for c in self.camera_ids],
            **{attr: getattr(self, attr) for attr in LOCATION_COLUMNS},
        }
