"""SPEC 13 — treatment schedules over the wire.

The domain rules that turn a schedule into a date live on the client and are
tested there (`frontend/src/domain/schedules.test.ts`). What is tested here is
the half only the server can get wrong: that a schedule merges per field like
the other state entities, that a treatment carries the schedule it satisfied,
and that the seeded rows a migration wrote and the rows a device seeded offline
are the same rows rather than two sets of them.
"""

import importlib.util
import pathlib
import re

from sqlalchemy import select

from app.models import HealthRecord, TreatmentSchedule
from tests.conftest import (
    op_category,
    op_expense,
    op_health,
    op_record,
    op_schedule,
    push,
    statuses,
    ts,
    ulid,
)

REC = ulid("rec_s1")
SCHED = ulid("sch_1")


def test_the_migration_and_the_client_seed_agree_on_ids_and_values():
    """SPEC 13.5 and 5.4 — the requirement that makes offline seeding safe.

    Two devices that each seed with no signal must arrive at the *same* eight
    schedules. That holds only while the IDs in `0006_treatment_schedules.py`
    and in `frontend/src/db/seed.ts` are identical and in the same order, since
    the position in the list is what mints the ID. Nothing at runtime would
    catch a drift here: the two seeds would simply sync into sixteen schedules,
    and every animal would be told twice that it is due.

    So the two files are compared directly, which is the only place that
    agreement is actually checked.
    """
    prefix, schedules = _migration_seed()
    client_prefix, client_schedules = _client_seed()

    assert prefix == client_prefix
    assert len(schedules) == 8
    assert schedules == client_schedules


def test_a_second_device_seeding_the_same_schedule_does_not_create_a_copy(client, db):
    """SPEC 5.3 — because the IDs are fixed, the second seed is a duplicate.

    Without the fixed IDs each device would mint its own, and this would land as
    two schedules rather than one.
    """
    prefix, schedules = _migration_seed()
    name, species, kind = schedules[0][:3]
    seeded_id = f"{prefix}01"

    push(client, "device-a", [op_schedule(seeded_id, ts(), name=name, species=species, type=kind)])
    push(client, "device-b", [op_schedule(seeded_id, ts(10), name=name, species=species, type=kind)])
    db.expire_all()

    rows = db.scalars(select(TreatmentSchedule)).all()
    assert len(rows) == 1
    assert rows[0].name == name


