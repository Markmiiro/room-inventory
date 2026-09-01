"""SQLAlchemy models.

Two shapes of entity, per SPEC 3.2:

* **Event** entities are append-only. They carry no ``field_versions`` because
  they are never updated, and therefore never conflict — merging two devices is
  the union of their rows.
* **State** entities are mutable and carry ``field_versions``: a per-field
  ``{updated_at, device_id}`` stamp so that last-write-wins can be resolved one
  field at a time rather than clobbering a whole row (SPEC 5.4).

``seq`` is drawn from a single database-wide sequence on every write, so a client
can pull every change across every table with one monotonic cursor.
"""

from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Sequence,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


# One sequence for the whole database. Every insert and every update takes the
# next value, which is what makes `GET /sync/pull?since=` a single ordered scan.
global_seq = Sequence("global_seq", metadata=Base.metadata)


class SyncMixin:
    """The fields SPEC 3.1 puts on every entity."""

    id: Mapped[str] = mapped_column(String(26), primary_key=True)  # ULID, client-generated
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    device_id: Mapped[str] = mapped_column(String(64), nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    seq: Mapped[int] = mapped_column(
        BigInteger, global_seq, server_default=global_seq.next_value(), index=True, nullable=False
    )


class StateMixin(SyncMixin):
    """State entities additionally track when each individual field was written."""

    field_versions: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)


# --------------------------------------------------------------------------
# State entities
# --------------------------------------------------------------------------


class Room(StateMixin, Base):
    __tablename__ = "rooms"

    code: Mapped[str] = mapped_column(String(8), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    capacity: Mapped[int] = mapped_column(Integer, nullable=False)
    is_isolation: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    notes: Mapped[str | None] = mapped_column(Text)

    # Unique among rows that are not soft-deleted; enforced as a partial index in
    # the migration, since `deleted_at IS NULL` cannot be expressed here.
    __table_args__ = (UniqueConstraint("code", "deleted_at", name="uq_rooms_code_alive"),)


class Record(StateMixin, Base):
    """An animal or a group. SPEC 3.4."""

    __tablename__ = "records"

    kind: Mapped[str] = mapped_column(String(8), nullable=False)  # animal | group
    species: Mapped[str] = mapped_column(String(16), nullable=False)
    tag: Mapped[str] = mapped_column(String(80), nullable=False)
    breed: Mapped[str | None] = mapped_column(String(120))
    sex: Mapped[str | None] = mapped_column(String(8))
    date_of_birth: Mapped[date | None] = mapped_column(Date)
    arrival_date: Mapped[date | None] = mapped_column(Date)

    # `initial_head_count` is what the record was created holding, and is
    # immutable. `head_count` is a cache: it is always recomputed from the
    # events that took animals out (sales, deaths, splits). Trusting the pushed
    # value instead would lose data when two offline devices each sell from the
    # same group — see SPEC 6.7 and domain/reconcile.py.
    initial_head_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    head_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    offspring_count: Mapped[int | None] = mapped_column(Integer)
    offspring_updated_at: Mapped[date | None] = mapped_column(Date)
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(8), nullable=False, default="active")
    parent_record_id: Mapped[str | None] = mapped_column(String(26), ForeignKey("records.id"))
    notes: Mapped[str | None] = mapped_column(Text)

    # Cache of the destination of the latest move. Recomputed, never trusted
    # as the source of truth (SPEC 3.4, 4.1).
    current_room_id: Mapped[str | None] = mapped_column(String(26), ForeignKey("rooms.id"))


# --------------------------------------------------------------------------
# Event entities — append-only, so they never conflict (SPEC 5.4)
# --------------------------------------------------------------------------


class ExpenseCategory(StateMixin, Base):
    """SPEC 3.11 — created by the user, never fixed by the app.

    The app ships with none. A category in use is archived rather than deleted
    (SPEC 4.8), so existing expenses keep their category name while it stops
    being offered as a choice.
    """

    __tablename__ = "expense_categories"

    name: Mapped[str] = mapped_column(String(80), nullable=False)
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class Customer(StateMixin, Base):
    """SPEC 3.11 — who an animal was sold to."""

    __tablename__ = "customers"

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(40))
    location: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)


class Vet(StateMixin, Base):
    """SPEC 3.11 — who treated an animal."""

    __tablename__ = "vets"

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(40))
    notes: Mapped[str | None] = mapped_column(Text)


