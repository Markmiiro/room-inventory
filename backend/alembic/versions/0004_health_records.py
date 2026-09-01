"""Health records: treatments, vaccinations and doses.

SPEC 3.6. An event table — a treatment is a thing that happened on a date, and a
correction is a new row (SPEC 4.8).

`next_due` is indexed because it is read on every load of Alerts and Calendar,
which both scan for what is overdue or coming up rather than for one record.

Revision ID: 0004
Revises: 0003
"""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

SEQ_DEFAULT = sa.text("nextval('global_seq')")


def upgrade() -> None:
    op.create_table(
        "health_records",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("device_id", sa.String(64), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("seq", sa.BigInteger, server_default=SEQ_DEFAULT, nullable=False),
        sa.Column("record_id", sa.String(26), sa.ForeignKey("records.id"), nullable=False),
        sa.Column("type", sa.String(16), nullable=False),
        sa.Column("product", sa.Text),
        sa.Column("dose", sa.Text),
        sa.Column("date", sa.Date, nullable=False),
        sa.Column("next_due", sa.Date),
        sa.Column("withdrawal_days", sa.Integer),
        sa.Column("vet_id", sa.String(26)),
        # Whole shillings. A direct cost against this record (SPEC 4.5).
        sa.Column("cost", sa.BigInteger),
        sa.Column("notes", sa.Text),
    )
    op.create_index("ix_health_records_seq", "health_records", ["seq"])
    op.create_index("ix_health_records_record", "health_records", ["record_id"])
    op.create_index("ix_health_records_next_due", "health_records", ["next_due"])


def downgrade() -> None:
    op.drop_index("ix_health_records_next_due", table_name="health_records")
    op.drop_index("ix_health_records_record", table_name="health_records")
    op.drop_index("ix_health_records_seq", table_name="health_records")
    op.drop_table("health_records")
