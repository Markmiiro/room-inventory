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
    Numeric,
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

    # SPEC 22 — the hand-typed figure, renamed.
    #
    # It was `offspring_count`, and it was the only answer the app had. Now that
    # births are recorded it is the *baseline*: what happened before there were
    # birth records, typed by somebody who was there. The total shown on screen
    # is this plus the births counted, and this value is never written by the
    # app — a birth adds a Birth row and leaves what was typed alone.
    #
    # Renaming it rather than reusing the old name is the point. A field called
    # `offspring_count` that no longer holds the offspring count is how a screen
    # ends up displaying one of the two numbers and calling it the other.
    offspring_baseline: Mapped[int | None] = mapped_column(Integer)
    offspring_baseline_updated_at: Mapped[date | None] = mapped_column(Date)
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(8), nullable=False, default="active")
    parent_record_id: Mapped[str | None] = mapped_column(String(26), ForeignKey("records.id"))
    notes: Mapped[str | None] = mapped_column(Text)

    # Cache of the destination of the latest move. Recomputed, never trusted
    # as the source of truth (SPEC 3.4, 4.1).
    current_room_id: Mapped[str | None] = mapped_column(String(26), ForeignKey("rooms.id"))

    # SPEC 22 — where this animal came from, when it was born here.
    #
    # All three are null for everything bought, given, or already on the farm
    # before births were recorded, which is most of the herd and always will be
    # for the animals that predate this.
    dam_record_id: Mapped[str | None] = mapped_column(String(26), ForeignKey("records.id"))
    sire_record_id: Mapped[str | None] = mapped_column(String(26), ForeignKey("records.id"))
    # SPEC 22.9 — a father who is not a record here, named on the Add form for
    # an animal added as born here without a birth being logged.
    sire_name: Mapped[str | None] = mapped_column(Text)
    # Deliberately *not* a foreign key, unlike the two above.
    #
    # The dam and the sire exist long before the birth does. The birth row is
    # created in the same push batch as the offspring, one operation earlier,
    # and each operation in a batch lands in its own savepoint (see
    # `sync.apply_push`). A constraint here would turn any reordering — a
    # retried batch, a client that queued them apart — into a rejected
    # offspring record: the animal itself lost to keep a link tidy. The link is
    # worth having and it is not worth that.
    birth_id: Mapped[str | None] = mapped_column(String(26))


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


class TreatmentSchedule(StateMixin, Base):
    """SPEC 13.2 — a rule, not a date.

    "This species, at this age or on this interval, needs this treatment."
    A state entity: edited in place, archived rather than deleted (SPEC 4.8), so
    a schedule that has stopped applying keeps naming the treatments it produced.

    The eight starter rows are seeded by migration 0006 with fixed IDs that must
    match ``frontend/src/db/seed.ts``, for the same reason the ten rooms do: two
    devices seeding offline have to arrive at the same schedules, or the first
    sync produces two of each and every animal is told twice that it is due.
    """

    __tablename__ = "treatment_schedules"

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    # A species name, or the literal "all".
    species: Mapped[str] = mapped_column(String(16), nullable=False)
    type: Mapped[str] = mapped_column(String(16), nullable=False)
    # Days after birth or arrival for the first dose. Null means interval-only.
    first_due_age_days: Mapped[int | None] = mapped_column(Integer)
    # Days between doses. Null means the schedule fires once and stops.
    repeat_every_days: Mapped[int | None] = mapped_column(Integer)
    applies_to: Mapped[str] = mapped_column(String(8), nullable=False, default="both")
    default_product: Mapped[str | None] = mapped_column(Text)
    default_withdrawal_days: Mapped[int | None] = mapped_column(Integer)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    notes: Mapped[str | None] = mapped_column(Text)


class VetVisit(StateMixin, Base):
    """SPEC 14.2 — one visit from the vet.

    One date, one vet, several animals, some treated and some only looked at,
    and a single call-out fee for the lot. A treatment is one animal and one
    product, so none of that fits on a ``HealthRecord``.

    **A state entity, which departs from SPEC 16's sync note.** That note says
    visits are "events, append-only", but SPEC 14.2 gives a visit a ``status``
    that moves from ``planned`` to ``completed``, and describes the working
    pattern as "create the visit, add treatments as they happen, mark
    completed". The fee and the vet's advice are both written after the fact
    onto a row that already exists. An append-only visit could not record any of
    that: each correction would be a new visit, and one call-out would end up
    counted several times. So it carries ``field_versions`` and merges per field
    like a room — which is also what the farm needs, since one person marking a
    visit completed and another typing up the advice must not overwrite each
    other (SPEC 5.4).

    ``VisitNote`` genuinely is an event, and is modelled as one below.
    """

    __tablename__ = "vet_visits"

    # May be in the future, for a planned visit.
    date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    vet_id: Mapped[str | None] = mapped_column(String(26), ForeignKey("vets.id"))
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="completed")
    # Whole UGX. The fee for the journey, separate from any treatment cost.
    call_out_fee: Mapped[int | None] = mapped_column(BigInteger)
    reason: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)


