"""The sync engine. SPEC 5.

Three properties matter more than anything else here, and each is load-bearing:

1. **Nothing is rejected for being late.** A device that has been offline for a
   week is pushing writes the user already made and has moved on from. Refusing
   them loses real data (SPEC 5.4).
2. **Pushing twice is harmless.** Because IDs are minted on the client, the
   server recognises a replay and answers ``duplicate``. A push that lands but
   whose response is lost must be safely retryable (SPEC 5.3).
3. **Both sides converge.** State merges use a total order over
   ``(updated_at, device_id)``, so the order operations arrive in cannot change
   the answer.
"""

import logging
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.domain.merge import Stamp, merge_fields
from app.domain.reconcile import reconcile_records
from app.models import (
    Birth,
    Customer,
    Death,
    Expense,
    ExpenseCategory,
    HealthRecord,
    Move,
    ProduceType,
    Purchase,
    Record,
    Room,
    Sale,
    StockCount,
    StockIntake,
    StockOuttake,
    Store,
    TreatmentSchedule,
    Vet,
    VetVisit,
    VisitNote,
)
from app.schemas import EVENT_ENTITIES, Operation, OperationResult, PullChange

log = logging.getLogger("sync")

ENTITY_MODELS: dict[str, type] = {
    "room": Room,
    "record": Record,
    "move": Move,
    "sale": Sale,
    "death": Death,
    "purchase": Purchase,
    "health_record": HealthRecord,
    "expense_category": ExpenseCategory,
    "customer": Customer,
    "vet": Vet,
    "expense": Expense,
    "treatment_schedule": TreatmentSchedule,
    "vet_visit": VetVisit,
    "visit_note": VisitNote,
    # SPEC 22 — an event, like a move or a death.
    "birth": Birth,
    # SPEC 20.13 — stores and produce types are state entities; intakes,
    # outtakes and counts are events, append-only.
    "store": Store,
    "produce_type": ProduceType,
    "stock_intake": StockIntake,
    "stock_outtake": StockOuttake,
    "stock_count": StockCount,
}

# Columns a client may write, per entity. Anything else in `data` is ignored
# rather than erroring, so that an older client talking to a newer server, or
# vice versa, degrades quietly instead of stalling its outbox.
WRITABLE: dict[str, set[str]] = {
    "room": {"code", "name", "capacity", "is_isolation", "notes", "deleted_at"},
    "record": {
        "kind", "species", "tag", "breed", "sex", "date_of_birth", "arrival_date",
        "initial_head_count", "offspring_baseline", "offspring_baseline_updated_at",
        "source", "status", "parent_record_id", "notes", "deleted_at",
        # SPEC 22 — set once, on an offspring record created from a birth.
        "dam_record_id", "sire_record_id", "birth_id",
    },
    "move": {
        "record_id", "from_room_id", "to_room_id", "date", "count", "reason", "note",
    },
    "sale": {"record_id", "date", "price", "count", "customer_id", "notes"},
    "death": {"record_id", "date", "count", "cause", "vet_id", "notes"},
    "purchase": {"record_id", "date", "price", "seller", "count"},
    "health_record": {
        "record_id", "type", "product", "dose", "date", "next_due",
        "withdrawal_days", "vet_id", "cost", "notes", "schedule_id", "visit_id",
    },
    "expense_category": {"name", "is_archived", "deleted_at"},
    "customer": {"name", "phone", "location", "notes", "deleted_at"},
    "vet": {"name", "phone", "notes", "deleted_at"},
    "expense": {"amount", "category_id", "date", "applies_to", "applies_to_id", "note"},
    "treatment_schedule": {
        "name", "species", "type", "first_due_age_days", "repeat_every_days",
        "applies_to", "default_product", "default_withdrawal_days", "is_active",
        "notes", "deleted_at",
    },
    "vet_visit": {
        "date", "vet_id", "status", "call_out_fee", "reason", "notes", "deleted_at",
    },
    "visit_note": {"visit_id", "record_id", "note"},
    "birth": {
        "dam_record_id", "sire_record_id", "sire_name", "date", "born_count",
        "surviving_count", "vet_id", "notes",
    },
    "store": {"code", "name", "capacity_sacks", "notes", "deleted_at"},
    "produce_type": {"name", "is_active", "typical_sack_kg", "notes", "deleted_at"},
    "stock_intake": {
        "store_id", "produce_type_id", "date", "sacks", "kg", "source",
        "garden_name", "seller", "customer_id", "cost", "harvest_label", "notes",
    },
    "stock_outtake": {
        "store_id", "produce_type_id", "date", "sacks", "kg", "reason",
        "price_basis", "unit_price", "total_price", "customer_id", "to_store_id",
        "notes",
    },
    "stock_count": {
        "store_id", "produce_type_id", "date", "counted_sacks", "counted_kg", "notes",
    },
}

