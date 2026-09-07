"""Splitting `poultry` into hens, ducks, geese and turkeys.

SPEC 18. Migration 0009 moves every row still carrying the retired value, and
the three kinds of row do not all go to the same place: records and
species-tagged expenses become `hens`, while treatment schedules become `birds`.

What is checked here is the SQL, since it is the half that runs unattended
against real rows. The client runs the same remap against IndexedDB and is
tested separately in `frontend/src/db/backfill.test.ts`.
"""

import importlib.util
import pathlib

from sqlalchemy import text

from app.models import Expense, Record, TreatmentSchedule
from tests.conftest import op_category, op_expense, op_record, op_schedule, push, ts, ulid


def _migration():
    """The statements migration 0009 ships, read from the migration itself.

    Copying the SQL into this file would let the two drift, and a migration that
    is tested but is not the one that runs is worse than no test at all.
    """
    path = (
        pathlib.Path(__file__).resolve().parents[1]
        / "alembic"
        / "versions"
        / "0009_split_poultry_species.py"
    )
    spec = importlib.util.spec_from_file_location("poultry_split_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _split(db):
    """Re-run the migration's statements over rows this test just created.

    Alembic applied them to the test database before any row existed, so they
    are run again here. They are written to be safe to apply more than once,
    which is what makes that possible — and this exercises that property too.
    """
    migration = _migration()
    for sql in (migration.RECORDS_SQL, migration.SCHEDULES_SQL, migration.EXPENSES_SQL):
        db.execute(text(sql))
    db.commit()
    db.expire_all()


def test_it_moves_a_poultry_record_to_hens(client, db):
    id_ = ulid("rec_poultry")
    push(client, "device-a", [op_record(id_, ts(), species="poultry", tag="P-1")])

    _split(db)

    assert db.get(Record, id_).species == "hens"


def test_it_leaves_every_other_species_alone(client, db):
    cattle, pigs = ulid("rec_cattle"), ulid("rec_pigs")
    push(
        client,
        "device-a",
        [
            op_record(cattle, ts(), species="cattle", tag="C-1"),
            op_record(pigs, ts(), species="pigs", tag="P-9"),
        ],
    )

    _split(db)

    assert db.get(Record, cattle).species == "cattle"
    assert db.get(Record, pigs).species == "pigs"


def test_it_moves_a_sold_record_too(client, db):
    """Sold and dead records stay readable under the "Sold or dead" filter
    (SPEC 4.8). Leaving a value behind that is no longer in the enum would
    break every screen that reads one back."""
    id_ = ulid("rec_sold")
    push(client, "device-a", [op_record(id_, ts(), species="poultry", tag="P-2", status="sold")])

    _split(db)

    assert db.get(Record, id_).species == "hens"


def test_it_advances_seq_so_devices_pull_the_correction(client, db):
    """A client that had already pulled the record would otherwise never see it
    change — see `_next_seq` in app/sync.py."""
    id_ = ulid("rec_seq")
    push(client, "device-a", [op_record(id_, ts(), species="poultry", tag="P-3")])
    before = db.get(Record, id_).seq

    _split(db)

    assert db.get(Record, id_).seq > before


def test_it_does_not_advance_updated_at(client, db):
    """SPEC 5.4 resolves these rows last-write-wins per field. A device that has
    already corrected a pen of ducks by hand must keep that correction, and
    touching `updated_at` would make the migration win every such race."""
    id_ = ulid("rec_stamp")
    push(client, "device-a", [op_record(id_, ts(), species="poultry", tag="P-4")])
    before = db.get(Record, id_).updated_at

    _split(db)

    assert db.get(Record, id_).updated_at == before


def test_it_moves_a_poultry_schedule_to_birds_not_hens(client, db):
    """The distinction that matters. Narrowing the seeded Newcastle row to hens
    would silently stop vaccinating the ducks — the quiet gap SPEC 13.1 exists
    to close."""
    id_ = ulid("sched_poultry")
    push(
        client,
        "device-a",
        [op_schedule(id_, ts(), name="Newcastle vaccination", species="poultry")],
    )

    _split(db)

    schedule = db.get(TreatmentSchedule, id_)
    assert schedule.species == "birds"
    assert schedule.species != "hens"


def test_it_leaves_an_all_species_schedule_alone(client, db):
    id_ = ulid("sched_all")
    push(client, "device-a", [op_schedule(id_, ts(), species="all")])

    _split(db)

    assert db.get(TreatmentSchedule, id_).species == "all"


def test_it_moves_an_expense_tagged_to_the_poultry_species(client, db):
    """Missing these would leave the birds' feed bill allocated to a species no
    record has, and its whole cost would drop silently out of every estimated
    share (SPEC 4.4)."""
    category, expense = ulid("cat_feed"), ulid("exp_poultry")
    push(
        client,
        "device-a",
        [
            op_category(category, ts()),
            op_expense(
                expense, ts(), category_id=category, applies_to="species", applies_to_id="poultry"
            ),
        ],
    )

    _split(db)

    assert db.get(Expense, expense).applies_to_id == "hens"


def test_it_ignores_a_room_scoped_expense_whatever_its_id_says(client, db):
    """The scope decides what the column means, so it is what gets checked.
    Matching on the value alone would rewrite a room's id."""
    category, expense = ulid("cat_feed2"), ulid("exp_room")
    push(
        client,
        "device-a",
        [
            op_category(category, ts()),
            op_expense(
                expense, ts(), category_id=category, applies_to="room", applies_to_id="poultry"
            ),
        ],
    )

    _split(db)

    assert db.get(Expense, expense).applies_to_id == "poultry"


def test_it_is_safe_to_run_twice(client, db):
    """A second pass matches nothing, so no seq is burned and no row moves
    again. Alembic has already applied it once before these tests run."""
    id_ = ulid("rec_twice")
    push(client, "device-a", [op_record(id_, ts(), species="poultry", tag="P-5")])

    _split(db)
    after_first = db.get(Record, id_).seq
    _split(db)

    assert db.get(Record, id_).species == "hens"
    assert db.get(Record, id_).seq == after_first
