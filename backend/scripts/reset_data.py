"""Wipe the recorded data and keep the seed. SPEC 6.10, 13.5, 20.3, 22.

Starting a farm's records again is not a `TRUNCATE` for three reasons, and each
of them breaks something silently if it is got wrong:

1. **The seeded rows must survive with their exact ids.** The ten rooms, the
   eight treatment schedules, the two stores and the three produce types exist
   in the migrations *and* in `frontend/src/db/seed.ts`, at fixed ids, so that a
   device seeding offline arrives at the same rows rather than a second set
   (SPEC 6.10). Delete them here and the next device to sync creates ten more
   rooms alongside them.

2. **`global_seq` must go up, never back.** A client pulls everything with
   `seq` greater than the cursor it holds. Restarting the sequence at 1 would
   hand out numbers below that cursor, so every row written after the reset
   would be invisible to that device — for ever, silently, with the indicator
   still reporting Synced. So this script never lowers the sequence. It
   *advances* it, and re-stamps the surviving seeded rows above the old head, so
   a device that was not wiped re-pulls them and converges instead of drifting.

3. **The table list must be complete.** It is derived from the SQLAlchemy
   metadata rather than typed out, so a table added later is included by
   existing, not by somebody remembering. `alembic_version` is excluded because
   it is not data; `users` is excluded because a password is a credential rather
   than a record, and wiping it would lock the farm out of its own API.

Nothing happens without ``--confirm``. With no flags this reports what it would
delete and exits.

**An export is written first, every time it deletes.** There is no import route
yet (SPEC 7 names one; it is not built), so that file is for reading and for
re-entering, not for a one-click restore. The device-side export in the app —
More → Backup — is the one that restores, and More → Restore is what restores
it.

Usage::

    # Report only. Deletes nothing.
    .venv/bin/python -m scripts.reset_data

    # Take the export and stop.
    .venv/bin/python -m scripts.reset_data --export-only

    # Actually do it.
    .venv/bin/python -m scripts.reset_data --confirm

    # On Railway, with a guard against pointing at the wrong database.
    railway run python -m scripts.reset_data --confirm --expect-database railway
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable

from sqlalchemy import func, select, text
from sqlalchemy.engine import Connection, make_url
from sqlalchemy.orm import Session

from app.models import Base

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = REPO_ROOT / "alembic" / "versions"

# Not data, and not ours to touch. `alembic_version` is the schema's own
# bookkeeping — clearing it would make the next deploy try to run every
# migration again. `users` holds the Argon2id hash: a credential, not a record,
# and wiping it locks the farm out of its own API with no way back in but an
# environment variable (SPEC 8).
NEVER_TOUCH = {"alembic_version", "users"}

# Cleared, and worth naming rather than lumping in with the animals. These are
# sessions, not records: every device signed in with `AUTH_ENABLED=true` will be
# asked for the password again, and local data is untouched by that (SPEC 8).
SESSION_TABLES = {"refresh_tokens"}

# Kept out of the export, because an export gets copied.
#
# It is written to be moved off the machine, mailed to somebody, left in a
# folder — so it must not carry the farm's Argon2id hash or a live refresh
# token. Neither is a record, and neither is worth restoring: `users` is not
# deleted by this script, and a session that has been cleared is meant to be
# gone.
NOT_EXPORTED = {"users", "refresh_tokens", "alembic_version"}


def _load_migration(name: str) -> Any:
    """Read the seed constants from the migration that wrote them.

    Imported rather than copied. The ids exist in two places already — the
    migration and the client's seed — and a third copy here would be the one
    nobody updates, which is exactly how a reset quietly deletes the seed.
    """
    path = MIGRATIONS / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:  # pragma: no cover - unreachable
        raise RuntimeError(f"Cannot read {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def seeded_ids() -> dict[str, set[str]]:
    """The exact ids the migrations seeded, per table.

    Derived from the same constants and the same numbering the migrations used,
    so a row added to any seed list is covered here without a second edit.
    """
    rooms = _load_migration("0002_seed_rooms")
    schedules = _load_migration("0006_treatment_schedules")
    stores = _load_migration("0010_stores_and_produce")

    def ids(prefix: str, count: int) -> set[str]:
        return {f"{prefix}{index:02d}" for index in range(1, count + 1)}

    return {
        "rooms": ids(rooms.ROOM_ID_PREFIX, len(rooms.ROOMS)),
        "treatment_schedules": ids(schedules.SCHEDULE_ID_PREFIX, len(schedules.SCHEDULES)),
        "stores": ids(stores.STORE_ID_PREFIX, len(stores.STORES)),
        "produce_types": ids(stores.PRODUCE_ID_PREFIX, len(stores.PRODUCE_TYPES)),
    }


def data_tables() -> list[str]:
    """Every table this script will empty, children before parents.

    `sorted_tables` is dependency order, so reversed is delete order: a table is
    emptied before anything it points at. That is what lets `records` go before
    `rooms` without a foreign key refusing.
    """
    return [
        table.name
        for table in reversed(Base.metadata.sorted_tables)
        if table.name not in NEVER_TOUCH
    ]


# --------------------------------------------------------------------------
# The export
# --------------------------------------------------------------------------


def _jsonable(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        # A string, not a float. This file is the only copy of what was deleted,
        # and produce weights are Numeric precisely so they do not drift
        # (SPEC 20.8) — rounding them on the way out would defeat that.
        return str(value)
    return value


def build_export(connection: Connection) -> dict[str, Any]:
    """Every row of every data table, credentials excluded.

    The seeded rows are exported too. They are cheap, and a file that contains
    everything can be read without first knowing which half it is missing. The
    password hash and any live refresh token are the exception — see
    `NOT_EXPORTED`.
    """
    revision = connection.execute(text("SELECT version_num FROM alembic_version")).scalar()

    tables: dict[str, list[dict[str, Any]]] = {}
    for table in Base.metadata.sorted_tables:
        if table.name in NOT_EXPORTED:
            continue
        rows = connection.execute(select(table)).mappings().all()
        tables[table.name] = [{k: _jsonable(v) for k, v in row.items()} for row in rows]

    return {
        "format": "room-inventory-server-export",
        # The Alembic revision, because a file is only restorable into a schema
        # it matches, and this is the only thing that says which one it came
        # from.
        "alembic_revision": revision,
        "taken_at": datetime.now(timezone.utc).isoformat(),
        "database": _describe_database(connection),
        # Named in the file rather than left to be noticed as an absence.
        "omitted": sorted(NOT_EXPORTED),
        "counts": {name: len(rows) for name, rows in tables.items()},
        "tables": tables,
    }


def default_export_path(now: datetime | None = None) -> Path:
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%SZ")
    return REPO_ROOT / "backups" / f"room-inventory-server-{stamp}.json"


def write_export(connection: Connection, path: Path) -> tuple[Path, int]:
    """Write the export, and fail loudly rather than deleting without one."""
    payload = build_export(connection)
    path.parent.mkdir(parents=True, exist_ok=True)
    text_out = json.dumps(payload, indent=1)
    path.write_text(text_out)
    return path, sum(payload["counts"].values())


def _describe_database(connection: Connection) -> str:
    """Host and database name, with any password left out of the report."""
    url = make_url(str(connection.engine.url))
    return f"{url.host or 'local socket'}/{url.database}"


# --------------------------------------------------------------------------
# The reset
# --------------------------------------------------------------------------


class ResetReport:
    def __init__(self) -> None:
        self.deleted: dict[str, int] = {}
        self.kept: dict[str, int] = {}
        self.export: Path | None = None
        # Where it would go, on a report that did not write one.
        self.export_target: Path | None = None
        self.exported_rows = 0
        self.seq_before = 0
        self.seq_after = 0
        self.restamped = 0
        self.dry_run = True

    @property
    def total_deleted(self) -> int:
        return sum(self.deleted.values())


def plan_counts(connection: Connection) -> tuple[dict[str, int], dict[str, int]]:
    """What would go and what would stay, per table."""
    keep = seeded_ids()
    deleted: dict[str, int] = {}
    kept: dict[str, int] = {}

    for name in data_tables():
        table = Base.metadata.tables[name]
        total = connection.execute(select(func.count()).select_from(table)).scalar_one()
        if name in keep:
            surviving = connection.execute(
                select(func.count()).select_from(table).where(table.c.id.in_(keep[name]))
            ).scalar_one()
            deleted[name] = total - surviving
            kept[name] = surviving
        else:
            deleted[name] = total
            kept[name] = 0
    return deleted, kept


def check_seed_is_intact(connection: Connection) -> list[str]:
    """Complain if the seeded rows are not where the migrations put them.

    A mismatch means the ids have drifted between the migration, the client seed
    and this script — in which case "keep the seeded rows" would delete them, so
    it is a refusal rather than a warning.
    """
    problems: list[str] = []
    for name, ids in seeded_ids().items():
        table = Base.metadata.tables[name]
        found = connection.execute(
            select(func.count()).select_from(table).where(table.c.id.in_(ids))
        ).scalar_one()
        if found != len(ids):
            problems.append(
                f"{name}: expected {len(ids)} seeded rows at their fixed ids, found {found}"
            )
    return problems


def head_seq(connection: Connection) -> int:
    return connection.execute(text("SELECT last_value FROM global_seq")).scalar_one()


def restamp_seq(connection: Connection) -> int:
    """Give every surviving row a fresh `seq`, above everything already handed out.

    This is the part that is easy to get wrong in the other direction. The
    sequence is never rewound: a device holds a cursor from before the reset, and
    a row numbered below that cursor is a row it will never ask for again. So the
    seeded rows are re-stamped from the top of the sequence, which makes them
    *newer* than that cursor — the device pulls them, writes them over the copies
    it already has (same ids, so it is an upsert, not a duplicate) and carries on.

    `updated_at` is deliberately left alone. It is what the per-field merge reads
    (SPEC 5.4), and the seeds are backdated on purpose so that any rename the
    farm has made still wins. Touching it here would make a reset quietly beat
    the user's own edits.
    """
    restamped = 0
    for name in seeded_ids():
        table = Base.metadata.tables[name]
        result = connection.execute(
            table.update().values(seq=text("nextval('global_seq')"))
        )
        restamped += result.rowcount or 0
    return restamped


def reset(
    session: Session,
    *,
    confirm: bool,
    export_path: Path | None,
    export_only: bool = False,
) -> ResetReport:
    """Report, export, or wipe — in that order of escalation."""
    report = ResetReport()
    connection = session.connection()

    problems = check_seed_is_intact(connection)
    if problems:
        raise SystemExit(
            "Refusing to run: the seeded rows are not at the ids this script would keep.\n  "
            + "\n  ".join(problems)
            + "\nRun the migrations first, or fix the drift — as written, this would "
            "delete the seed and the next device to sync would create it again."
        )

    report.deleted, report.kept = plan_counts(connection)
    report.seq_before = head_seq(connection)
    report.dry_run = not confirm
    report.export_target = export_path

    # A report writes nothing. Running it repeatedly to see what is there must
    # not leave a trail of files, and must not be the thing that makes somebody
    # stop reading the output.
    if export_path is not None and (confirm or export_only):
        report.export, report.exported_rows = write_export(connection, export_path)

    if not confirm:
        report.seq_after = report.seq_before
        return report

    keep = seeded_ids()
    for name in data_tables():
        table = Base.metadata.tables[name]
        if name in keep:
            connection.execute(table.delete().where(table.c.id.notin_(keep[name])))
        else:
            connection.execute(table.delete())

    report.restamped = restamp_seq(connection)
    report.seq_after = head_seq(connection)
    # The one invariant worth asserting out loud: the sequence only ever moves
    # forward, or a client's cursor silently outruns the server.
    assert report.seq_after >= report.seq_before, "global_seq went backwards"

    session.commit()
    report.dry_run = False
    return report


# --------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------


def format_report(report: ResetReport, *, database: str) -> str:
    lines: list[str] = []
    heading = (
        "Reset complete"
        if not report.dry_run
        else "Nothing was deleted — this is a report. Add --confirm to do it."
    )
    lines.append(heading)
    lines.append(f"  database   {database}")

    if report.export:
        lines.append(f"  export     {report.export} ({report.exported_rows} rows)")
    elif report.export_target:
        lines.append(f"  export     would be written to {report.export_target}")
    else:
        lines.append("  export     not written (--no-export)")

    verb = "deleted" if not report.dry_run else "would delete"
    width = max((len(name) for name in report.deleted), default=0)
    lines.append("")
    lines.append(f"  {'table'.ljust(width)}  {verb:>12}   kept")
    for name in sorted(report.deleted):
        count = report.deleted[name]
        kept = report.kept[name]
        note = ""
        if name in SESSION_TABLES:
            note = "   (sessions — devices will be asked to sign in again)"
        elif kept:
            note = "   (seeded rows, fixed ids)"
        lines.append(f"  {name.ljust(width)}  {count:>12}   {kept:>4}{note}")

    lines.append("")
    lines.append(f"  total {verb}: {report.total_deleted}")
    for name in sorted(NEVER_TOUCH):
        lines.append(f"  untouched: {name}")

    lines.append("")
    if report.dry_run:
        lines.append(f"  global_seq stands at {report.seq_before} and would be advanced, never rewound.")
    else:
        lines.append(
            f"  global_seq {report.seq_before} → {report.seq_after}; "
            f"{report.restamped} seeded rows re-stamped above the old head, so a device "
            "that was not wiped pulls them again instead of missing them."
        )
    return "\n".join(lines)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="reset_data",
        description="Wipe the recorded data, keep the seeded rows, advance global_seq.",
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Actually delete. Without this the script only reports.",
    )
    parser.add_argument(
        "--export-only",
        action="store_true",
        help="Write the export and stop, deleting nothing.",
    )
    parser.add_argument(
        "--export",
        type=Path,
        default=None,
        help="Where to write the export. Defaults to backend/backups/room-inventory-server-<time>.json",
    )
    parser.add_argument(
        "--no-export",
        action="store_true",
        help="Skip the export. Refused together with --confirm: a wipe always keeps a copy.",
    )
    parser.add_argument(
        "--expect-database",
        default=None,
        help="Refuse unless the target database has this name. Use it on a host where "
        "the URL comes from the environment and you cannot see what you are aimed at.",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.no_export and args.confirm:
        parser.error(
            "--no-export cannot be combined with --confirm. The export is the only copy "
            "of what is about to be deleted."
        )

    from app.db import SessionLocal

    session = SessionLocal()
    try:
        connection = session.connection()
        database = _describe_database(connection)
        url = make_url(str(connection.engine.url))

        if args.expect_database and url.database != args.expect_database:
            print(
                f"Refusing to run: expected database {args.expect_database!r}, "
                f"but DATABASE_URL points at {url.database!r} ({database}).",
                file=sys.stderr,
            )
            return 2

        export_path: Path | None
        if args.no_export:
            export_path = None
        else:
            export_path = args.export or default_export_path()

        report = reset(
            session,
            confirm=args.confirm and not args.export_only,
            export_path=export_path,
            export_only=args.export_only,
        )
        if args.export_only:
            print(f"Export written: {report.export} ({report.exported_rows} rows). Nothing deleted.")
            return 0

        print(format_report(report, database=database))
        return 0
    finally:
        session.close()


if __name__ == "__main__":  # pragma: no cover - entry point
    raise SystemExit(main())