DATE_FIELDS = {
    "date", "date_of_birth", "arrival_date", "offspring_baseline_updated_at", "next_due",
}
DATETIME_FIELDS = {"deleted_at"}

# SPEC 22 — what a field used to be called.
#
# `offspring_count` was renamed to `offspring_baseline`, and a device that was
# offline when the rename shipped is still holding outbox entries that use the
# old name. Unknown keys are ignored rather than rejected (see WRITABLE), which
# is the right behaviour in general and would here mean silently dropping a
# number somebody typed. So the old spelling is accepted and mapped, once, on
# the way in.
LEGACY_FIELDS = {
    "offspring_count": "offspring_baseline",
    "offspring_updated_at": "offspring_baseline_updated_at",
}


def _rename_legacy(data: dict[str, Any]) -> dict[str, Any]:
    """Map retired field names onto their current ones, without overwriting a
    value the client also sent under the new name."""
    if not any(old in data for old in LEGACY_FIELDS):
        return data
    out = dict(data)
    for old, new in LEGACY_FIELDS.items():
        if old in out:
            value = out.pop(old)
            out.setdefault(new, value)
    return out


def now() -> datetime:
    return datetime.now(timezone.utc)


def _coerce(field: str, value: Any) -> Any:
    """Turn the JSON shapes a client sends into the Python types the columns want."""
    if value is None:
        return None
    if field in DATE_FIELDS and isinstance(value, str):
        return date.fromisoformat(value[:10])
    if field in DATETIME_FIELDS and isinstance(value, str):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value


def clamp_clock_skew(claimed: datetime, server_time: datetime, context: str) -> datetime:
    """SPEC 6.14 — a device with a wrong clock must not win conflicts it shouldn't.

    An ``updated_at`` more than a day in the future is treated as skew and
    replaced with server time. It is logged, because a device that keeps doing
    this is a device whose records need looking at.
    """
    limit = timedelta(hours=get_settings().max_clock_skew_hours)
    if claimed.tzinfo is None:
        claimed = claimed.replace(tzinfo=timezone.utc)
    if claimed > server_time + limit:
        log.warning(
            "clock_skew_substituted",
            extra={"context": context, "claimed": claimed.isoformat(), "used": server_time.isoformat()},
        )
        return server_time
    return claimed


def row_to_dict(entity: str, row: Any) -> dict[str, Any]:
    """Serialise a row for the wire. Dates go out as ISO strings."""
    out: dict[str, Any] = {}
    for column in row.__table__.columns:
        value = getattr(row, column.name)
        if isinstance(value, datetime):
            value = value.astimezone(timezone.utc).isoformat()
        elif isinstance(value, date):
            value = value.isoformat()
        elif isinstance(value, Decimal):
            # Produce weights are Numeric so they do not drift at rest (SPEC
            # 20.8). The client stores plain JS numbers, so they go out as
            # floats rather than as the strings a Decimal would otherwise
            # serialise to — a weight arriving as "620.000" would be compared
            # and summed as text on the device.
            value = float(value)
        out[column.name] = value
    out.pop("field_versions", None)
    return out


# --------------------------------------------------------------------------
# Push
# --------------------------------------------------------------------------


