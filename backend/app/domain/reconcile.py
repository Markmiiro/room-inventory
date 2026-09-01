"""Recompute the values SPEC section 4 calls derived.

Two caches are maintained here, and neither is ever trusted from a client push:

``current_room_id``
    The destination of the record's latest move (SPEC 4.1).

``head_count``
    ``initial_head_count`` less everything that has left: head sold, head died,
    and head split off into child records. This is the mechanism behind SPEC 6.7.
    If two devices are offline and each sells 5 head from a group of 8, both
    sales are real and both are kept; the count clamps at zero and an anomaly is
    recorded so the user is asked to check. Storing ``head_count`` as an ordinary
    last-write-wins field instead would let one device's sale silently overwrite
    the other's, which is the one outcome the spec rules out.
"""

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session
from ulid import ULID

from app.models import Death, Move, Record, Sale, SyncAnomaly


def _latest_move(db: Session, record_id: str) -> Move | None:
    # SPEC 4.1: most recent by date, then by created_at.
    return db.scalars(
        select(Move)
        .where(Move.record_id == record_id, Move.deleted_at.is_(None))
        .order_by(Move.date.desc(), Move.created_at.desc())
        .limit(1)
    ).first()


def reconcile_record(db: Session, record_id: str) -> None:
    """Bring one record's derived columns back in line with its events."""
    record = db.get(Record, record_id)
    if record is None:
        return

    move = _latest_move(db, record_id)
    record.current_room_id = move.to_room_id if move else None

    sold = _sum(db, select(Sale.count).where(Sale.record_id == record_id, Sale.deleted_at.is_(None)))
    died = _sum(db, select(Death.count).where(Death.record_id == record_id, Death.deleted_at.is_(None)))
    split_away = _sum(
        db,
        select(Record.initial_head_count).where(
            Record.parent_record_id == record_id, Record.deleted_at.is_(None)
        ),
    )

    raw = record.initial_head_count - sold - died - split_away
    record.head_count = max(raw, 0)

    if raw < 0:
        _flag_negative(db, record, raw)

    # SPEC 6.1: a group emptied out leaves the active lists, labelled by cause.
    # Only sales and deaths give it one — a group whose whole head was split off
    # into child records was neither sold nor did it die, so it keeps its status
    # and simply stops contributing to any room's occupancy.
    if record.head_count == 0 and record.status == "active" and (sold or died):
        record.status = "dead" if died > sold else "sold"


def _sum(db: Session, stmt) -> int:
    return sum(v or 0 for v in db.scalars(stmt).all())


def _flag_negative(db: Session, record: Record, raw: int) -> None:
    """Record the clamp once per record, so the alert is raised but not spammed."""
    existing = db.scalars(
        select(SyncAnomaly).where(
            SyncAnomaly.entity_id == record.id,
            SyncAnomaly.kind == "head_count_clamped",
            SyncAnomaly.resolved_at.is_(None),
        )
    ).first()

    detail = (
        f"Record {record.tag} was reduced below zero by offline changes — "
        f"please check. (Would have been {raw}.)"
    )
    if existing:
        existing.detail = detail
        return

    db.add(
        SyncAnomaly(
            id=str(ULID()),
            kind="head_count_clamped",
            entity="record",
            entity_id=record.id,
            detail=detail,
            created_at=datetime.now(timezone.utc),
        )
    )


def reconcile_records(db: Session, record_ids: set[str]) -> None:
    for record_id in sorted(record_ids):
        reconcile_record(db, record_id)
