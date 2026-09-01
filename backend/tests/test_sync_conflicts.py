"""SPEC 5.4 — conflict rules, and SPEC 6.7 — two devices overselling a group.

These are the cases that decide whether the app quietly loses data, so they are
written before anything is built on top of the sync engine.
"""

import pytest
from sqlalchemy import select

from app.models import HealthRecord, Move, Purchase, Record, Room, Sale, SyncAnomaly
from tests.conftest import (
    op_health,
    op_move,
    op_purchase,
    op_record,
    op_room,
    op_sale,
    push,
    statuses,
    ts,
    ulid,
)

ROOM_A = ulid("room_a")
ROOM_B = ulid("room_b")
REC = ulid("rec_1")


def seed_rooms(client):
    push(
        client,
        "device-seed",
        [
            op_room(ROOM_A, ts(), code="R1", name="Front room", capacity=20),
            op_room(ROOM_B, ts(), code="R2", name="Back room left", capacity=20),
        ],
    )


# ---------------------------------------------------------------------------
# 5.4 — Event entities never conflict
# ---------------------------------------------------------------------------


def test_two_devices_moving_the_same_animal_offline_both_land(client, db):
    """SPEC 5.4: "the animal really did move twice"."""
    seed_rooms(client)
    push(client, "device-a", [op_record(REC, ts())])

    a = push(client, "device-a", [op_move(ulid("mv_a"), ts(10), REC, ROOM_A)])
    b = push(client, "device-b", [op_move(ulid("mv_b"), ts(20), REC, ROOM_B, from_room_id=ROOM_A)])

    assert statuses(a) == ["applied"]
    assert statuses(b) == ["applied"]

    moves = db.scalars(select(Move).where(Move.record_id == REC)).all()
    assert len(moves) == 2, "both moves are real events; neither may be dropped"


def test_pushing_the_same_event_twice_is_a_duplicate_not_an_error(client, db):
    """SPEC 5.3: a push that lands but whose response is lost must be retryable."""
    seed_rooms(client)
    push(client, "device-a", [op_record(REC, ts())])
    move = op_move(ulid("mv_a"), ts(10), REC, ROOM_A)

    first = push(client, "device-a", [move])
    second = push(client, "device-a", [move])

    assert statuses(first) == ["applied"]
    assert statuses(second) == ["duplicate"]
    assert len(db.scalars(select(Move)).all()) == 1


def test_events_from_two_devices_merge_as_a_union(client, db):
    """Two devices each adding different events: the merge is both sets."""
    seed_rooms(client)
    push(client, "device-a", [op_record(REC, ts())])

    push(client, "device-a", [op_move(ulid("mv_a1"), ts(10), REC, ROOM_A)])
    push(client, "device-b", [op_move(ulid("mv_b1"), ts(11), REC, ROOM_B)])
    push(client, "device-a", [op_move(ulid("mv_a2"), ts(12), REC, ROOM_A)])

    assert len(db.scalars(select(Move).where(Move.record_id == REC)).all()) == 3


# ---------------------------------------------------------------------------
# 5.4 — State entities: last-write-wins per field
# ---------------------------------------------------------------------------


def test_later_write_wins(client, db):
    push(client, "device-a", [op_room(ROOM_A, ts(0), name="Front room")])
    result = push(client, "device-b", [op_room(ROOM_A, ts(60), name="Renamed room")])

    assert statuses(result) == ["applied"]
    assert db.get(Room, ROOM_A).name == "Renamed room"


def test_earlier_write_loses_and_is_reported_as_a_conflict(client, db):
    """The loser is told, and handed the winning version to adopt."""
    push(client, "device-a", [op_room(ROOM_A, ts(60), name="Newer name")])
    result = push(client, "device-b", [op_room(ROOM_A, ts(0), name="Older name")])

    assert statuses(result) == ["conflict"]
    assert result["results"][0]["server"]["name"] == "Newer name"
    assert db.get(Room, ROOM_A).name == "Newer name"