def _migration_seed() -> tuple[str, list[tuple]]:
    """The constants migration 0006 seeds with."""
    spec = importlib.util.spec_from_file_location(
        "seed_migration",
        pathlib.Path(__file__).resolve().parents[1]
        / "alembic"
        / "versions"
        / "0006_treatment_schedules.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.SCHEDULE_ID_PREFIX, [tuple(row) for row in module.SCHEDULES]


def _client_seed() -> tuple[str, list[tuple]]:
    """The same constants as the TypeScript client seed states them.

    Read out of the source rather than duplicated here, so this test fails when
    the two files drift instead of when someone forgets to update a third copy.
    """
    source = (
        pathlib.Path(__file__).resolve().parents[2]
        / "frontend"
        / "src"
        / "db"
        / "seed.ts"
    ).read_text()

    prefix = re.search(r'SCHEDULE_ID_PREFIX = "([^"]+)"', source).group(1)

    block = re.search(
        r"const SEED_SCHEDULES: SeedSchedule\[\] = \[(.*?)\n\];", source, re.S
    ).group(1)

    rows = []
    for entry in re.finditer(
        r'\{\s*name:\s*"([^"]+)",\s*species:\s*"([^"]+)",\s*type:\s*"([^"]+)",'
        r"\s*first_due_age_days:\s*(\d+|null),\s*repeat_every_days:\s*(\d+|null)",
        block,
    ):
        name, species, kind, first, repeat = entry.groups()
        rows.append(
            (
                name,
                species,
                kind,
                None if first == "null" else int(first),
                None if repeat == "null" else int(repeat),
            )
        )
    return prefix, rows


def test_a_schedule_merges_per_field_like_the_other_state_entities(client, db):
    """SPEC 5.4 — two devices editing different fields both keep their edit."""
    push(client, "device-a", [op_schedule(SCHED, ts(), name="Deworming")])

    # One device changes the interval; another, later, changes the product.
    push(
        client,
        "device-a",
        [
            {
                "op": "upsert",
                "entity": "treatment_schedule",
                "id": SCHED,
                "data": {"repeat_every_days": 120},
                "updated_at": ts(10),
                "field_updated_at": {"repeat_every_days": ts(10)},
            }
        ],
    )
    push(
        client,
        "device-b",
        [
            {
                "op": "upsert",
                "entity": "treatment_schedule",
                "id": SCHED,
                "data": {"default_product": "Albendazole"},
                "updated_at": ts(20),
                "field_updated_at": {"default_product": ts(20)},
            }
        ],
    )
    db.expire_all()

    row = db.get(TreatmentSchedule, SCHED)
    assert row.repeat_every_days == 120, "the interval edit survived"
    assert row.default_product == "Albendazole", "the product edit survived"


def test_archiving_a_schedule_is_an_edit_rather_than_a_delete(client, db):
    """SPEC 13.5 — archived, never deleted, so past treatments keep naming it."""
    push(client, "device-a", [op_schedule(SCHED, ts())])
    push(client, "device-a", [op_schedule(SCHED, ts(10), is_active=False)])
    db.expire_all()

    row = db.get(TreatmentSchedule, SCHED)
    assert row is not None, "the row is still there"
    assert row.is_active is False
    assert row.deleted_at is None


def test_a_treatment_carries_the_schedule_it_satisfied(client, db):
    """SPEC 13.3 — `schedule_id` is what anchors the next interval."""
    push(client, "device-a", [op_record(REC, ts())])
    push(client, "device-a", [op_schedule(SCHED, ts())])
    push(
        client,
        "device-a",
        [op_health(ulid("hr_sched"), ts(), REC, type_="deworming", schedule_id=SCHED)],
    )
    db.expire_all()

    row = db.get(HealthRecord, ulid("hr_sched"))
    assert row.schedule_id == SCHED


def test_an_ad_hoc_treatment_carries_no_schedule(client, db):
    """SPEC 13.3 — a sick animal treated out of turn disturbs no schedule."""
    push(client, "device-a", [op_record(REC, ts())])
    push(client, "device-a", [op_health(ulid("hr_adhoc"), ts(), REC, type_="treatment")])
    db.expire_all()

    assert db.get(HealthRecord, ulid("hr_adhoc")).schedule_id is None


def test_a_schedule_appears_in_a_pull_like_any_other_entity(client):
    push(client, "device-a", [op_schedule(SCHED, ts(), name="PPR vaccination")])

    body = client.get("/sync/pull?since=0&limit=500").json()
    names = [
        c["data"]["name"] for c in body["changes"] if c["entity"] == "treatment_schedule"
    ]
    assert "PPR vaccination" in names

    # SPEC 5.4 — the per-field stamps are the server's bookkeeping and never go
    # out on the wire.
    for change in body["changes"]:
        assert "field_versions" not in change["data"]


def test_pushing_an_expense_does_not_wedge_the_batch(client, db):
    """An event with no `record_id` at all.

    Not a schedules test, but the same code path: the push handler marks the
    record an event names for reconciliation, and an expense names none
    (SPEC 3.10). Reading `record_id` unconditionally raised a KeyError that the
    surrounding IntegrityError handler did not catch, taking the whole batch
    down with it — including every operation queued behind it.
    """
    category = ulid("cat_feed")
    push(client, "device-a", [op_category(category, ts())])

    body = push(
        client,
        "device-a",
        [
            op_expense(ulid("exp_1"), ts(), category),
            op_record(REC, ts(10)),
        ],
    )

    assert statuses(body) == ["applied", "applied"], "neither operation was lost"
