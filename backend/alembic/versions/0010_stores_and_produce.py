"""Stores and produce — the second inventory.

SPEC 20. The farm keeps harvested and bought produce in two stores, and needs to
answer how much is in each, what has left and why, what was sold and for how
much, and what came in and from where.

**A Store is not a Room, and this deliberately does not reuse one.** A room has
a capacity in head, a species type derived from what is inside it, and animals
in it; putting sacks in one would corrupt occupancy, room type derivation and
every alert that reads them (SPEC 20.2).

Five tables, split the way SPEC 3.2 splits everything else:

* ``stores`` and ``produce_types`` are **state** entities and carry
  ``field_versions``, so two devices editing different fields of the same store
  both keep their edit (SPEC 5.4).
* ``stock_intakes``, ``stock_outtakes`` and ``stock_counts`` are **events** and
  do not. The balance is derived by folding them (SPEC 20.8), so an editable
  event would silently restate a balance instead of correcting it. A mistake is
  corrected by adding a stock count, which is exactly what one is for.

Produce types are **rows, not an enum**. The species enum was the other choice
and undoing it cost a nine-file migration (SPEC 18); a farm that starts growing
groundnuts should need a form, not a release.

Weights are ``Numeric(12, 3)`` rather than double precision. Kilograms are the
only non-integer quantity in this database and a balance is a sum of many of
them; binary floating point does not add decimals cleanly, and a stored weight
that drifts is one nobody can reconcile against a scale. Three places is a gram,
well below what a farm scale resolves.

The two stores and three produce types are seeded here at fixed IDs that must
stay identical to ``frontend/src/db/seed.ts``. Same requirement as the ten rooms
in 0002, with a sharper consequence: two devices seeding offline would produce
four stores, and a balance split across a pair of duplicates is wrong in both
halves.

Revision ID: 0010
Revises: 0009
"""

from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

SEQ_DEFAULT = sa.text("nextval('global_seq')")

# Must stay identical to STORE_ID_PREFIX and PRODUCE_ID_PREFIX in
# frontend/src/db/seed.ts, and the order below is what mints each ID.
STORE_ID_PREFIX = "0000000000000000000000T0"
PRODUCE_ID_PREFIX = "0000000000000000000000P0"

STORES = [("S1", "Upper store"), ("S2", "Lower store")]

# Alphabetical, which is also the order they are displayed in.
PRODUCE_TYPES = ["Beans", "Coffee", "Maize"]