def test_ties_break_on_the_lexically_greater_device_id(client, db):
    """SPEC 5.4 — identical timestamps must still resolve deterministically."""
    push(client, "device-a", [op_room(ROOM_A, ts(30), name="From A")])
    result = push(client, "device-z", [op_room(ROOM_A, ts(30), name="From Z")])

    assert statuses(result) == ["applied"]
    assert db.get(Room, ROOM_A).name == "From Z", "'device-z' > 'device-a'"


def test_the_losing_side_of_a_tie_is_rejected_in_the_other_order(client, db):
    """The same two writes in the opposite order reach the same answer."""
    push(client, "device-z", [op_room(ROOM_A, ts(30), name="From Z")])
    result = push(client, "device-a", [op_room(ROOM_A, ts(30), name="From A")])

    assert statuses(result) == ["conflict"]
    assert db.get(Room, ROOM_A).name == "From Z", "convergent regardless of arrival order"


def test_edits_to_different_fields_both_survive(client, db):
    """Per *field*, not per row.

    One device renames a room while another changes its capacity. A row-level
    merge would throw one of them away; both are real edits.
    """
    push(client, "device-a", [op_room(ROOM_A, ts(0), name="Front room", capacity=20)])

    push(
        client,
        "device-a",
        [
            {
                "op": "upsert", "entity": "room", "id": ROOM_A,
                "data": {"name": "Front room renamed"},
                "updated_at": ts(10),
            }
        ],
    )
    push(
        client,
        "device-b",
        [
            {
                "op": "upsert", "entity": "room", "id": ROOM_A,
                "data": {"capacity": 53},
                "updated_at": ts(20),
            }
        ],
    )

    room = db.get(Room, ROOM_A)
    assert room.name == "Front room renamed"
    assert room.capacity == 53


def test_a_stale_field_loses_while_a_fresh_one_in_the_same_push_wins(client, db):
    push(client, "device-a", [op_room(ROOM_A, ts(0), name="Original", capacity=20)])
    push(
        client,
        "device-a",
        [{"op": "upsert", "entity": "room", "id": ROOM_A, "data": {"name": "Newer name"}, "updated_at": ts(100)}],
    )

    result = push(
        client,
        "device-b",
        [
            {
                "op": "upsert", "entity": "room", "id": ROOM_A,
                "data": {"name": "Stale name", "capacity": 53},
                "updated_at": ts(50),
            }
        ],
    )

    assert statuses(result) == ["conflict"]
    room = db.get(Room, ROOM_A)
    assert room.name == "Newer name", "the stale field lost"
    assert room.capacity == 53, "the field the server had never seen still landed"


def test_replaying_a_state_upsert_is_a_duplicate(client, db):
    """SPEC 5.3 again, for state: a replay must not look like a conflict."""
    operation = op_room(ROOM_A, ts(10), name="Front room")
    push(client, "device-a", [operation])
    result = push(client, "device-a", [operation])

    assert statuses(result) == ["duplicate"]


# ---------------------------------------------------------------------------
# 5.4 — Duplicate tags across devices are accepted, never rejected
# ---------------------------------------------------------------------------


def test_duplicate_tags_from_two_devices_are_both_accepted(client, db):
    """SPEC 5.4: rejecting data already entered offline is the worst outcome.

    Both records land; the user resolves it from the "Duplicate tag" alert.
    """
    seed_rooms(client)
    a = push(client, "device-a", [op_record(ulid("rec_a"), ts(0), tag="C-084")])
    b = push(client, "device-b", [op_record(ulid("rec_b"), ts(10), tag="C-084")])

    assert statuses(a) == ["applied"]
    assert statuses(b) == ["applied"]

    with_tag = db.scalars(select(Record).where(Record.tag == "C-084")).all()
    assert len(with_tag) == 2


# ---------------------------------------------------------------------------
# 6.7 — Two devices overselling a group
# ---------------------------------------------------------------------------


GROUP = ulid("grp_1")


def seed_group(client, head: int = 8):
    seed_rooms(client)
    push(
        client,
        "device-a",
        [
            op_record(
                GROUP, ts(),
                kind="group", tag="P-Weaners", species="pigs",
                initial_head_count=head, arrival_date="2026-08-01",
            )
        ],
    )


