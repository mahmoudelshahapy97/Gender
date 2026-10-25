"""Geometry, filter and annotation tests: no model, no database."""

from datetime import date, datetime
from uuid import uuid4
from zoneinfo import ZoneInfo

import numpy as np
import pytest

from app.services.filters import Filters, split_csv, split_uuids
from app.utils.geometry_utils import (
    box_gap,
    box_in_polygon,
    centroid,
    centroid_distance,
    clamp_box,
    iou,
    point_in_polygon,
)
from app.utils.image_utils import GENDER_COLORS, annotate_people


# ----------------------------------------------------------------- geometry
def test_centroid():
    assert centroid((0.0, 0.0, 10.0, 20.0)) == (5.0, 10.0)


def test_iou_identical_boxes_is_one():
    box = (0.0, 0.0, 10.0, 10.0)
    assert iou(box, box) == pytest.approx(1.0)


def test_iou_disjoint_boxes_is_zero():
    assert iou((0.0, 0.0, 10.0, 10.0), (50.0, 50.0, 60.0, 60.0)) == 0.0


def test_iou_half_overlap():
    assert iou((0.0, 0.0, 10.0, 10.0), (5.0, 0.0, 15.0, 10.0)) == pytest.approx(1 / 3)


def test_box_gap_is_zero_when_boxes_overlap():
    assert box_gap((0.0, 0.0, 10.0, 10.0), (5.0, 5.0, 15.0, 15.0)) == 0.0


def test_box_gap_measures_edge_distance():
    # A tall person next to a small bag: edges are 10 px apart even though the
    # centroids are much further, which is why owner association uses the gap.
    assert box_gap((0.0, 0.0, 10.0, 10.0), (20.0, 0.0, 30.0, 100.0)) == pytest.approx(10.0)
    assert centroid_distance((0.0, 0.0, 10.0, 10.0), (20.0, 0.0, 30.0, 100.0)) > 45.0


def test_point_in_polygon():
    square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    assert point_in_polygon((5.0, 5.0), square)
    assert not point_in_polygon((15.0, 5.0), square)


def test_degenerate_polygon_accepts_everything():
    assert point_in_polygon((999.0, 999.0), [])
    assert point_in_polygon((999.0, 999.0), [(0.0, 0.0), (1.0, 1.0)])


def test_box_in_polygon_uses_the_centroid():
    square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    assert box_in_polygon((4.0, 4.0, 6.0, 6.0), square)
    assert not box_in_polygon((40.0, 40.0, 60.0, 60.0), square)


def test_clamp_box_keeps_crops_inside_the_frame():
    clamped = clamp_box((-20.0, -30.0, 900.0, 900.0), 640, 480)
    x1, y1, x2, y2 = clamped
    assert (x1, y1) == (0.0, 0.0)
    assert x2 <= 640 and y2 <= 480


def test_clamp_box_never_returns_an_empty_box():
    x1, y1, x2, y2 = clamp_box((100.0, 100.0, 100.0, 100.0), 640, 480)
    assert x2 > x1 and y2 > y1


# --------------------------------------------------------------------- colour


# ------------------------------------------------------------------ filters
def test_split_csv_drops_blanks():
    assert split_csv(" a, b,,c ") == ["a", "b", "c"]
    assert split_csv(None) == []


def test_split_uuids_rejects_garbage():
    good = uuid4()
    assert split_uuids(f"{good},") == [good]
    with pytest.raises(ValueError):
        split_uuids("not-a-uuid")


def test_filters_number_parameters_in_order():
    ws, cam = uuid4(), uuid4()
    f = Filters(workspace_id=ws, camera_ids=[cam], zones=["Lobby"], buildings=["HQ"])
    sql, params = f.where("f.captured_at")
    assert sql == (
        "WHERE f.workspace_id = $1 AND f.camera_id = ANY($2::uuid[]) "
        "AND c.building = ANY($3::text[]) AND c.zone = ANY($4::text[])"
    )
    assert params == [ws, [cam], ["HQ"], ["Lobby"]]


def test_filter_dates_are_whole_days_in_the_viewer_timezone():
    f = Filters(workspace_id=uuid4(), start_date=date(2026, 3, 1), end_date=date(2026, 3, 1), tz="Africa/Cairo")
    sql, params = f.where("f.first_seen", start=3, alias="v")
    assert sql == "WHERE v.workspace_id = $3 AND f.first_seen >= $4 AND f.first_seen < $5"
    cairo = ZoneInfo("Africa/Cairo")
    assert params[1] == datetime(2026, 3, 1, tzinfo=cairo)
    assert params[2] == datetime(2026, 3, 2, tzinfo=cairo)


# --------------------------------------------------------------- annotation
def test_annotate_people_colours_by_gender_and_leaves_the_input_alone():
    frame = np.zeros((120, 200, 3), dtype=np.uint8)
    out = annotate_people(frame, [((10, 40, 60, 110), 1, "female")], header="People 1")
    assert frame.sum() == 0
    assert tuple(out[80, 10]) == GENDER_COLORS["female"]  # left edge of the box
