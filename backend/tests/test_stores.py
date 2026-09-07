"""Stores and produce over the wire.

SPEC 20.13. Stores and produce types are state entities merged per field;
intakes, outtakes and counts are events, append-only.

The balance itself is not tested here — it is derived on the client and covered
in `frontend/src/domain/stores.test.ts`. What is tested here is that the events
it folds actually survive the round trip, in the shape the client sent them.
"""

from decimal import Decimal

from app.models import ProduceType, StockCount, StockIntake, StockOuttake, Store
from tests.conftest import (
    PRODUCE_BEANS,
    PRODUCE_COFFEE,
    STORE_1,
    STORE_2,
    op_intake,
    op_outtake,
    op_produce_type,
    op_stock_count,
    op_store,
    push,
    ts,
    ulid,
)


def test_the_two_stores_and_three_produce_types_are_seeded(db):
    """SPEC 20.3, 20.4 — at the fixed IDs the client seed also uses.

    Two devices seeding offline have to arrive at the same two stores, or the
    first sync produces four — and a balance split across a pair of duplicates
    is wrong in both halves.
    """
    assert db.get(Store, STORE_1).code == "S1"
    assert db.get(Store, STORE_2).code == "S2"
    assert db.get(ProduceType, PRODUCE_BEANS).name == "Beans"
    assert db.get(ProduceType, PRODUCE_COFFEE).name == "Coffee"


def test_an_intake_round_trips(client, db):
    id_ = ulid("in_a")
    push(client, "device-a", [op_intake(id_, ts(), kg=620, sacks=10)])

    row = db.get(StockIntake, id_)
    assert row.store_id == STORE_1
    assert row.produce_type_id == PRODUCE_COFFEE
    assert row.kg == Decimal("620.000")
    assert row.sacks == 10
    assert row.source == "garden"


def test_an_outtake_keeps_the_total_price_as_the_stored_truth(client, db):
    """SPEC 20.6 — every money figure reads `total_price`, so none of them
    depends on whether the deal was struck per kilogram or per sack."""
    id_ = ulid("out_a")
    push(
        client,
        "device-a",
        [op_outtake(id_, ts(), price_basis="sack", unit_price=260_000, total_price=1_040_000)],
    )

    row = db.get(StockOuttake, id_)
    assert row.total_price == 1_040_000
    assert row.price_basis == "sack"
    # What was typed is kept for audit, and is not back-computed into a per-kg
    # figure — SPEC 20.8 forbids deriving either quantity from the other.
    assert row.unit_price == 260_000


def test_a_stock_count_round_trips(client, db):
    id_ = ulid("cnt_a")
    push(client, "device-a", [op_stock_count(id_, ts(), counted_kg=300, counted_sacks=5)])

    row = db.get(StockCount, id_)
    assert row.counted_kg == Decimal("300.000")
    assert row.counted_sacks == 5


def test_sacks_may_be_absent_but_weight_may_not(client, db):
    """SPEC 20.8 — `kg` is required on every event and `sacks` never is.

    A missing sack count means "not counted", which is what makes a sack
    balance report as partial rather than as though it were complete.
    """
    ok = ulid("in_nosacks")
    push(client, "device-a", [op_intake(ok, ts(), sacks=None, kg=620)])
    assert db.get(StockIntake, ok).sacks is None

    rejected = ulid("in_nokg")
    body = push(client, "device-a", [op_intake(rejected, ts(), kg=None)])
    assert body["results"][0]["status"] == "rejected"
    assert db.get(StockIntake, rejected) is None


def test_an_outtake_without_a_reason_is_rejected(client, db):
    """SPEC 20.6 — an unexplained outtake is a hole in exactly the records this
    feature exists to keep."""
    id_ = ulid("out_noreason")
    body = push(client, "device-a", [op_outtake(id_, ts(), reason=None)])

    assert body["results"][0]["status"] == "rejected"
    assert db.get(StockOuttake, id_) is None


def test_a_fractional_weight_survives_exactly(client, db):
    """Kilograms are the only non-integer quantity in the database, and a
    balance is a sum of many of them. Numeric rather than double precision, so a
    stored weight is one that can be reconciled against a scale."""
    id_ = ulid("in_frac")
    push(client, "device-a", [op_intake(id_, ts(), kg=620.125)])

    assert db.get(StockIntake, id_).kg == Decimal("620.125")


def test_a_weight_comes_back_over_the_wire_as_a_number(client):
    """The client stores plain JS numbers. A Decimal serialised as a string
    would be compared and summed as text on the device."""
    push(client, "device-a", [op_intake(ulid("in_wire"), ts(), kg=620.5)])

    body = client.get("/sync/pull?since=0&limit=500").json()
    intakes = [c for c in body["changes"] if c["entity"] == "stock_intake"]
    assert len(intakes) == 1
    assert intakes[0]["data"]["kg"] == 620.5
    assert isinstance(intakes[0]["data"]["kg"], (int, float))