def test_two_offline_devices_each_selling_five_of_eight_keep_both_sales(client, db):
    """SPEC 6.7, verbatim: group of 8, both devices offline, each sells 5.

    Both sales are kept, head_count clamps to 0, and an alert is raised.
    Never silently discard a sale.
    """
    seed_group(client, head=8)

    a = push(client, "device-a", [op_sale(ulid("sale_a"), ts(10), GROUP, count=5)])
    b = push(client, "device-b", [op_sale(ulid("sale_b"), ts(20), GROUP, count=5)])

    assert statuses(a) == ["applied"]
    assert statuses(b) == ["applied"]

    sales = db.scalars(select(Sale).where(Sale.record_id == GROUP)).all()
    assert len(sales) == 2, "both sales are real; neither may be discarded"
    assert sum(s.count for s in sales) == 10

    db.expire_all()
    record = db.get(Record, GROUP)
    assert record.head_count == 0, "clamped at zero, never negative"


def test_overselling_raises_an_alert_naming_the_record(client, db):
    seed_group(client, head=8)
    push(client, "device-a", [op_sale(ulid("sale_a"), ts(10), GROUP, count=5)])
    push(client, "device-b", [op_sale(ulid("sale_b"), ts(20), GROUP, count=5)])

    anomalies = db.scalars(select(SyncAnomaly).where(SyncAnomaly.entity_id == GROUP)).all()
    assert len(anomalies) == 1
    assert "P-Weaners" in anomalies[0].detail
    assert "reduced below zero by offline changes" in anomalies[0].detail


def test_an_emptied_group_leaves_the_active_list(client, db):
    """SPEC 6.1 — head_count reaching 0 sets status, history stays readable."""
    seed_group(client, head=8)
    push(client, "device-a", [op_sale(ulid("sale_a"), ts(10), GROUP, count=8)])

    db.expire_all()
    record = db.get(Record, GROUP)
    assert record.head_count == 0
    assert record.status == "sold"
    assert db.scalars(select(Sale).where(Sale.record_id == GROUP)).all(), "history remains"


def test_a_sale_within_the_group_does_not_clamp_or_alert(client, db):
    seed_group(client, head=8)
    push(client, "device-a", [op_sale(ulid("sale_a"), ts(10), GROUP, count=3)])

    db.expire_all()
    assert db.get(Record, GROUP).head_count == 5
    assert db.scalars(select(SyncAnomaly)).all() == []


def test_head_count_is_derived_not_taken_from_the_client(client, db):
    """A client's own arithmetic must not be able to overwrite the true count.

    This is what makes the 6.7 case work: if head_count were an ordinary
    last-write-wins field, the second device's stale figure would win by virtue
    of arriving later.
    """
    seed_group(client, head=8)
    push(client, "device-a", [op_sale(ulid("sale_a"), ts(10), GROUP, count=5)])

    push(
        client,
        "device-b",
        [{"op": "upsert", "entity": "record", "id": GROUP, "data": {"head_count": 8}, "updated_at": ts(99)}],
    )

    db.expire_all()
    assert db.get(Record, GROUP).head_count == 3


def test_splitting_a_group_reduces_the_parent_by_the_child(client, db):
    """SPEC 4.3 — a partial move splits off a child record with its own history."""
    seed_group(client, head=8)
    child = ulid("grp_2")

    push(
        client,
        "device-a",
        [
            op_record(
                child, ts(10),
                kind="group", tag="P-Weaners-2", species="pigs",
                initial_head_count=3, parent_record_id=GROUP, arrival_date="2026-08-01",
            ),
            op_move(ulid("mv_c"), ts(11), child, ROOM_B, count=3, from_room_id=ROOM_A),
        ],
    )

    db.expire_all()
    assert db.get(Record, GROUP).head_count == 5
    assert db.get(Record, child).head_count == 3
    assert db.get(Record, child).current_room_id == ROOM_B