def _sync_columns() -> list[sa.Column]:
    """The SPEC 3.1 fields every entity carries."""
    return [
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("device_id", sa.String(64), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("seq", sa.BigInteger, server_default=SEQ_DEFAULT, nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "stores",
        *_sync_columns(),
        sa.Column("field_versions", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("code", sa.String(8), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        # SPEC 20.3 — optional, and warns rather than blocks when exceeded.
        sa.Column("capacity_sacks", sa.Integer),
        sa.Column("notes", sa.Text),
    )
    op.create_index("ix_stores_seq", "stores", ["seq"])

    op.create_table(
        "produce_types",
        *_sync_columns(),
        sa.Column("field_versions", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("notes", sa.Text),
    )
    op.create_index("ix_produce_types_seq", "produce_types", ["seq"])

    op.create_table(
        "stock_intakes",
        *_sync_columns(),
        sa.Column("store_id", sa.String(26), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column(
            "produce_type_id", sa.String(26), sa.ForeignKey("produce_types.id"), nullable=False
        ),
        sa.Column("date", sa.Date, nullable=False),
        # SPEC 20.8 — optional. Null means "not counted", which is not zero, and
        # is what makes a sack balance report as partial rather than complete.
        sa.Column("sacks", sa.Integer),
        sa.Column("kg", sa.Numeric(12, 3), nullable=False),
        sa.Column("source", sa.String(8), nullable=False),
        sa.Column("garden_name", sa.String(120)),
        sa.Column("seller", sa.String(120)),
        sa.Column("customer_id", sa.String(26), sa.ForeignKey("customers.id")),
        # Null for garden produce, which enters at zero cost because growing it
        # is already recorded as an Expense (SPEC 20.9).
        sa.Column("cost", sa.Integer),
        # SPEC 20.16 Q2 — a label, not a lot.
        sa.Column("harvest_label", sa.String(120)),
        sa.Column("notes", sa.Text),
    )
    op.create_index("ix_stock_intakes_seq", "stock_intakes", ["seq"])
    op.create_index("ix_stock_intakes_date", "stock_intakes", ["date"])
    # Every balance is "every event for this store and this produce type"
    # (SPEC 20.8), so that pair is the index, not two separate ones. Without it
    # the Stores screen scans a harvest's worth of rows on every render
    # (SPEC 6.13).
    op.create_index("ix_stock_intakes_pair", "stock_intakes", ["store_id", "produce_type_id"])

    op.create_table(
        "stock_outtakes",
        *_sync_columns(),
        sa.Column("store_id", sa.String(26), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column(
            "produce_type_id", sa.String(26), sa.ForeignKey("produce_types.id"), nullable=False
        ),
        sa.Column("date", sa.Date, nullable=False),
        sa.Column("sacks", sa.Integer),
        sa.Column("kg", sa.Numeric(12, 3), nullable=False),
        # SPEC 20.6 — always required. An unexplained outtake is a hole in
        # exactly the records this feature exists to keep.
        sa.Column("reason", sa.String(16), nullable=False),
        sa.Column("price_basis", sa.String(8)),
        sa.Column("unit_price", sa.Integer),
        # The stored truth. Every money figure reads this, so none of them
        # depends on whether the deal was struck per kilogram or per sack.
        sa.Column("total_price", sa.Integer),
        sa.Column("customer_id", sa.String(26), sa.ForeignKey("customers.id")),
        sa.Column("to_store_id", sa.String(26), sa.ForeignKey("stores.id")),
        sa.Column("notes", sa.Text),
    )
    op.create_index("ix_stock_outtakes_seq", "stock_outtakes", ["seq"])
    op.create_index("ix_stock_outtakes_date", "stock_outtakes", ["date"])
    op.create_index("ix_stock_outtakes_pair", "stock_outtakes", ["store_id", "produce_type_id"])

    op.create_table(
        "stock_counts",
        *_sync_columns(),
        sa.Column("store_id", sa.String(26), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column(
            "produce_type_id", sa.String(26), sa.ForeignKey("produce_types.id"), nullable=False
        ),
        sa.Column("date", sa.Date, nullable=False),
        sa.Column("counted_sacks", sa.Integer),
        sa.Column("counted_kg", sa.Numeric(12, 3), nullable=False),
        sa.Column("notes", sa.Text),
    )
    op.create_index("ix_stock_counts_seq", "stock_counts", ["seq"])
    op.create_index("ix_stock_counts_date", "stock_counts", ["date"])
    op.create_index("ix_stock_counts_pair", "stock_counts", ["store_id", "produce_type_id"])

    _seed()


def _seed() -> None:
    """The two stores and three produce types, at the IDs the client also uses.

    `ON CONFLICT DO NOTHING` because a device may have seeded these locally and
    pushed them before this migration ran. Its rows and these rows are the same
    rows, so whichever lands first wins and the second is a no-op — which is the
    whole point of the IDs being fixed.
    """
    now = datetime.now(timezone.utc)
    connection = op.get_bind()

    for index, (code, name) in enumerate(STORES, start=1):
        connection.execute(
            sa.text(
                """
                INSERT INTO stores
                    (id, created_at, updated_at, device_id, deleted_at,
                     field_versions, code, name, capacity_sacks, notes)
                VALUES
                    (:id, :now, :now, 'seed', NULL,
                     '{}'::jsonb, :code, :name, NULL, NULL)
                ON CONFLICT DO NOTHING
                """
            ),
            {"id": f"{STORE_ID_PREFIX}{index:02d}", "now": now, "code": code, "name": name},
        )

    for index, name in enumerate(PRODUCE_TYPES, start=1):
        connection.execute(
            sa.text(
                """
                INSERT INTO produce_types
                    (id, created_at, updated_at, device_id, deleted_at,
                     field_versions, name, is_active, notes)
                VALUES
                    (:id, :now, :now, 'seed', NULL,
                     '{}'::jsonb, :name, TRUE, NULL)
                ON CONFLICT DO NOTHING
                """
            ),
            {"id": f"{PRODUCE_ID_PREFIX}{index:02d}", "now": now, "name": name},
        )


def downgrade() -> None:
    """Dropping these discards the entire produce ledger.

    The balance exists nowhere else — it is derived from these events and never
    stored (SPEC 20.8) — so there is no other copy to fall back on. Reversible
    only in the sense that the schema goes back; the stock does not.
    """
    op.drop_table("stock_counts")
    op.drop_table("stock_outtakes")
    op.drop_table("stock_intakes")
    op.drop_table("produce_types")
    op.drop_table("stores")
