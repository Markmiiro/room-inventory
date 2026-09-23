"""The reset script. `scripts/reset_data.py`.

Three things can go wrong here and two of them are silent, which is why this
file exists at all:

* Delete the seeded rows and the next device to sync creates a second set of ten
  rooms (SPEC 6.10).
* Rewind `global_seq` and every row written after the reset sits below the
  cursor a device already holds, so that device never pulls again — with the
  indicator still reporting Synced.
* Miss a table and the "fresh start" keeps somebody's sale prices.

The third is the one a test can only partly cover, so the script derives its
table list from the SQLAlchemy metadata; the test below asserts that the list
really is every table bar the two exclusions.
"""

import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select, text

from app.models import Base, RefreshToken, User
from scripts.reset_data import (
    NEVER_TOUCH,
    data_tables,
    default_export_path,
    head_seq,
    main,
    reset,
    seeded_ids,
)
from tests.conftest import (
    op_birth,
    op_expense,
    op_category,
    op_intake,
    op_record,
    op_room,
    op_sale,
    push,
    ts,
    ulid,
)

SEED_TIME = "2026-01-01T00:00:00+00:00"


@pytest.fixture
def seeded(db):
    """Put the seeded rows back.

    The `db` fixture truncates `rooms` and `treatment_schedules`, which takes the
    migration's seed with them — so the rows the script is supposed to *keep* have
    to be re-inserted here, at the same fixed ids, or the test would be asserting
    about an empty table.
    """
    ids = seeded_ids()
    for id_ in sorted(ids["rooms"]):
        db.execute(
            text(
                "INSERT INTO rooms (id, created_at, updated_at, device_id, field_versions,"
                " code, name, capacity, is_isolation)"
                " VALUES (:id, :at, :at, 'seed', '{}'::jsonb, :code, :name, 20, false)"
            ),
            {"id": id_, "at": SEED_TIME, "code": id_[-2:], "name": f"Room {id_[-2:]}"},
        )
    for id_ in sorted(ids["treatment_schedules"]):
        db.execute(
            text(
                "INSERT INTO treatment_schedules (id, created_at, updated_at, device_id,"
                " field_versions, name, species, type, applies_to, is_active)"
                " VALUES (:id, :at, :at, 'seed', '{}'::jsonb, 'Deworming', 'cattle',"
                " 'deworming', 'both', true)"
            ),
            {"id": id_, "at": SEED_TIME},
        )
    db.commit()
    return ids


def make_data(client):
    """A farm with something in it: a room the user added, an animal, a sale, a
    birth, an expense and a produce intake."""
    room, record, dam = ulid("room9"), ulid("rec1"), ulid("dam1")
    push(
        client,
        "device-a",
        [
            op_room(room, ts(0), code="R99", name="A room somebody added"),
            op_record(record, ts(1)),
            op_sale(ulid("sale1"), ts(2), record, count=1),
            op_record(dam, ts(3), tag="C-200", sex="female"),
            op_birth(ulid("bir1"), ts(4), dam),
            op_category(ulid("cat1"), ts(5)),
            op_expense(ulid("exp1"), ts(6), ulid("cat1")),
            op_intake(ulid("int1"), ts(7)),
        ],
    )
    return {"room": room, "record": record, "dam": dam}


def count(db, name: str) -> int:
    table = Base.metadata.tables[name]
    return db.execute(select(func.count()).select_from(table)).scalar_one()


class TestTheTableList:
    def test_covers_every_table_bar_the_two_exclusions(self):
        """Derived, not typed. A table added later is included by existing."""
        assert set(data_tables()) == {t.name for t in Base.metadata.sorted_tables} - NEVER_TOUCH

    def test_never_touches_the_schema_version_or_the_password(self):
        # Clearing `alembic_version` makes the next deploy re-run every
        # migration; clearing `users` locks the farm out of its own API.
        assert NEVER_TOUCH == {"alembic_version", "users"}

    def test_deletes_children_before_parents(self):
        """`records` must go before `rooms`, or a foreign key refuses."""
        order = data_tables()
        assert order.index("moves") < order.index("records") < order.index("rooms")
        assert order.index("births") < order.index("records")