class VisitNote(SyncMixin, Base):
    """SPEC 14.4 — the vet looked at this one and said watch it.

    An observation rather than a treatment, so that "seen but not treated" can
    be recorded without inventing a dose that never happened — which on a
    withdrawal period would be a dangerous thing to write down. It also counts
    the animal as seen for the call-out fee split (SPEC 14.3).

    An event: written once, about one animal, on one visit.
    """

    __tablename__ = "visit_notes"

    visit_id: Mapped[str] = mapped_column(
        String(26), ForeignKey("vet_visits.id"), nullable=False, index=True
    )
    record_id: Mapped[str] = mapped_column(
        String(26), ForeignKey("records.id"), nullable=False, index=True
    )
    note: Mapped[str] = mapped_column(Text, nullable=False)


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
    # SPEC 13.3 — the schedule this dose satisfies, when it was logged from a
    # due item. Null for an ad-hoc treatment, which deliberately does not shift
    # any schedule's next date.
    schedule_id: Mapped[str | None] = mapped_column(
        String(26), ForeignKey("treatment_schedules.id"), index=True
    )
    # SPEC 14.2 — the visit this dose was given during. Null when it was
    # self-administered, which is most days.
    visit_id: Mapped[str | None] = mapped_column(
        String(26), ForeignKey("vet_visits.id"), index=True
    )


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


class Birth(SyncMixin, Base):
    """SPEC 22 — an animal born on this farm.

    The gap this closes is a silent one. An animal born here had no date of
    birth, because nothing recorded the day it was born; and with no date of
    birth its treatment schedule never fires and its sale readiness never
    computes (SPEC 13.4, 15.3). The app went quiet about the animals it knew
    most about.

    An **event**, and append-only like every other: a birth happened on a day,
    and a mistake is corrected by adding rather than by editing. That is also
    what makes it safe for two devices to record the same morning's births
    offline — the merge is the union, and a duplicate is visible as two births
    rather than resolved into one wrong one.

    ``surviving_count`` is never more than ``born_count``. Where it is fewer,
    the client writes a Death for the difference with cause ``stillbirth`` in
    the same transaction, so a loss at birth is in the mortality figures rather
    than nowhere (SPEC 22).
    """

    __tablename__ = "births"

    dam_record_id: Mapped[str] = mapped_column(
        String(26), ForeignKey("records.id"), nullable=False, index=True
    )
    # A record on this farm, when the sire is one of ours.
    sire_record_id: Mapped[str | None] = mapped_column(String(26), ForeignKey("records.id"))
    # Free text, for a sire that is somebody else's animal. Both may be null:
    # plenty of births have no recorded father, and inventing one would be worse
    # than leaving it blank.
    sire_name: Mapped[str | None] = mapped_column(Text)
    date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    born_count: Mapped[int] = mapped_column(Integer, nullable=False)
    surviving_count: Mapped[int] = mapped_column(Integer, nullable=False)
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


# ---------------------------------------------------------------------------
# SPEC 20 — stores and produce
#
# A second inventory beside the livestock one. It shares the sync engine and the
# money figures and shares none of the data model: produce is kilograms and
# sacks, animals are head. **A Store is not a Room** (SPEC 20.2) — a room has a
# capacity in head, a derived species type and animals in it, and sacks in one
# would corrupt occupancy, room type and every alert that reads them.
#
# Weights are ``Numeric(12, 3)``, not floats. Kilograms are the only non-integer
# quantity in this database, and a balance is a sum of many of them (SPEC 20.8);
# binary floating point does not add decimals cleanly, and a stored weight that
# drifts is a stored weight nobody can reconcile against a scale. Three decimal
# places is a gram, well below what a farm scale resolves.
# ---------------------------------------------------------------------------


