"""Vet visits and visit notes.

SPEC 14. A real visit is one date, one vet, several animals, some treated and
some only looked at, and a single call-out fee for the lot — none of which fits
on a HealthRecord, which is one animal and one product.

`vet_visits` is a **state** table and carries `field_versions`. SPEC 16's sync
note calls visits "events, append-only", but SPEC 14.2 gives a visit a `status`
that moves from `planned` to `completed`, and its fee and the vet's advice are
both written after the fact onto a row that already exists. An append-only visit
would turn every one of those into a new visit, and a single call-out would be
counted several times. See the docstring on `app.models.VetVisit`.

`visit_notes` genuinely is an event: written once, about one animal, on one
visit, and corrected by adding another note rather than by editing.

`health_records.visit_id` is nullable and stays that way — a self-administered
treatment has no visit behind it, which is how the farm works most days.

Revision ID: 0008
Revises: 0007
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0008"
down_revision = "0007"
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


def upgrade() -> None:
    op.create_table(
        "vet_visits",
        *_sync_columns(),
        sa.Column("field_versions", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("date", sa.Date, nullable=False),
        sa.Column("vet_id", sa.String(26), sa.ForeignKey("vets.id")),
        sa.Column("status", sa.String(16), nullable=False, server_default="completed"),
        # Whole UGX, like every other money column here. Never a float.
        sa.Column("call_out_fee", sa.BigInteger),
        sa.Column("reason", sa.Text),
        sa.Column("notes", sa.Text),
    )
    op.create_index("ix_vet_visits_seq", "vet_visits", ["seq"])
    # The list and the calendar both read visits by date.
    op.create_index("ix_vet_visits_date", "vet_visits", ["date"])

    op.create_table(
        "visit_notes",
        *_sync_columns(),
        sa.Column(
            "visit_id", sa.String(26), sa.ForeignKey("vet_visits.id"), nullable=False
        ),
        sa.Column(
            "record_id", sa.String(26), sa.ForeignKey("records.id"), nullable=False
        ),
        sa.Column("note", sa.Text, nullable=False),
    )
    op.create_index("ix_visit_notes_seq", "visit_notes", ["seq"])
    # SPEC 14.3's fee split reads a visit's notes; SPEC 14.5's health history
    # reads a record's. Both directions are asked for, so both are indexed.
    op.create_index("ix_visit_notes_visit", "visit_notes", ["visit_id"])
    op.create_index("ix_visit_notes_record", "visit_notes", ["record_id"])

    op.add_column("health_records", sa.Column("visit_id", sa.String(26), nullable=True))
    op.create_foreign_key(
        "fk_health_records_visit", "health_records", "vet_visits", ["visit_id"], ["id"]
    )
    op.create_index("ix_health_records_visit_id", "health_records", ["visit_id"])


def downgrade() -> None:
    op.drop_index("ix_health_records_visit_id", table_name="health_records")
    op.drop_constraint("fk_health_records_visit", "health_records", type_="foreignkey")
    op.drop_column("health_records", "visit_id")
    op.drop_index("ix_visit_notes_record", table_name="visit_notes")
    op.drop_index("ix_visit_notes_visit", table_name="visit_notes")
    op.drop_index("ix_visit_notes_seq", table_name="visit_notes")
    op.drop_table("visit_notes")
    op.drop_index("ix_vet_visits_date", table_name="vet_visits")
    op.drop_index("ix_vet_visits_seq", table_name="vet_visits")
    op.drop_table("vet_visits")
