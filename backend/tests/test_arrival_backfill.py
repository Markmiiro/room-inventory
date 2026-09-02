"""The arrival dates that were discarded for animals, and the recovery of them.

`createRecord` used to keep `arrival_date` only for groups, so the date typed on
the add form never reached the database for an animal — it survived only as the
date of the record's initial placement. Migration 0007 reads it back from there.

What is checked here is the SQL, since it is the half that runs unattended
against real rows. The rule itself is also tested on the client, where the same
recovery runs against IndexedDB (`frontend/src/db/backfill.test.ts`).
"""

import importlib.util
import pathlib
from datetime import date

from sqlalchemy import text

from app.models import Record
from tests.conftest import op_move, op_record, push, ts, ulid

ROOM = ulid("room_bf")


def _backfill_sql() -> str:
    """The statement migration 0007 ships, read from the migration itself.

    Copying the SQL into this file would let the two drift, and a backfill that
    is tested but not the one that runs is worse than no test at all.
    """
    path = (
        pathlib.Path(__file__).resolve().parents[1]
        / "alembic"
        / "versions"
        / "0007_backfill_animal_arrival_date.py"
    )
    spec = importlib.util.spec_from_file_location("backfill_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.BACKFILL_SQL


def _backfill(db):
    """Re-run the migration's statement over rows this test just created.

    Alembic applied it to the test database before any row existed, so it is run
    again here. It is written to be safe to apply more than once, which is what
    makes that possible — and this exercises that property too.
    """
    db.execute(text(_backfill_sql()))
    db.commit()
    db.expire_all()


def _room(client):
    push(
        client,
        "device-seed",
        [
            {
                "op": "upsert",
                "entity": "room",
                "id": ROOM,
                "data": {"code": "R1", "name": "Front room", "capacity": 20},
                "updated_at": ts(),
            }
        ],
    )


def test_it_reads_the_typed_date_back_from_the_initial_placement(client, db):
    _room(client)
    rec = ulid("rec_bf1")
    push(client, "device-a", [op_record(rec, ts(), arrival_date=None)])
    push(client, "device-a", [op_move(ulid("mv_bf1"), ts(), rec, ROOM, date="2026-08-12")])

    assert db.get(Record, rec).arrival_date is None
    _backfill(db)
    assert db.get(Record, rec).arrival_date == date(2026, 8, 12)


def test_it_does_not_overwrite_a_date_that_is_already_there(client, db):
    _room(client)
    rec = ulid("rec_bf2")
    push(client, "device-a", [op_record(rec, ts(), arrival_date="2026-01-01")])
    push(client, "device-a", [op_move(ulid("mv_bf2"), ts(), rec, ROOM, date="2026-08-12")])

    _backfill(db)
    assert db.get(Record, rec).arrival_date == date(2026, 1, 1), "a real value was kept"


def test_it_leaves_an_animal_with_no_placement_alone(client, db):
    """SPEC 13.4 — no move to read back means no date, never an invented one."""
    rec = ulid("rec_bf3")
    push(client, "device-a", [op_record(rec, ts(), arrival_date=None)])

    _backfill(db)
    assert db.get(Record, rec).arrival_date is None


def test_it_ignores_a_move_that_is_not_an_arrival(client, db):
    """Only the initial placement counts — a later move is not an arrival."""
    _room(client)
    other = ulid("room_bf2")
    push(
        client,
        "device-seed",
        [
            {
                "op": "upsert",
                "entity": "room",
                "id": other,
                "data": {"code": "R2", "name": "Back room", "capacity": 20},
                "updated_at": ts(),
            }
        ],
    )
    rec = ulid("rec_bf4")
    push(client, "device-a", [op_record(rec, ts(), arrival_date=None)])
    push(client, "device-a", [op_move(ulid("mv_bf4a"), ts(), rec, ROOM, date="2026-08-12")])
    push(
        client,
        "device-a",
        [op_move(ulid("mv_bf4b"), ts(10), rec, other, from_room_id=ROOM, date="2026-08-30")],
    )

    _backfill(db)
    assert db.get(Record, rec).arrival_date == date(2026, 8, 12)


def test_it_advances_seq_so_the_correction_reaches_devices(client, db):
    """An update that does not move `seq` is invisible to a client that has
    already pulled the row (see `_next_seq` in app/sync.py)."""
    _room(client)
    rec = ulid("rec_bf5")
    push(client, "device-a", [op_record(rec, ts(), arrival_date=None)])
    push(client, "device-a", [op_move(ulid("mv_bf5"), ts(), rec, ROOM, date="2026-08-12")])

    before = db.get(Record, rec).seq
    _backfill(db)
    assert db.get(Record, rec).seq > before