class Store(StateMixin, Base):
    """SPEC 20.3 — a place produce is kept.

    Seeded with two rows by migration 0010 at fixed IDs that must match
    ``frontend/src/db/seed.ts``, for the reason the ten rooms do — and with
    sharper consequences: two devices seeding offline would produce four stores,
    and a balance split across a pair of duplicates is wrong in both halves.
    """

    __tablename__ = "stores"

    code: Mapped[str] = mapped_column(String(8), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    # SPEC 20.3 — optional, and warns rather than blocks when exceeded. The
    # sacks are physically there whether the app approves or not.
    capacity_sacks: Mapped[int | None] = mapped_column(Integer)
    notes: Mapped[str | None] = mapped_column(Text)


class ProduceType(StateMixin, Base):
    """SPEC 20.4 — what is stored. A row, never an enum.

    The species enum was the other choice and undoing it cost a nine-file
    migration (SPEC 18). A farm that starts growing groundnuts should need a
    form, not a release.
    """

    __tablename__ = "produce_types"

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # SPEC 20.17 — what a sack of this usually weighs, set by the farm and
    # shipped empty. Used only to warn about a typo; nothing is ever computed
    # from it, because SPEC 20.8 forbids deriving sacks and kilograms from one
    # another.
    typical_sack_kg: Mapped[float | None] = mapped_column(Numeric(12, 3))
    notes: Mapped[str | None] = mapped_column(Text)


class StockIntake(SyncMixin, Base):
    """SPEC 20.5 — produce arriving in a store. An event: append-only."""

    __tablename__ = "stock_intakes"

    store_id: Mapped[str] = mapped_column(String(26), ForeignKey("stores.id"), nullable=False, index=True)
    produce_type_id: Mapped[str] = mapped_column(
        String(26), ForeignKey("produce_types.id"), nullable=False, index=True
    )
    date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    # Optional everywhere (SPEC 20.8). Null means "not counted", which is not
    # the same as zero, and is what makes a sack balance report as partial.
    sacks: Mapped[int | None] = mapped_column(Integer)
    kg: Mapped[float] = mapped_column(Numeric(12, 3), nullable=False)
    source: Mapped[str] = mapped_column(String(8), nullable=False)
    garden_name: Mapped[str | None] = mapped_column(String(120))
    seller: Mapped[str | None] = mapped_column(String(120))
    customer_id: Mapped[str | None] = mapped_column(String(26), ForeignKey("customers.id"))
    # UGX, whole shillings. Null for garden produce, which enters at zero cost
    # because growing it is already recorded as an Expense — counting it again
    # here would understate the farm's profit (SPEC 20.9).
    cost: Mapped[int | None] = mapped_column(Integer)
    # SPEC 20.16 Q2 — a label, not a lot. It records which harvest a delivery
    # came from without giving it a balance of its own, because nothing can say
    # which physical kilograms later left a pooled store.
    harvest_label: Mapped[str | None] = mapped_column(String(120))
    notes: Mapped[str | None] = mapped_column(Text)


class StockOuttake(SyncMixin, Base):
    """SPEC 20.6 — produce leaving a store. An event: append-only.

    A move between stores is one outtake with ``reason='moved'`` and a
    ``to_store_id``, mirrored as an intake in the destination. The client writes
    both in one transaction so a half-finished move cannot leave produce in
    neither store (SPEC 20.14.8); they arrive here as two ordinary events.
    """

    __tablename__ = "stock_outtakes"

    store_id: Mapped[str] = mapped_column(String(26), ForeignKey("stores.id"), nullable=False, index=True)
    produce_type_id: Mapped[str] = mapped_column(
        String(26), ForeignKey("produce_types.id"), nullable=False, index=True
    )
    date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    sacks: Mapped[int | None] = mapped_column(Integer)
    kg: Mapped[float] = mapped_column(Numeric(12, 3), nullable=False)
    # Always required. An unexplained outtake is a hole in exactly the records
    # this feature exists to keep (SPEC 20.6).
    reason: Mapped[str] = mapped_column(String(16), nullable=False)
    # What was negotiated: per kilogram or per sack. Sales may be struck either
    # way and neither quantity is derived from the other (SPEC 20.8).
    price_basis: Mapped[str | None] = mapped_column(String(8))
    unit_price: Mapped[int | None] = mapped_column(Integer)
    # UGX, and the stored truth. Every money figure reads this, so none of them
    # depends on how the deal was worded (SPEC 20.6).
    total_price: Mapped[int | None] = mapped_column(Integer)
    customer_id: Mapped[str | None] = mapped_column(String(26), ForeignKey("customers.id"))
    to_store_id: Mapped[str | None] = mapped_column(String(26), ForeignKey("stores.id"))
    notes: Mapped[str | None] = mapped_column(Text)


class StockCount(SyncMixin, Base):
    """SPEC 20.7 — a physical count. An event: append-only.

    Not decoration. Coffee loses weight as it dries and beans go to weevils, so
    without this the ledger drifts from the store and the only way to correct it
    would be to invent a fake outtake — polluting the very reasons that make the
    feature worth having.

    A count **resets** the running balance from its date onward rather than
    adjusting it, which is why it belongs to the balance rule rather than beside
    it (SPEC 20.8).
    """

    __tablename__ = "stock_counts"

    store_id: Mapped[str] = mapped_column(String(26), ForeignKey("stores.id"), nullable=False, index=True)
    produce_type_id: Mapped[str] = mapped_column(
        String(26), ForeignKey("produce_types.id"), nullable=False, index=True
    )
    date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    counted_sacks: Mapped[int | None] = mapped_column(Integer)
    counted_kg: Mapped[float] = mapped_column(Numeric(12, 3), nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