def test_a_group_cannot_be_split_beyond_its_head_count(client, db):
    """SPEC 4.3 with 6.7's resolution: accept both, clamp, and alert."""
    seed_group(client, head=8)

    push(client, "device-a", [
        op_record(ulid("grp_a"), ts(10), kind="group", tag="P-A", species="pigs",
                  initial_head_count=6, parent_record_id=GROUP, arrival_date="2026-08-01"),
    ])
    push(client, "device-b", [
        op_record(ulid("grp_b"), ts(20), kind="group", tag="P-B", species="pigs",
                  initial_head_count=6, parent_record_id=GROUP, arrival_date="2026-08-01"),
    ])

    db.expire_all()
    assert db.get(Record, GROUP).head_count == 0
    assert len(db.scalars(select(SyncAnomaly).where(SyncAnomaly.entity_id == GROUP)).all()) == 1


# ---------------------------------------------------------------------------
# 6.14 — clock skew
# ---------------------------------------------------------------------------


def test_a_far_future_timestamp_cannot_win_a_conflict(client, db):
    """SPEC 6.14 — the server substitutes its own time for wild clocks."""
    push(client, "device-a", [op_room(ROOM_A, ts(0), name="Correct name")])

    far_future = "2030-01-01T00:00:00+00:00"
    push(client, "device-b", [op_room(ROOM_A, far_future, name="Skewed name")])

    # The skewed write still lands — it is real data — but stamped with server
    # time, so it cannot outrank writes made years from now.
    room = db.get(Room, ROOM_A)
    stamp = room.field_versions["name"]["updated_at"]
    assert not stamp.startswith("2030")


# ---------------------------------------------------------------------------
# Pull
# ---------------------------------------------------------------------------


def test_pull_returns_changes_across_entities_in_seq_order(client):
    seed_rooms(client)
    push(client, "device-a", [op_record(REC, ts())])
    push(client, "device-a", [op_move(ulid("mv_a"), ts(10), REC, ROOM_A)])

    body = client.get("/sync/pull?since=0&limit=500").json()
    seqs = [c["seq"] for c in body["changes"]]

    assert seqs == sorted(seqs)
    assert {c["entity"] for c in body["changes"]} == {"room", "record", "move"}
    assert body["has_more"] is False


def test_pull_resumes_from_a_cursor_without_repeating(client):
    seed_rooms(client)
    first = client.get("/sync/pull?since=0&limit=500").json()

    push(client, "device-a", [op_record(REC, ts())])
    second = client.get(f"/sync/pull?since={first['cursor']}&limit=500").json()

    assert [c["id"] for c in second["changes"]] == [REC]


def test_an_update_reappears_in_a_pull_after_the_cursor(client):
    """An edit has to advance seq, or a client that already pulled the row
    would never learn about it."""
    push(client, "device-a", [op_room(ROOM_A, ts(0), name="Front room")])
    cursor = client.get("/sync/pull?since=0&limit=500").json()["cursor"]

    push(client, "device-b", [op_room(ROOM_A, ts(60), name="Renamed room")])
    body = client.get(f"/sync/pull?since={cursor}&limit=500").json()

    assert [c["data"]["name"] for c in body["changes"]] == ["Renamed room"]


def test_pull_pages(client):
    seed_rooms(client)
    body = client.get("/sync/pull?since=0&limit=1").json()

    assert len(body["changes"]) == 1
    assert body["has_more"] is True


def test_pull_never_exposes_field_versions(client):
    """`field_versions` is a merge implementation detail, not client data."""
    push(client, "device-a", [op_room(ROOM_A, ts(0))])
    body = client.get("/sync/pull?since=0").json()

    assert "field_versions" not in body["changes"][0]["data"]


# ---------------------------------------------------------------------------
# Malformed operations must not wedge the outbox
# ---------------------------------------------------------------------------


def test_a_malformed_event_is_rejected_rather_than_retried_forever(client):
    seed_rooms(client)
    push(client, "device-a", [op_record(REC, ts())])

    broken = op_move(ulid("mv_bad"), ts(10), REC, ROOM_A)
    del broken["data"]["reason"]

    result = push(client, "device-a", [broken])
    assert statuses(result) == ["rejected"]
    assert result["results"][0]["message"]


