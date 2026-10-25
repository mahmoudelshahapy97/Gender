# app/services/analytics_service.py
"""Aggregates behind the Dashboard and Analytics pages.

Two sources, two questions:

* ``visit`` - one row per person: "how many women came in". Counted.
* ``occupancy_snapshot`` - who was in view every SNAPSHOT_INTERVAL_S:
  "how many men are usually here". Averaged, never summed (a sum would only
  measure how often snapshots are taken).

The InsightEye endpoints (/cameras/average-gender, /zones/gender-by-weekday)
keep their response shapes, computed from snapshots the way InsightEye's
stream_results were; the ratio/location/peak-hour reports come from the
analytics_extended_router that InsightEye later dropped. Time buckets are cut
in the viewer's timezone - a weekday or an hour of day only means something in
the hours the viewer lives in.
"""

import logging
from datetime import datetime, time, timezone
from typing import Any, Dict, List, Optional
from uuid import UUID
from zoneinfo import ZoneInfo

from app.core.database import db_manager
from app.services.filters import LOCATION_COLUMNS, Filters

logger = logging.getLogger(__name__)

GENDERS = ("male", "female", "child")
INTERVALS = ("hour", "day", "week", "month")
GROUP_BY = tuple(LOCATION_COLUMNS.values())
WEEKDAYS = ("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")

_JOIN_SNAPSHOT = "FROM occupancy_snapshot f JOIN camera c ON c.camera_id = f.camera_id"
_JOIN_VISIT = "FROM visit f JOIN camera c ON c.camera_id = f.camera_id"

# Visit counts by label, for a SELECT list over "visit f".
_VISIT_COUNTS = """
    COUNT(*) FILTER (WHERE f.gender = 'male')    AS male,
    COUNT(*) FILTER (WHERE f.gender = 'female')  AS female,
    COUNT(*) FILTER (WHERE f.gender = 'child')   AS child,
    COUNT(*) FILTER (WHERE f.gender = 'unknown') AS unknown,
    COUNT(*)                                     AS total
"""
# Average occupancy by label, for a SELECT list over "occupancy_snapshot f".
_SNAPSHOT_AVERAGES = """
    AVG(f.male_count)    AS male,
    AVG(f.female_count)  AS female,
    AVG(f.child_count)   AS child,
    AVG(f.unknown_count) AS unknown,
    AVG(f.person_count)  AS total,
    COUNT(*)             AS sample_size
"""


def check_timezone(tz: str) -> str:
    try:
        ZoneInfo(tz)
    except Exception:
        raise ValueError(f"Unknown timezone: {tz}")
    return tz


def _num(value: Any, digits: int = 2) -> Optional[float]:
    """numeric/Decimal and double alike, as a rounded float - an int for
    digits=0 - or None."""
    if value is None:
        return None
    return int(round(float(value))) if digits == 0 else round(float(value), digits)


def _pct(part: float, whole: float) -> Optional[float]:
    return round(100.0 * part / whole, 1) if whole else None


def _mix(row: Dict[str, Any], digits: int = 2) -> Dict[str, Any]:
    """male/female/child/unknown/total plus each gender's share and the
    male:female ratio. Shares are of the labelled people (unknown left out),
    so they always add up to 100."""
    values = {k: _num(row.get(k), digits) or 0 for k in (*GENDERS, "unknown", "total")}
    labelled = sum(values[g] for g in GENDERS)
    return {
        **values,
        **{f"{g}_pct": _pct(values[g], labelled) for g in GENDERS},
        "male_female_ratio": round(values["male"] / values["female"], 2) if values["female"] else None,
    }