class TestWithoutConfirmation:
    def test_reports_and_deletes_nothing(self, db, client, seeded, tmp_path):
        make_data(client)
        before = count(db, "records")

        report = reset(db, confirm=False, export_path=tmp_path / "export.json")

        assert report.dry_run is True
        assert report.deleted["records"] == before
        assert count(db, "records") == before
        assert count(db, "sales") == 1

    def test_the_command_line_needs_the_flag(self, db, client, seeded, monkeypatch, tmp_path, capsys):
        make_data(client)
        monkeypatch.setattr("app.db.SessionLocal", lambda: db)

        assert main(["--export", str(tmp_path / "e.json")]) == 0

        out = capsys.readouterr().out
        assert "Nothing was deleted" in out
        assert "--confirm" in out
        assert count(db, "records") > 0

    def test_a_wipe_may_not_skip_the_export(self, db, monkeypatch):
        """The export is the only copy of what is about to go."""
        monkeypatch.setattr("app.db.SessionLocal", lambda: db)
        with pytest.raises(SystemExit) as exit_info:
            main(["--confirm", "--no-export"])
        assert exit_info.value.code == 2

    def test_refuses_a_database_it_was_not_aimed_at(self, db, monkeypatch, capsys):
        monkeypatch.setattr("app.db.SessionLocal", lambda: db)
        assert main(["--confirm", "--expect-database", "some-other-database"]) == 2
        assert "Refusing to run" in capsys.readouterr().err


class TestTheReset:
    def test_deletes_the_records_and_keeps_the_seed(self, db, client, seeded, tmp_path):
        make_data(client)

        report = reset(db, confirm=True, export_path=tmp_path / "export.json")

        assert count(db, "records") == 0
        assert count(db, "sales") == 0
        assert count(db, "births") == 0
        assert count(db, "expenses") == 0
        assert count(db, "stock_intakes") == 0
        assert report.dry_run is False

        # The ten rooms and eight schedules are still there, at their exact ids:
        # a device seeding offline has to arrive at these same rows (SPEC 6.10).
        surviving = {r for (r,) in db.execute(text("SELECT id FROM rooms"))}
        assert surviving == seeded["rooms"]
        assert {r for (r,) in db.execute(text("SELECT id FROM treatment_schedules"))} == seeded[
            "treatment_schedules"
        ]

    def test_deletes_a_room_the_user_added(self, db, client, seeded, tmp_path):
        ids = make_data(client)
        reset(db, confirm=True, export_path=tmp_path / "export.json")
        assert db.execute(
            text("SELECT count(*) FROM rooms WHERE id = :id"), {"id": ids["room"]}
        ).scalar_one() == 0

    def test_keeps_the_seeded_stores_and_produce_types(self, db, client, seeded, tmp_path):
        """Migration 0010's seed is not re-inserted by the fixture, so this is
        the migration's own rows surviving."""
        make_data(client)
        reset(db, confirm=True, export_path=tmp_path / "export.json")
        assert {r for (r,) in db.execute(text("SELECT id FROM stores"))} == seeded_ids()["stores"]
        assert {r for (r,) in db.execute(text("SELECT id FROM produce_types"))} == seeded_ids()[
            "produce_types"
        ]

    def test_clears_sessions_but_keeps_the_password(self, db, client, seeded, tmp_path):
        now = datetime.now(timezone.utc)
        db.add(User(id="00000000000000000000000001", password_hash="argon2-hash", updated_at=now))
        db.add(
            RefreshToken(
                id=ulid("tok1"),
                token_hash="hashed",
                issued_at=now,
                expires_at=now + timedelta(days=30),
            )
        )
        db.commit()

        reset(db, confirm=True, export_path=tmp_path / "export.json")

        # A password is a credential, not a record.
        assert count(db, "users") == 1
        # A session is not a record either, and dropping it only asks for the
        # password again (SPEC 8) — local data is untouched by that.
        assert count(db, "refresh_tokens") == 0

    def test_reports_what_it_deleted_by_table(self, db, client, seeded, tmp_path):
        make_data(client)
        report = reset(db, confirm=True, export_path=tmp_path / "export.json")

        assert report.deleted["records"] == 2
        assert report.deleted["sales"] == 1
        assert report.deleted["births"] == 1
        assert report.deleted["rooms"] == 1  # the one the user added
        assert report.kept["rooms"] == len(seeded["rooms"])
        assert report.total_deleted >= 7

    def test_refuses_when_the_seeded_ids_have_drifted(self, db, client, tmp_path):
        """Without the seed present, "keep the seeded rows" would keep nothing —
        so it stops rather than deleting them and letting a device re-create
        them as duplicates."""
        make_data(client)
        db.execute(text("DELETE FROM rooms WHERE id LIKE '0000000000000000000000R0%'"))

        with pytest.raises(SystemExit) as exit_info:
            reset(db, confirm=True, export_path=tmp_path / "export.json")
        assert "seeded rows" in str(exit_info.value)
        # And nothing was deleted on the way to refusing.
        assert count(db, "records") > 0


