"""SPEC 14 — vet visits over the wire.

The fee split is a client-side rule and is tested there
(`frontend/src/domain/visits.test.ts`). What is tested here is the half only the
server decides: that a visit merges per field rather than being append-only,
that a note is an event that never conflicts, and that a treatment carries the
visit it was given during.
"""

from sqlalchemy import select

from app.models import HealthRecord, VetVisit, VisitNote
from tests.conftest import (
    op_health,
    op_record,
    op_visit,
    op_visit_note,
    push,
    statuses,
    ts,
    ulid,
)

REC = ulid("rec_v1")
VISIT = ulid("vis_1")


def test_a_visit_can_be_marked_completed_after_it_was_planned(client, db):
    """SPEC 14.2 — "create the visit ... mark completed".

    This is the case SPEC 16's "events, append-only" note cannot express, and
    the reason a visit is modelled as a state entity. An append-only visit would
    make this a second visit, and the call-out fee would be counted twice.
    """
    push(client, "device-a", [op_visit(VISIT, ts(), status="planned", date="2026-09-30")])
    body = push(client, "device-a", [op_visit(VISIT, ts(10), status="completed")])
    db.expire_all()

    assert statuses(body) == ["applied"]
    visits = db.scalars(select(VetVisit)).all()
    assert len(visits) == 1, "one visit, not two"
    assert visits[0].status == "completed"


def test_two_devices_editing_different_halves_of_a_visit_both_keep_their_edit(client, db):
    """SPEC 5.4 — one person marks it completed, another types up the advice."""
    push(client, "device-a", [op_visit(VISIT, ts(), status="planned")])

    push(
        client,
        "device-a",
        [
            {
                "op": "upsert",
                "entity": "vet_visit",
                "id": VISIT,
                "data": {"status": "completed"},
                "updated_at": ts(10),
                "field_updated_at": {"status": ts(10)},
            }
        ],
    )
    push(
        client,
        "device-b",
        [
            {
                "op": "upsert",
                "entity": "vet_visit",
                "id": VISIT,
                "data": {"notes": "Keep the calf inside for a week"},
                "updated_at": ts(20),
                "field_updated_at": {"notes": ts(20)},
            }
        ],
    )
    db.expire_all()

    visit = db.get(VetVisit, VISIT)
    assert visit.status == "completed"
    assert visit.notes == "Keep the calf inside for a week"


def test_a_treatment_carries_the_visit_it_was_given_during(client, db):
    push(client, "device-a", [op_record(REC, ts())])
    push(client, "device-a", [op_visit(VISIT, ts())])
    push(client, "device-a", [op_health(ulid("hr_v1"), ts(), REC, visit_id=VISIT)])
    db.expire_all()

    assert db.get(HealthRecord, ulid("hr_v1")).visit_id == VISIT


def test_a_self_administered_treatment_carries_no_visit(client, db):
    """SPEC 14.2 — "self-administered treatments do not"."""
    push(client, "device-a", [op_record(REC, ts())])
    push(client, "device-a", [op_health(ulid("hr_v2"), ts(), REC)])
    db.expire_all()

    assert db.get(HealthRecord, ulid("hr_v2")).visit_id is None


def test_a_visit_note_is_an_event_and_pushing_it_twice_is_harmless(client, db):
    """SPEC 5.3 — a push whose response was lost must be safely retryable."""
    push(client, "device-a", [op_record(REC, ts())])
    push(client, "device-a", [op_visit(VISIT, ts())])

    note = op_visit_note(ulid("vn_1"), ts(), VISIT, REC)
    first = push(client, "device-a", [note])
    second = push(client, "device-a", [note])

    assert statuses(first) == ["applied"]
    assert statuses(second) == ["duplicate"]
    assert len(db.scalars(select(VisitNote)).all()) == 1


def test_two_devices_noting_the_same_animal_keep_both_notes(client, db):
    """SPEC 5.4 — events are append-only, so they cannot conflict."""
    push(client, "device-a", [op_record(REC, ts())])
    push(client, "device-a", [op_visit(VISIT, ts())])

    push(client, "device-a", [op_visit_note(ulid("vn_a"), ts(10), VISIT, REC, "Watch the leg")])
    push(client, "device-b", [op_visit_note(ulid("vn_b"), ts(20), VISIT, REC, "Check again Friday")])
    db.expire_all()

    notes = db.scalars(select(VisitNote).where(VisitNote.record_id == REC)).all()
    assert len(notes) == 2


def test_a_note_without_a_visit_is_rejected_rather_than_stored_loose(client, db):
    """A note that names no visit cannot take a share of any fee, and would be
    an observation nothing could ever show."""
    push(client, "device-a", [op_record(REC, ts())])

    body = push(
        client,
        "device-a",
        [
            {
                "op": "insert",
                "entity": "visit_note",
                "id": ulid("vn_bad"),
                "data": {"record_id": REC, "note": "Watch it"},
                "updated_at": ts(),
            }
        ],
    )
    assert statuses(body) == ["rejected"]


def test_a_note_naming_a_visit_that_does_not_exist_is_rejected_alone(client, db):
    """SPEC 5 — one bad operation must not wedge the batch behind it."""
    push(client, "device-a", [op_record(REC, ts())])

    body = push(
        client,
        "device-a",
        [
            op_visit_note(ulid("vn_orph"), ts(), ulid("vis_gone"), REC),
            op_visit(VISIT, ts(10)),
        ],
    )
    assert statuses(body) == ["rejected", "applied"]


def test_a_visit_appears_in_a_pull_like_any_other_entity(client):
    push(client, "device-a", [op_visit(VISIT, ts(), reason="Calf not feeding")])

    body = client.get("/sync/pull?since=0&limit=500").json()
    visits = [c for c in body["changes"] if c["entity"] == "vet_visit"]

    assert len(visits) == 1
    assert visits[0]["data"]["reason"] == "Calf not feeding"
    assert visits[0]["data"]["call_out_fee"] == 90_000
    # SPEC 5.4 — the per-field stamps are the server's own bookkeeping.
    assert "field_versions" not in visits[0]["data"]