def test_one_bad_operation_does_not_block_the_rest_of_the_batch(client, db):
    seed_rooms(client)
    push(client, "device-a", [op_record(REC, ts())])

    broken = op_move(ulid("mv_bad"), ts(10), REC, ROOM_A)
    del broken["data"]["reason"]
    good = op_move(ulid("mv_ok"), ts(11), REC, ROOM_B)

    result = push(client, "device-a", [broken, good])
    assert statuses(result) == ["rejected", "applied"]
    assert db.get(Move, ulid("mv_ok")) is not None


def test_a_move_can_reference_a_record_created_in_the_same_batch(client, db):
    """An outbox drains in the order the user worked, and a batch may hold both
    halves of one action: create the record, then move it."""
    seed_rooms(client)
    new_record = ulid("rec_new")

    result = push(
        client,
        "device-a",
        [
            op_record(new_record, ts(0), tag="C-900"),
            op_move(ulid("mv_new"), ts(1), new_record, ROOM_A),
        ],
    )

    assert statuses(result) == ["applied", "applied"]
    db.expire_all()
    assert db.get(Record, new_record).current_room_id == ROOM_A


def test_an_orphan_event_is_rejected_without_taking_the_batch_with_it(client, db):
    seed_rooms(client)
    push(client, "device-a", [op_record(REC, ts())])

    result = push(
        client,
        "device-a",
        [
            op_move(ulid("mv_orphan"), ts(10), ulid("nonexistent"), ROOM_A),
            op_move(ulid("mv_fine"), ts(11), REC, ROOM_B),
        ],
    )

    assert statuses(result) == ["rejected", "applied"]
    assert db.get(Move, ulid("mv_fine")) is not None


def test_current_room_follows_the_latest_move(client, db):
    """SPEC 4.1 — location is the destination of the latest move, by date then
    created_at. It is never a stored truth."""
    seed_rooms(client)
    push(client, "device-a", [op_record(REC, ts())])

    push(client, "device-a", [op_move(ulid("mv_1"), ts(10), REC, ROOM_A, date="2026-08-20")])
    db.expire_all()
    assert db.get(Record, REC).current_room_id == ROOM_A

    push(client, "device-a", [op_move(ulid("mv_2"), ts(20), REC, ROOM_B, date="2026-08-25")])
    db.expire_all()
    assert db.get(Record, REC).current_room_id == ROOM_B


def test_a_backdated_move_does_not_become_the_current_location(client, db):
    """SPEC 6.9 — backdating is allowed, and derived values recompute. A move
    dated before the latest one is history, not the current room."""
    seed_rooms(client)
    push(client, "device-a", [op_record(REC, ts())])
    push(client, "device-a", [op_move(ulid("mv_1"), ts(10), REC, ROOM_B, date="2026-08-25")])

    push(client, "device-a", [op_move(ulid("mv_0"), ts(20), REC, ROOM_A, date="2026-08-20")])

    db.expire_all()
    assert db.get(Record, REC).current_room_id == ROOM_B


# ---------------------------------------------------------------------------
# 3.7 — Purchases
# ---------------------------------------------------------------------------


def test_a_purchase_rides_along_with_the_record_that_was_bought(client, db):
    """Adding a bought record writes two rows in one batch, and the purchase
    keeps its own client-minted id so the pair can be replayed safely."""
    seed_rooms(client)
    record_id, purchase_id = ulid("rec_bought"), ulid("pur_1")

    result = push(
        client,
        "device-a",
        [
            op_record(record_id, ts(0), tag="C-901", source="bought"),
            op_move(ulid("mv_bought"), ts(1), record_id, ROOM_A),
            op_purchase(purchase_id, ts(2), record_id, price=1_500_000),
        ],
    )

    assert statuses(result) == ["applied", "applied", "applied"]
    purchase = db.get(Purchase, purchase_id)
    assert purchase.price == 1_500_000
    assert purchase.seller == "Nakawa market"
    assert purchase.record_id == record_id


def test_pushing_a_purchase_twice_is_harmless(client, db):
    """A push that lands but whose response is lost must be safely retryable
    (SPEC 5.3) — the second attempt is recognised, not duplicated."""
    seed_rooms(client)
    record_id, purchase_id = ulid("rec_dup"), ulid("pur_dup")
    push(client, "device-a", [op_record(record_id, ts(0), tag="C-902", source="bought")])

    first = push(client, "device-a", [op_purchase(purchase_id, ts(1), record_id)])
    second = push(client, "device-a", [op_purchase(purchase_id, ts(1), record_id)])

    assert statuses(first) == ["applied"]
    assert statuses(second) == ["duplicate"]
    assert db.scalars(select(Purchase).where(Purchase.record_id == record_id)).all().__len__() == 1