class Expense(SyncMixin, Base):
    """SPEC 3.10 — money spent on the farm rather than on one animal.

    An event: what was spent, on what day. It carries no per-record link at all,
    because expenses are allocated rather than owned — see SPEC 4.4 and
    ``frontend/src/domain/allocation.ts``.
    """

    __tablename__ = "expenses"

    amount: Mapped[int] = mapped_column(BigInteger, nullable=False)  # whole UGX
    category_id: Mapped[str] = mapped_column(String(26), ForeignKey("expense_categories.id"))
    date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    applies_to: Mapped[str] = mapped_column(String(8), nullable=False)
    # A species name or a room id; null when the expense is farm-wide.
    applies_to_id: Mapped[str | None] = mapped_column(String(26))
    note: Mapped[str | None] = mapped_column(Text)


class Move(SyncMixin, Base):
    __tablename__ = "moves"

    record_id: Mapped[str] = mapped_column(String(26), ForeignKey("records.id"), index=True)
    from_room_id: Mapped[str | None] = mapped_column(String(26), ForeignKey("rooms.id"))
    to_room_id: Mapped[str] = mapped_column(String(26), ForeignKey("rooms.id"), nullable=False)
    date: Mapped[date] = mapped_column(Date, nullable=False)
    count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    reason: Mapped[str] = mapped_column(String(16), nullable=False)
    note: Mapped[str | None] = mapped_column(Text)


class Sale(SyncMixin, Base):
    __tablename__ = "sales"

    record_id: Mapped[str] = mapped_column(String(26), ForeignKey("records.id"), index=True)
    date: Mapped[date] = mapped_column(Date, nullable=False)
    price: Mapped[int] = mapped_column(BigInteger, nullable=False)  # whole UGX, never a float
    count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    customer_id: Mapped[str | None] = mapped_column(String(26))
    notes: Mapped[str | None] = mapped_column(Text)


class HealthRecord(SyncMixin, Base):
    """SPEC 3.6 — one treatment, vaccination or dose given to one record.

    ``next_due`` is what drives both the alerts and the calendar, and
    ``withdrawal_days`` is what stops an animal being sold inside its withdrawal
    period without the owner saying so explicitly (SPEC 6.6). Both are optional:
    plenty of treatments repeat on no schedule and carry no withdrawal.
    """

    __tablename__ = "health_records"

    record_id: Mapped[str] = mapped_column(String(26), ForeignKey("records.id"), index=True)
    type: Mapped[str] = mapped_column(String(16), nullable=False)
    product: Mapped[str | None] = mapped_column(Text)
    dose: Mapped[str | None] = mapped_column(Text)
    date: Mapped[date] = mapped_column(Date, nullable=False)
    next_due: Mapped[date | None] = mapped_column(Date, index=True)
    withdrawal_days: Mapped[int | None] = mapped_column(Integer)
    vet_id: Mapped[str | None] = mapped_column(String(26))
    cost: Mapped[int | None] = mapped_column(BigInteger)  # whole UGX
    notes: Mapped[str | None] = mapped_column(Text)


class Purchase(SyncMixin, Base):
    """SPEC 3.7 — what a record cost to acquire.

    Written by the client whenever a record is added with ``source = bought``,
    so it shares that record's id-minting and replay safety. It is an event: a
    purchase is a thing that happened on a date, and correcting one is a new
    row, never an edit to the old one.
    """

    __tablename__ = "purchases"

    record_id: Mapped[str] = mapped_column(String(26), ForeignKey("records.id"), index=True)
    date: Mapped[date] = mapped_column(Date, nullable=False)
    price: Mapped[int] = mapped_column(BigInteger, nullable=False)  # whole UGX, never a float
    seller: Mapped[str | None] = mapped_column(Text)
    count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)


class Death(SyncMixin, Base):
    __tablename__ = "deaths"

    record_id: Mapped[str] = mapped_column(String(26), ForeignKey("records.id"), index=True)
    date: Mapped[date] = mapped_column(Date, nullable=False)
    count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    cause: Mapped[str] = mapped_column(String(16), nullable=False)
    vet_id: Mapped[str | None] = mapped_column(String(26))
    notes: Mapped[str | None] = mapped_column(Text)


# --------------------------------------------------------------------------
# Server-side bookkeeping. Not synced to clients as entities.
# --------------------------------------------------------------------------


class RefreshToken(Base):
    """Stored server-side so a refresh token can be revoked (SPEC 8)."""

    __tablename__ = "refresh_tokens"

    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class User(Base):
    """One user. The row exists so the password hash can be rotated."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class SyncAnomaly(Base):
    """Something the merge had to paper over, kept so the user can be alerted.

    SPEC 5.4 and 6.7: never discard a write. When two offline devices between
    them take more head out of a group than it held, both events are kept, the
    count clamps at zero, and a row lands here naming the record.
    """

    __tablename__ = "sync_anomalies"

    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    entity: Mapped[str] = mapped_column(String(32), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(26), nullable=False, index=True)
    detail: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