class AnalyticsService:
    def __init__(self) -> None:
        self.db_manager = db_manager

    async def _all(self, query: str, params: List[Any]) -> List[Dict[str, Any]]:
        return await self.db_manager.execute_query(query, tuple(params), fetch_all=True)

    async def _one(self, query: str, params: List[Any]) -> Dict[str, Any]:
        return await self.db_manager.execute_query(query, tuple(params), fetch_one=True)

    # ------------------------------------------------------------- dashboard
    async def summary(self, filters: Filters, tz: str) -> Dict[str, Any]:
        """KPIs: today's visits, the range's visits and dwell, and who is in
        view now. "Today" is the viewer's calendar day and ignores the date
        range; the camera and location filters apply to everything."""
        today = Filters(**{**filters.__dict__, "start_date": None, "end_date": None})
        midnight = datetime.combine(datetime.now(ZoneInfo(tz)).date(), time.min, ZoneInfo(tz))

        where, params = today.where("f.first_seen")
        params.append(midnight.astimezone(timezone.utc))
        today_row = await self._one(
            f"SELECT {_VISIT_COUNTS} {_JOIN_VISIT} {where} AND f.first_seen >= ${len(params)}", params
        )

        where, params = filters.where("f.first_seen")
        range_row = await self._one(
            f"""
            SELECT {_VISIT_COUNTS}, AVG(f.dwell_s) AS avg_dwell_s,
                   COUNT(DISTINCT f.camera_id) AS cameras
            {_JOIN_VISIT} {where}
            """,
            params,
        )

        # Newest snapshot per camera, if it is recent enough to call "now".
        where, params = today.where("f.captured_at")
        now_row = await self._one(
            f"""
            SELECT COALESCE(SUM(person_count), 0) AS total, COALESCE(SUM(male_count), 0) AS male,
                   COALESCE(SUM(female_count), 0) AS female, COALESCE(SUM(child_count), 0) AS child,
                   COALESCE(SUM(unknown_count), 0) AS unknown, COUNT(*) AS cameras,
                   MAX(captured_at) AS as_of
            FROM (
                SELECT DISTINCT ON (f.camera_id) f.*
                {_JOIN_SNAPSHOT} {where} AND f.captured_at >= NOW() - INTERVAL '10 minutes'
                ORDER BY f.camera_id, f.captured_at DESC
            ) latest
            """,
            params,
        )

        return {
            "today": _mix(today_row, 0),
            "range": {
                **_mix(range_row, 0),
                "avg_dwell_s": _num(range_row["avg_dwell_s"], 1),
                "cameras": range_row["cameras"],
            },
            "occupancy_now": {
                **_mix(now_row, 0),
                "cameras": now_row["cameras"],
                "as_of": now_row["as_of"].isoformat() if now_row["as_of"] else None,
            },
            "filters_applied": filters.applied(),
        }

    # -------------------------------------------- InsightEye: per camera
    async def average_gender_by_camera(self, filters: Filters, gender: str) -> List[Dict[str, Any]]:
        """GET /analytics/cameras/average-gender. Same shape as InsightEye's
        (analytics_router.py:334), plus ``visit_count``: the unique people of
        that gender the camera saw in the range."""
        column = f"{gender}_count"
        where, params = filters.where("f.captured_at")
        # Same filters over the visits; their parameters line up with these.
        visit_where, _ = filters.where("v.first_seen", alias="v")
        visit_where = visit_where.removeprefix("WHERE ")
        params.append(gender)
        rows = await self._all(
            f"""
            SELECT c.camera_id, c.name AS camera_name, c.location, c.area, c.building,
                   c.zone, c.floor_level,
                   AVG(f.{column}) AS avg_count, MAX(f.{column}) AS max_count,
                   MIN(f.{column}) AS min_count, COUNT(*) AS sample_size,
                   (SELECT COUNT(*) FROM visit v
                    WHERE v.camera_id = c.camera_id AND v.gender = ${len(params)}
                      AND {visit_where}) AS visit_count
            {_JOIN_SNAPSHOT} {where}
            GROUP BY c.camera_id
            ORDER BY avg_count DESC, c.name
            """,
            params,
        )
        return [
            {
                **{k: row[k] for k in ("camera_id", "camera_name", "location", "area", "building", "zone", "floor_level")},
                "avg_count": _num(row["avg_count"]),
                "max_count": row["max_count"],
                "min_count": row["min_count"],
                "sample_size": row["sample_size"],
                "visit_count": row["visit_count"],
                "gender": gender,
            }
            for row in rows
        ]

    # --------------------------------------- InsightEye: zone x weekday
    async def gender_by_weekday(self, filters: Filters, gender: str, tz: str) -> List[Dict[str, Any]]:
        """GET /analytics/zones/gender-by-weekday (InsightEye analytics_router.py:434)."""
        column = f"{gender}_count"
        where, params = filters.where("f.captured_at")
        params.append(tz)
        rows = await self._all(
            f"""
            SELECT COALESCE(c.zone, 'Unknown') AS zone,
                   EXTRACT(DOW FROM f.captured_at AT TIME ZONE ${len(params)})::int AS weekday_num,
                   AVG(f.{column}) AS avg_count, COUNT(*) AS sample_size
            {_JOIN_SNAPSHOT} {where}
            GROUP BY 1, 2
            ORDER BY weekday_num, zone
            """,
            params,
        )
        return [
            {
                "zone": row["zone"],
                "weekday_name": WEEKDAYS[row["weekday_num"]],
                "weekday_num": row["weekday_num"],
                "avg_count": _num(row["avg_count"]),
                "sample_size": row["sample_size"],
                "gender": gender,
            }
            for row in rows
        ]

    # -------------------------------------------------------- ratio trends
    async def ratio_trends(self, filters: Filters, interval: str, source: str, tz: str) -> List[Dict[str, Any]]:
        """Gender mix per hour/day/week/month. ``visits`` counts people;
        ``occupancy`` averages who was in view."""
        if source == "visits":
            time_column, select, join = "f.first_seen", _VISIT_COUNTS, _JOIN_VISIT
        else:
            time_column, select, join = "f.captured_at", _SNAPSHOT_AVERAGES, _JOIN_SNAPSHOT
        where, params = filters.where(time_column)
        params.extend([interval, tz])
        n_interval, n_tz = len(params) - 1, len(params)
        rows = await self._all(
            f"""
            SELECT date_trunc(${n_interval}, {time_column} AT TIME ZONE ${n_tz}) AS period, {select}
            {join} {where}
            GROUP BY 1 ORDER BY 1
            """,
            params,
        )
        return [{"period": row["period"].isoformat(), **_mix(row)} for row in rows]

    # ---------------------------------------------- distribution by location
    async def distribution_by_location(self, filters: Filters, group_by: str) -> List[Dict[str, Any]]:
        """Visits and average occupancy by gender for each location / area /
        building / floor / zone."""
        where_v, params_v = filters.where("f.first_seen")
        visits = await self._all(
            f"""
            SELECT COALESCE(c.{group_by}, 'Unknown') AS grp, {_VISIT_COUNTS}, AVG(f.dwell_s) AS avg_dwell_s
            {_JOIN_VISIT} {where_v}
            GROUP BY 1
            """,
            params_v,
        )
        where_s, params_s = filters.where("f.captured_at")
        occupancy = await self._all(
            f"""
            SELECT COALESCE(c.{group_by}, 'Unknown') AS grp, {_SNAPSHOT_AVERAGES}
            {_JOIN_SNAPSHOT} {where_s}
            GROUP BY 1
            """,
            params_s,
        )
        by_group: Dict[str, Dict[str, Any]] = {}
        for row in visits:
            by_group[row["grp"]] = {
                "group": row["grp"],
                "visits": _mix(row, 0),
                "avg_dwell_s": _num(row["avg_dwell_s"], 1),
                "occupancy": None,
            }
        for row in occupancy:
            entry = by_group.setdefault(
                row["grp"], {"group": row["grp"], "visits": None, "avg_dwell_s": None}
            )
            entry["occupancy"] = {**_mix(row), "sample_size": row["sample_size"]}
        return sorted(
            by_group.values(),
            key=lambda e: (-(e["visits"] or {}).get("total", 0), e["group"]),
        )

    # ------------------------------------------------------------ peak hours
    async def peak_hours(self, filters: Filters, tz: str) -> Dict[str, Any]:
        """Per hour of day: visits started, and average / peak occupancy, by
        gender - plus the busiest hour for each."""
        where, params = filters.where("f.first_seen")
        params.append(tz)
        visits = await self._all(
            f"""
            SELECT EXTRACT(HOUR FROM f.first_seen AT TIME ZONE ${len(params)})::int AS hour, {_VISIT_COUNTS}
            {_JOIN_VISIT} {where}
            GROUP BY 1
            """,
            params,
        )
        where, params = filters.where("f.captured_at")
        params.append(tz)
        occupancy = await self._all(
            f"""
            SELECT EXTRACT(HOUR FROM f.captured_at AT TIME ZONE ${len(params)})::int AS hour,
                   AVG(f.male_count) AS avg_male, AVG(f.female_count) AS avg_female,
                   AVG(f.child_count) AS avg_child,
                   MAX(f.male_count) AS max_male, MAX(f.female_count) AS max_female,
                   MAX(f.child_count) AS max_child
            {_JOIN_SNAPSHOT} {where}
            GROUP BY 1
            """,
            params,
        )
        v_by_hour = {row["hour"]: row for row in visits}
        o_by_hour = {row["hour"]: row for row in occupancy}
        hours = []
        for hour in range(24):
            v, o = v_by_hour.get(hour) or {}, o_by_hour.get(hour) or {}
            hours.append(
                {
                    "hour": hour,
                    **{f"visits_{g}": v.get(g, 0) for g in GENDERS},
                    "visits_total": v.get("total", 0),
                    **{f"avg_{g}": _num(o.get(f"avg_{g}")) for g in GENDERS},
                    **{f"max_{g}": o.get(f"max_{g}") for g in GENDERS},
                }
            )

        def peak(key: str) -> Optional[int]:
            best = max(hours, key=lambda h: h[key] or 0)
            return best["hour"] if best[key] else None

        return {
            "hours": hours,
            **{f"peak_{g}_hour": peak(f"visits_{g}") for g in GENDERS},
            "peak_total_hour": peak("visits_total"),
        }

    # ---------------------------------------------------------- the heatmap
    async def hourly_heatmap(self, filters: Filters, tz: str, gender: Optional[str]) -> List[Dict[str, Any]]:
        """Visits per weekday x hour, sparse - HourHeatmap's {weekday, hour, events}."""
        where, params = filters.where("f.first_seen")
        if gender:
            params.append(gender)
            where += f" AND f.gender = ${len(params)}"
        params.append(tz)
        local = f"f.first_seen AT TIME ZONE ${len(params)}"
        rows = await self._all(
            f"""
            SELECT EXTRACT(DOW FROM {local})::int AS weekday, EXTRACT(HOUR FROM {local})::int AS hour,
                   COUNT(*) AS events
            {_JOIN_VISIT} {where}
            GROUP BY 1, 2
            """,
            params,
        )
        return [dict(row) for row in rows]

    # ------------------------------------------------------- filter options
    async def filter_options(self, workspace_id: UUID) -> Dict[str, Any]:
        """The cameras and their location values, for the filter bar. The
        console cascades location > area > building > floor > zone itself."""
        cameras = await self._all(
            """
            SELECT camera_id, name, location, area, building, floor_level, zone
            FROM camera WHERE workspace_id = $1 ORDER BY lower(name)
            """,
            [workspace_id],
        )
        options = {
            attr: sorted({c[column] for c in cameras if c[column]})
            for attr, column in LOCATION_COLUMNS.items()
        }
        return {"cameras": cameras, **options}


analytics_service = AnalyticsService()