class TestTheSequence:
    def test_never_goes_backwards(self, db, client, seeded, tmp_path):
        make_data(client)
        before = head_seq(db.connection())

        report = reset(db, confirm=True, export_path=tmp_path / "export.json")

        assert report.seq_after >= before
        assert head_seq(db.connection()) >= before

    def test_restamps_the_surviving_rows_above_the_old_head(self, db, client, seeded, tmp_path):
        """A device that was not wiped holds a cursor at the old head. The seed
        has to land above it, or that device never sees the rooms again."""
        make_data(client)
        before = head_seq(db.connection())

        report = reset(db, confirm=True, export_path=tmp_path / "export.json")

        lowest_seed_seq = db.execute(text("SELECT min(seq) FROM rooms")).scalar_one()
        assert lowest_seed_seq > before
        assert report.restamped == sum(len(ids) for ids in seeded_ids().values())

    def test_a_row_written_after_the_reset_is_pullable_by_an_old_cursor(
        self, db, client, seeded, tmp_path
    ):
        """The failure this whole approach exists to avoid, asserted directly."""
        make_data(client)
        cursor_held_by_a_device = head_seq(db.connection())

        reset(db, confirm=True, export_path=tmp_path / "export.json")
        db.commit()

        push(client, "device-b", [op_record(ulid("new1"), ts(10), tag="C-500")])
        new_seq = db.execute(
            text("SELECT seq FROM records WHERE id = :id"), {"id": ulid("new1")}
        ).scalar_one()

        assert new_seq > cursor_held_by_a_device

    def test_leaves_the_seeds_updated_at_alone(self, db, client, seeded, tmp_path):
        """`seq` is the pull cursor; `updated_at` is the merge rule (SPEC 5.4).
        Touching the latter would make a reset beat the farm's own renaming."""
        make_data(client)
        reset(db, confirm=True, export_path=tmp_path / "export.json")

        stamps = {r for (r,) in db.execute(text("SELECT updated_at FROM rooms"))}
        assert all(str(stamp).startswith("2026-01-01") for stamp in stamps)


class TestTheExport:
    def test_is_written_before_anything_is_deleted(self, db, client, seeded, tmp_path):
        make_data(client)
        path = tmp_path / "export.json"

        report = reset(db, confirm=True, export_path=path)

        payload = json.loads(path.read_text())
        # The rows are gone from the database and present in the file.
        assert count(db, "records") == 0
        assert len(payload["tables"]["records"]) == 2
        assert len(payload["tables"]["sales"]) == 1
        assert payload["counts"]["births"] == 1
        assert report.exported_rows == sum(payload["counts"].values())

    def test_carries_no_credentials(self, db, client, seeded, tmp_path):
        """An export gets copied — mailed, left in a folder, moved off the
        machine. The Argon2id hash has no business travelling with it, and
        neither has a live refresh token."""
        make_data(client)
        reset(db, confirm=True, export_path=tmp_path / "export.json")
        payload = json.loads((tmp_path / "export.json").read_text())

        assert "users" not in payload["tables"]
        assert "refresh_tokens" not in payload["tables"]
        assert "password_hash" not in (tmp_path / "export.json").read_text()
        # Said in the file, rather than left to be noticed as an absence.
        assert payload["omitted"] == ["alembic_version", "refresh_tokens", "users"]

    def test_names_the_schema_it_came_from(self, db, client, seeded, tmp_path):
        make_data(client)
        reset(db, confirm=True, export_path=tmp_path / "export.json")
        payload = json.loads((tmp_path / "export.json").read_text())
        # A file is only restorable into a schema it matches.
        assert payload["alembic_revision"]
        assert payload["format"] == "room-inventory-server-export"

    def test_keeps_produce_weights_exact(self, db, client, seeded, tmp_path):
        """Numeric out as a string, not a float. SPEC 20.8 keeps these exact at
        rest; rounding them into the only surviving copy would undo that."""
        make_data(client)
        reset(db, confirm=True, export_path=tmp_path / "export.json")
        payload = json.loads((tmp_path / "export.json").read_text())
        assert isinstance(payload["tables"]["stock_intakes"][0]["kg"], str)

    def test_export_only_writes_and_stops(self, db, client, seeded, monkeypatch, tmp_path, capsys):
        make_data(client)
        monkeypatch.setattr("app.db.SessionLocal", lambda: db)
        path = tmp_path / "export.json"

        assert main(["--export-only", "--export", str(path)]) == 0

        assert path.exists()
        assert "Nothing deleted" in capsys.readouterr().out
        assert count(db, "records") > 0

    def test_the_default_path_lands_in_backups(self):
        path = default_export_path()
        assert path.parent.name == "backups"
        assert path.name.startswith("room-inventory-server-")
        assert path.suffix == ".json"