def test_a_purchase_without_a_price_is_rejected_rather_than_stored_as_zero(client, db):
    """A missing price is a broken operation, not a free animal. Rejecting it
    drops it from the outbox instead of retrying forever (SPEC 5.6)."""
    seed_rooms(client)
    record_id = ulid("rec_noprice")
    push(client, "device-a", [op_record(record_id, ts(0), tag="C-903", source="bought")])

    operation = op_purchase(ulid("pur_bad"), ts(1), record_id)
    del operation["data"]["price"]

    assert statuses(push(client, "device-a", [operation])) == ["rejected"]


def test_a_purchase_appears_in_a_pull_like_any_other_entity(client, db):
    """One cursor covers every table, so a device that has never seen purchases
    receives them in the same ordered scan as everything else."""
    seed_rooms(client)
    record_id, purchase_id = ulid("rec_pull"), ulid("pur_pull")
    push(
        client,
        "device-a",
        [
            op_record(record_id, ts(0), tag="C-904", source="bought"),
            op_purchase(purchase_id, ts(1), record_id, price=900_000),
        ],
    )

    body = client.get("/sync/pull?since=0&limit=500").json()
    purchases = [c for c in body["changes"] if c["entity"] == "purchase"]

    assert [c["id"] for c in purchases] == [purchase_id]
    assert purchases[0]["data"]["price"] == 900_000


# ---------------------------------------------------------------------------
# 3.6 — Health records
# ---------------------------------------------------------------------------


def test_a_treatment_keeps_the_dates_that_drive_alerts_and_the_calendar(client, db):
    """`next_due` and `withdrawal_days` are the whole point of the row: one
    feeds SPEC 4.6's overdue alerts, the other SPEC 6.6's sale warning."""
    seed_rooms(client)
    record_id, health_id = ulid("rec_treat"), ulid("hr_1")
    push(client, "device-a", [op_record(record_id, ts(0), tag="C-084")])

    result = push(
        client,
        "device-a",
        [
            op_health(
                health_id, ts(1), record_id,
                product="FMD", dose="2ml", next_due="2026-09-30",
                withdrawal_days=14, cost=80_000,
            )
        ],
    )

    assert statuses(result) == ["applied"]
    treatment = db.get(HealthRecord, health_id)
    assert treatment.next_due.isoformat() == "2026-09-30"
    assert treatment.withdrawal_days == 14
    assert treatment.cost == 80_000


def test_two_devices_treating_the_same_animal_keep_both_treatments(client, db):
    """Events are the union of what every device recorded (SPEC 5.4). An animal
    dosed twice because two people were out of signal is a real fact about that
    animal, not a conflict to resolve away."""
    seed_rooms(client)
    record_id = ulid("rec_both")
    push(client, "device-a", [op_record(record_id, ts(0), tag="C-085")])

    push(client, "device-a", [op_health(ulid("hr_a"), ts(1), record_id, product="FMD")])
    push(client, "device-b", [op_health(ulid("hr_b"), ts(1), record_id, product="Dewormer")])

    treatments = db.scalars(
        select(HealthRecord).where(HealthRecord.record_id == record_id)
    ).all()
    assert sorted(t.product for t in treatments) == ["Dewormer", "FMD"]


def test_a_treatment_without_a_type_is_rejected(client, db):
    """SPEC 3.6 makes type required; an untyped treatment cannot be shown as
    anything, so it is dropped rather than retried forever (SPEC 5.6)."""
    seed_rooms(client)
    record_id = ulid("rec_notype")
    push(client, "device-a", [op_record(record_id, ts(0), tag="C-086")])

    operation = op_health(ulid("hr_bad"), ts(1), record_id)
    del operation["data"]["type"]

    assert statuses(push(client, "device-a", [operation])) == ["rejected"]