def test_a_move_arrives_as_two_ordinary_events(client, db):
    """SPEC 20.6 — the client writes the outtake and its mirrored intake in one
    transaction (SPEC 20.14.8); they reach the server as two ordinary rows."""
    out_id, in_id = ulid("out_move"), ulid("in_move")
    push(
        client,
        "device-a",
        [
            op_outtake(out_id, ts(), reason="moved", to_store_id=STORE_2, total_price=None,
                       unit_price=None, price_basis=None),
            op_intake(in_id, ts(), store_id=STORE_2, kg=248, sacks=4),
        ],
    )

    assert db.get(StockOuttake, out_id).to_store_id == STORE_2
    assert db.get(StockIntake, in_id).store_id == STORE_2


def test_a_store_merges_per_field(client, db):
    """SPEC 20.13 — a state entity. One device renaming a store and another
    setting its capacity must not cost each other their edit (SPEC 5.4)."""
    push(client, "device-a", [op_store(STORE_1, ts(0), code="S1", name="Upper store")])
    # Only the field device-b actually touched. A client that resends every
    # field it manages manufactures conflicts it did not have (see
    # `changedOnly` on the client), so the fixture must not do it either.
    push(
        client,
        "device-b",
        [{
            "op": "upsert",
            "entity": "store",
            "id": STORE_1,
            "data": {"capacity_sacks": 200},
            "updated_at": ts(10),
        }],
    )

    row = db.get(Store, STORE_1)
    assert row.capacity_sacks == 200
    assert row.name == "Upper store"


def test_a_produce_type_is_archived_rather_than_deleted(client, db):
    """SPEC 20.14.5 — a type with history keeps naming the stock it explains
    while dropping out of every picker."""
    id_ = ulid("pt_arch")
    push(client, "device-a", [op_produce_type(id_, ts(0), name="Groundnuts")])
    push(client, "device-a", [op_produce_type(id_, ts(10), is_active=False)])

    row = db.get(ProduceType, id_)
    assert row.is_active is False
    assert row.deleted_at is None
    assert row.name == "Groundnuts"


def test_stock_events_do_not_need_a_record_id(client, db):
    """SPEC 20.13 names this explicitly.

    `_apply_event` once read `fields["record_id"]` unconditionally, which turned
    pushing an expense into a KeyError the surrounding handler did not catch and
    wedged the whole batch. Stock events have no `record_id` either, so the fix
    is confirmed here rather than assumed — and confirmed as a *batch*, since
    the failure mode was never one row but everything queued behind it.
    """
    a, b, c = ulid("in_batch"), ulid("out_batch"), ulid("cnt_batch")
    body = push(
        client,
        "device-a",
        [
            op_intake(a, ts()),
            op_outtake(b, ts()),
            op_stock_count(c, ts()),
        ],
    )

    assert [r["status"] for r in body["results"]] == ["applied", "applied", "applied"]
    assert db.get(StockIntake, a) is not None
    assert db.get(StockOuttake, b) is not None
    assert db.get(StockCount, c) is not None


def test_a_stock_event_does_not_wedge_the_rest_of_a_batch(client, db):
    """One bad row rolls back alone. The intake after it must still land."""
    bad, good = ulid("in_bad"), ulid("in_good")
    body = push(
        client,
        "device-a",
        [op_intake(bad, ts(), kg=None), op_intake(good, ts(), kg=100)],
    )

    assert body["results"][0]["status"] == "rejected"
    assert body["results"][1]["status"] == "applied"
    assert db.get(StockIntake, good) is not None


def test_stock_events_advance_the_shared_seq(client):
    """SPEC 5.2 — one cursor pulls every change across every table."""
    push(client, "device-a", [op_intake(ulid("in_seq"), ts())])

    body = client.get("/sync/pull?since=0&limit=500").json()
    seqs = [c["seq"] for c in body["changes"]]
    assert seqs == sorted(seqs)
    assert any(c["entity"] == "stock_intake" for c in body["changes"])


def test_a_typical_sack_weight_is_optional_and_ships_empty(client, db):
    """SPEC 20.17 — set by the farm, never guessed.

    A seeded number would be one the farm never chose, quietly deciding what
    counts as a typo on their scales. With the column empty no warning fires and
    everything else works normally.
    """
    assert db.get(ProduceType, PRODUCE_COFFEE).typical_sack_kg is None


def test_a_typical_sack_weight_round_trips(client, db):
    push(
        client,
        "device-a",
        [{
            "op": "upsert",
            "entity": "produce_type",
            "id": PRODUCE_COFFEE,
            "data": {"typical_sack_kg": 60},
            "updated_at": ts(),
        }],
    )

    row = db.get(ProduceType, PRODUCE_COFFEE)
    assert row.typical_sack_kg == Decimal("60.000")
    # Setting it must not disturb the name it was seeded with (SPEC 5.4).
    assert row.name == "Coffee"


def test_a_typical_sack_weight_can_be_cleared(client, db):
    """The farm may decide it was wrong. Clearing it stops the warning rather
    than leaving a stale figure questioning correct entries."""
    push(client, "device-a", [{
        "op": "upsert", "entity": "produce_type", "id": PRODUCE_COFFEE,
        "data": {"typical_sack_kg": 60}, "updated_at": ts(0),
    }])
    push(client, "device-a", [{
        "op": "upsert", "entity": "produce_type", "id": PRODUCE_COFFEE,
        "data": {"typical_sack_kg": None}, "updated_at": ts(10),
    }])

    assert db.get(ProduceType, PRODUCE_COFFEE).typical_sack_kg is None