def apply_push(db: Session, device_id: str, operations: list[Operation]) -> list[OperationResult]:
    server_time = now()
    results: list[OperationResult] = []
    touched_records: set[str] = set()

    for op in operations:
        # Each operation gets its own savepoint, and is flushed inside it. Two
        # things fall out of that. Rows land in the order the client queued
        # them, so a move can reference a record created earlier in the same
        # batch. And one operation that violates a constraint rolls back alone
        # instead of taking the rest of the batch down with it — a single bad
        # row must never wedge an outbox behind it.
        savepoint = db.begin_nested()
        try:
            if op.entity in EVENT_ENTITIES:
                result = _apply_event(db, device_id, op, server_time, touched_records)
            else:
                result = _apply_state(db, device_id, op, server_time, touched_records)
            db.flush()
            savepoint.commit()
        except IntegrityError as exc:
            savepoint.rollback()
            log.warning(
                "sync_operation_rejected",
                extra={"entity": op.entity, "id": op.id, "error": str(exc.orig)},
            )
            result = OperationResult(
                id=op.id,
                entity=op.entity,
                status="rejected",
                message="Operation references a row that does not exist on the server.",
            )
        results.append(result)

    # Derived values are recomputed once at the end, after every event in the
    # batch has landed. Doing it per operation would make the answer depend on
    # the order they arrived in.
    reconcile_records(db, touched_records)
    return results


def _apply_event(
    db: Session, device_id: str, op: Operation, server_time: datetime, touched: set[str]
) -> OperationResult:
    """Event entities are append-only, so they cannot conflict — only repeat."""
    model = ENTITY_MODELS[op.entity]
    existing = db.get(model, op.id)
    if existing is not None:
        _touch_event(existing_record_id=getattr(existing, "record_id", None), touched=touched)
        return OperationResult(id=op.id, entity=op.entity, status="duplicate")

    fields = {
        k: _coerce(k, v)
        for k, v in _rename_legacy(op.data).items()
        if k in WRITABLE[op.entity]
    }

    missing = _missing_required(op.entity, fields)
    if missing:
        # A malformed operation will never succeed however often it is retried,
        # so say so plainly and let the client drop it rather than block behind it.
        return OperationResult(
            id=op.id, entity=op.entity, status="rejected",
            message=f"Missing required field(s): {', '.join(missing)}",
        )

    stamp = clamp_clock_skew(op.updated_at, server_time, f"{op.entity}:{op.id}")
    row = model(
        id=op.id,
        created_at=stamp,
        updated_at=stamp,
        device_id=device_id,
        deleted_at=None,
        **fields,
    )
    db.add(row)
    # Not every event names a record. An expense is allocated across the farm
    # rather than owned by one animal (SPEC 3.10), so it has no `record_id` at
    # all — reading one unconditionally turns pushing an expense into a KeyError
    # that the surrounding `except IntegrityError` does not catch, wedging the
    # whole batch.
    _touch_event(existing_record_id=fields.get("record_id"), touched=touched)
    return OperationResult(id=op.id, entity=op.entity, status="applied")


def _touch_event(existing_record_id: str | None, touched: set[str]) -> None:
    """Mark the record an event names, when it names one."""
    if existing_record_id is not None:
        touched.add(existing_record_id)


def _missing_required(entity: str, fields: dict[str, Any]) -> list[str]:
    required = {
        "move": ["record_id", "to_room_id", "date", "count", "reason"],
        "sale": ["record_id", "date", "price", "count"],
        "death": ["record_id", "date", "count", "cause"],
        "purchase": ["record_id", "date", "price", "count"],
        "health_record": ["record_id", "type", "date"],
        "visit_note": ["visit_id", "record_id", "note"],
        # SPEC 22. A birth with no dam is not a birth, and the two counts are
        # what the whole event is for — a row missing either would leave the
        # offspring it created unexplained.
        "birth": ["dam_record_id", "date", "born_count", "surviving_count"],
        "expense": ["amount", "category_id", "date", "applies_to"],
        # SPEC 20.8 — `kg` is required on every stock event and `sacks` never
        # is. Weight is what gets sold and what carries value; sacks are a
        # physical check, and a missing one means "not counted" rather than
        # zero.
        "stock_intake": ["store_id", "produce_type_id", "date", "kg", "source"],
        # SPEC 20.6 — a reason is always required. An unexplained outtake is a
        # hole in exactly the records this feature exists to keep.
        "stock_outtake": ["store_id", "produce_type_id", "date", "kg", "reason"],
        "stock_count": ["store_id", "produce_type_id", "date", "counted_kg"],
    }.get(entity, [])
    return [f for f in required if fields.get(f) is None]


