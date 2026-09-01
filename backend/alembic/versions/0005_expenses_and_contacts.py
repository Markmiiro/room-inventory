"""Expense categories, customers, vets and expenses.

SPEC 3.10 and 3.11. The three contact-ish tables are **state** entities and carry
`field_versions`, so two devices editing different fields of the same customer
both keep their edit (SPEC 5.4). Expenses are events: what was spent, on what
day, corrected by adding a correcting entry rather than by editing (SPEC 4.8).

No categories are seeded. SPEC 3.11 is explicit that the app ships with none and
the first expense creates the first one, so there is deliberately no data
migration here to match `0002`.

Revision ID: 0005
Revises: 0004
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

SEQ_DEFAULT = sa.text("nextval('global_seq')")


def _sync_columns() -> list[sa.Column]:
    return [
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("device_id", sa.String(64), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("seq", sa.BigInteger, server_default=SEQ_DEFAULT, nullable=False),
    ]


def _state_columns() -> list[sa.Column]:
    return [
        *_sync_columns(),
        sa.Column("field_versions", postgresql.JSONB, nullable=False, server_default="{}"),
    ]


def upgrade() -> None:
    op.create_table(
        "expense_categories",
        *_state_columns(),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("is_archived", sa.Boolean, nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_expense_categories_seq", "expense_categories", ["seq"])

    op.create_table(
        "customers",
        *_state_columns(),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("phone", sa.String(40)),
        sa.Column("location", sa.Text),
        sa.Column("notes", sa.Text),
    )
    op.create_index("ix_customers_seq", "customers", ["seq"])

    op.create_table(
        "vets",
        *_state_columns(),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("phone", sa.String(40)),
        sa.Column("notes", sa.Text),
    )
    op.create_index("ix_vets_seq", "vets", ["seq"])

    op.create_table(
        "expenses",
        *_sync_columns(),
        sa.Column("amount", sa.BigInteger, nullable=False),
        sa.Column(
            "category_id",
            sa.String(26),
            sa.ForeignKey("expense_categories.id"),
            nullable=False,
        ),
        sa.Column("date", sa.Date, nullable=False),
        sa.Column("applies_to", sa.String(8), nullable=False),
        sa.Column("applies_to_id", sa.String(26)),
        sa.Column("note", sa.Text),
    )
    op.create_index("ix_expenses_seq", "expenses", ["seq"])
    # SPEC 4.4 allocates by the month containing the expense, so every read of
    # the money screens is a date range.
    op.create_index("ix_expenses_date", "expenses", ["date"])
    op.create_index("ix_expenses_category", "expenses", ["category_id"])


def downgrade() -> None:
    op.drop_table("expenses")
    op.drop_table("vets")
    op.drop_table("customers")
    op.drop_table("expense_categories")
