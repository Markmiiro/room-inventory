"""Purchases: what a bought record cost.

SPEC 3.7. An event table, so it carries no `field_versions` — a purchase is a
thing that happened, and a correction is a new row rather than an edit.

`seq` takes its default from the same database-wide sequence as every other
table, which is what keeps `GET /sync/pull?since=` a single ordered scan.

Revision ID: 0003
Revises: 0002
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

SEQ_DEFAULT = sa.text("nextval('global_seq')")


def upgrade() -> None:
    op.create_table(
        "purchases",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("device_id", sa.String(64), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("seq", sa.BigInteger, server_default=SEQ_DEFAULT, nullable=False),
        sa.Column("record_id", sa.String(26), sa.ForeignKey("records.id"), nullable=False),
        sa.Column("date", sa.Date, nullable=False),
        # Whole shillings as an integer. Money is never a float here (SPEC 1).
        sa.Column("price", sa.BigInteger, nullable=False),
        sa.Column("seller", sa.Text),
        sa.Column("count", sa.Integer, nullable=False, server_default="1"),
    )
    op.create_index("ix_purchases_seq", "purchases", ["seq"])
    op.create_index("ix_purchases_record", "purchases", ["record_id"])


def downgrade() -> None:
    op.drop_index("ix_purchases_record", table_name="purchases")
    op.drop_index("ix_purchases_seq", table_name="purchases")
    op.drop_table("purchases")