def _apply_state(
    db: Session, device_id: str, op: Operation, server_time: datetime, touched: set[str]
) -> OperationResult:
    model = ENTITY_MODELS[op.entity]
    writable = WRITABLE[op.entity]
    incoming = {
        k: _coerce(k, v) for k, v in _rename_legacy(op.data).items() if k in writable
    }

    row_stamp = clamp_clock_skew(op.updated_at, server_time, f"{op.entity}:{op.id}")
    stamps: dict[str, Stamp] = {}
    for field in incoming:
        claimed = (op.field_updated_at or {}).get(field, op.updated_at)
        stamps[field] = Stamp(
            clamp_clock_skew(claimed, server_time, f"{op.entity}:{op.id}:{field}"), device_id
        )

    existing = db.get(model, op.id)

    if existing is None:
        row = model(
            id=op.id,
            created_at=row_stamp,
            updated_at=row_stamp,
            device_id=device_id,
            deleted_at=incoming.pop("deleted_at", None),
            field_versions={f: s.as_json() for f, s in stamps.items()},
            **incoming,
        )
        if op.entity == "record":
            # head_count is derived, but a brand-new record has nothing taken
            # out of it yet, so it starts level with what it was created holding.
            row.head_count = row.initial_head_count
        db.add(row)
        if op.entity == "record":
            _touch_record(row, touched)
        return OperationResult(id=op.id, entity=op.entity, status="applied")

    stored = {f: getattr(existing, f, None) for f in incoming}
    merged = merge_fields(incoming, stamps, stored, existing.field_versions or {})

    for field, value in merged.values.items():
        setattr(existing, field, value)
    existing.field_versions = merged.field_versions

    if merged.values:
        # updated_at tracks the newest stamp actually written to the row.
        existing.updated_at = max(existing.updated_at, row_stamp)
        existing.device_id = device_id
        existing.seq = _next_seq(db)

    if op.entity == "record":
        _touch_record(existing, touched)

    if merged.lost_fields:
        log.info(
            "sync_conflict",
            extra={"entity": op.entity, "id": op.id, "fields": merged.lost_fields},
        )
        return OperationResult(
            id=op.id,
            entity=op.entity,
            status="conflict",
            server=row_to_dict(op.entity, existing),
            message=(
                "The server held a newer value for: " + ", ".join(sorted(merged.lost_fields))
            ),
        )

    if not merged.values:
        # Every field carried a stamp the server had already seen: a replay.
        return OperationResult(id=op.id, entity=op.entity, status="duplicate")

    return OperationResult(id=op.id, entity=op.entity, status="applied")


def _touch_record(row: Record, touched: set[str]) -> None:
    """Mark a record for reconciliation, along with the group it was split from.

    A split reduces the parent by the child's head, so creating a child is a
    change to the parent's count as much as to the child's own (SPEC 4.3).
    """
    touched.add(row.id)
    if row.parent_record_id:
        touched.add(row.parent_record_id)


def _next_seq(db: Session) -> int:
    """Take the next database-wide sequence value.

    An update has to advance `seq` explicitly — the column default only fires on
    insert — or a client that has already pulled the row would never see the edit.
    """
    return db.execute(text("SELECT nextval('global_seq')")).scalar_one()


# --------------------------------------------------------------------------
# Pull
# --------------------------------------------------------------------------


def head_seq(db: Session) -> int:
    return db.execute(text("SELECT last_value FROM global_seq")).scalar_one()


def pull_changes(db: Session, since: int, limit: int) -> tuple[list[PullChange], int, bool]:
    """Everything with ``seq`` above the cursor, across every entity, in seq order.

    One cursor covers the whole database, so a client can resume from exactly
    where it stopped without tracking a position per table.
    """
    collected: list[tuple[int, str, Any]] = []
    for entity, model in ENTITY_MODELS.items():
        rows = db.scalars(
            select(model).where(model.seq > since).order_by(model.seq).limit(limit + 1)
        ).all()
        collected.extend((row.seq, entity, row) for row in rows)

    collected.sort(key=lambda item: item[0])
    has_more = len(collected) > limit
    page = collected[:limit]

    changes = [
        PullChange(entity=entity, id=row.id, seq=seq, data=row_to_dict(entity, row))
        for seq, entity, row in page
    ]
    cursor = page[-1][0] if page else since
    return changes, cursor, has_more
