"""The counting logic (app/services/gender_service.py) with synthetic boxes:
no model, no database, no clock."""

from app.services.gender_service import CountingParams, GenderCounter, assign_gender_boxes
from app.services.tracking_service import Detection, GenderBox

PARAMS = CountingParams(match_overlap=0.6, min_votes=2, visit_gap_seconds=5.0, visit_min_dwell_s=1.0)

ALICE = (100.0, 100.0, 160.0, 300.0)
BOB = (400.0, 100.0, 470.0, 320.0)


def person(track_id, box):
    return Detection(track_id=track_id, confidence=0.9, box=box)


def upper_body(box, label, confidence=0.8):
    """gender.pt tends to box the head and shoulders: the top third of the person."""
    x1, y1, x2, y2 = box
    return GenderBox(label=label, confidence=confidence, box=(x1 + 5, y1, x2 - 5, y1 + (y2 - y1) / 3))


# --------------------------------------------------------------- assignment
def test_a_gender_box_goes_to_the_person_it_covers():
    tracks = [person(1, ALICE), person(2, BOB)]
    assigned = assign_gender_boxes(tracks, [upper_body(BOB, "male"), upper_body(ALICE, "female")], 0.6)
    assert assigned[1].label == "female"
    assert assigned[2].label == "male"


def test_a_box_between_people_or_off_them_is_ignored():
    stray = GenderBox("male", 0.9, (300.0, 100.0, 380.0, 200.0))
    assert assign_gender_boxes([person(1, ALICE), person(2, BOB)], [stray], 0.6) == {}


def test_one_box_per_person_and_one_person_per_box():
    """Two boxes on one person: the better fitting one wins, the other is unused."""
    tight = upper_body(ALICE, "female")
    loose = GenderBox("male", 0.9, (90.0, 90.0, 170.0, 310.0))
    assigned = assign_gender_boxes([person(1, ALICE)], [loose, tight], 0.6)
    assert list(assigned) == [1]
    assert assigned[1] is loose  # covers the person entirely: highest overlap and IoU


# ------------------------------------------------------------------- voting
def test_label_settles_only_after_enough_votes():
    counter = GenderCounter(PARAMS)
    counter.update([person(1, ALICE)], 0.0, [upper_body(ALICE, "female")])
    assert counter.label_of(1) == "unknown"
    counter.update([person(1, ALICE)], 0.2, [upper_body(ALICE, "female")])
    assert counter.label_of(1) == "female"


def test_votes_are_confidence_weighted():
    counter = GenderCounter(PARAMS)
    counter.update([person(1, ALICE)], 0.0, [upper_body(ALICE, "male", 0.45)])
    counter.update([person(1, ALICE)], 0.2, [upper_body(ALICE, "male", 0.45)])
    counter.update([person(1, ALICE)], 0.4, [upper_body(ALICE, "female", 0.95)])
    assert counter.label_of(1) == "female"  # 0.95 beats 0.9


def test_frames_without_gender_inference_do_not_vote():
    counter = GenderCounter(PARAMS)
    for t in range(5):
        counter.update([person(1, ALICE)], float(t), None)
    assert counter.tracks[1].vote_count == 0


# ------------------------------------------------------------------- visits
def test_a_visit_is_written_once_the_track_has_been_gone_long_enough():
    counter = GenderCounter(PARAMS, session="s1")
    counter.update([person(7, BOB)], 100.0, [upper_body(BOB, "male")])
    counter.update([person(7, BOB)], 103.0, [upper_body(BOB, "male")])
    assert counter.update([], 107.0) == []  # gone 4 s: could still come back

    visits = counter.update([], 108.5)
    assert len(visits) == 1
    visit = visits[0]
    assert visit.track_key == "s1:7"
    assert visit.gender == "male"
    assert visit.confidence == 1.0
    assert visit.dwell_s == 3.0
    assert visit.first_seen.timestamp() == 100.0
    assert counter.tracks == {}


def test_a_track_that_returns_in_time_is_still_one_visit():
    counter = GenderCounter(PARAMS)
    counter.update([person(1, ALICE)], 0.0)
    counter.update([], 3.0)
    counter.update([person(1, ALICE)], 4.0)
    assert counter.update([], 8.9) == []  # 4.9 s since the last sighting
    (visit,) = counter.update([], 9.1)
    assert visit.dwell_s == 4.0


def test_flicker_shorter_than_the_minimum_dwell_is_not_a_visit():
    counter = GenderCounter(PARAMS)
    counter.update([person(1, ALICE)], 0.0)
    counter.update([person(1, ALICE)], 0.5)
    assert counter.update([], 10.0) == []


def test_unlabelled_people_are_counted_as_unknown():
    counter = GenderCounter(PARAMS)
    counter.update([person(1, ALICE)], 0.0)
    counter.update([person(1, ALICE)], 2.0)
    (visit,) = counter.flush(2.0)
    assert visit.gender == "unknown"
    assert visit.confidence is None


def test_flush_ends_every_open_track():
    counter = GenderCounter(PARAMS)
    counter.update([person(1, ALICE), person(2, BOB)], 0.0)
    counter.update([person(1, ALICE), person(2, BOB)], 2.0)
    assert len(counter.flush(2.0)) == 2
    assert counter.occupancy()["person_count"] == 0


# ---------------------------------------------------------------- occupancy
def test_occupancy_parts_always_add_up():
    counter = GenderCounter(PARAMS)
    kid = (250.0, 200.0, 290.0, 300.0)
    tracks = [person(1, ALICE), person(2, BOB), person(3, kid)]
    boxes = [upper_body(ALICE, "female"), upper_body(BOB, "male"), upper_body(kid, "child")]
    counter.update(tracks, 0.0, boxes)
    counter.update(tracks, 0.2, boxes[:2])  # the child's second vote is missing

    occupancy = counter.occupancy()
    assert occupancy == {
        "male_count": 1,
        "female_count": 1,
        "child_count": 0,
        "unknown_count": 1,
        "person_count": 3,
    }
    parts = sum(v for k, v in occupancy.items() if k != "person_count")
    assert parts == occupancy["person_count"]


def test_occupancy_is_the_latest_frame_only():
    counter = GenderCounter(PARAMS)
    counter.update([person(1, ALICE), person(2, BOB)], 0.0)
    counter.update([person(2, BOB)], 0.2)
    assert counter.occupancy()["person_count"] == 1
    assert [p["track_id"] for p in counter.snapshot()] == [2]


def test_camera_settings_override_the_defaults_and_bad_values_are_ignored():
    params = CountingParams.from_settings({"min_votes": "4", "visit_gap_seconds": "soon"})
    assert params.min_votes == 4
    assert params.visit_gap_seconds == CountingParams.from_settings({}).visit_gap_seconds
