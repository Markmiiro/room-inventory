"""Birth records, and the offspring figure renamed.

SPEC 22. An animal born on this farm had no date of birth, because nothing
recorded the day it was born — and with no date of birth its treatment schedule
never fires and its sale readiness never computes (SPEC 13.4, 15.3). So the app
went quietest about the animals it should know most about. A birth event fixes
that at the source: every offspring it creates carries an exact date of birth.

`births` is an **event** table and carries no `field_versions`: a birth happened
on a day, and a mistake is corrected by adding rather than by editing (SPEC
3.2). Two devices recording the same morning offline both keep their row, which
is visible as two births rather than silently merged into one wrong one.

`records` gains three nullable links. `dam_record_id` and `sire_record_id` are
foreign keys — both animals exist long before the birth does. `birth_id`
deliberately is not: the birth row is created in the same push batch as the
offspring, one operation earlier, and a constraint would turn any reordering
into a rejected offspring record. Losing the animal to keep the link tidy is
the wrong trade.

**The offspring columns are renamed, not replaced.** `offspring_count` becomes
`offspring_baseline` and `offspring_updated_at` becomes
`offspring_baseline_updated_at`, values carried over by the rename itself. What
was typed by hand is what happened before births were recorded, and it is never
overwritten; the total on screen is that baseline plus the births counted. A
column still called `offspring_count` that no longer holds the offspring count
is how a screen ends up showing one number and labelling it the other — which
is why this is a rename rather than a reuse. `app.sync.LEGACY_FIELDS` accepts
the old spellings from a device that was offline when this shipped.

Revision ID: 0012
Revises: 0011
"""

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None

SEQ_DEFAULT = sa.text("nextval('global_seq')")


def upgrade() -> None:
    op.create_table(
        "births",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("device_id", sa.String(64), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("seq", sa.BigInteger, server_default=SEQ_DEFAULT, nullable=False),
        sa.Column(
            "dam_record_id",
            sa.String(26),
            sa.ForeignKey("records.id"),
            nullable=False,
        ),
        sa.Column("sire_record_id", sa.String(26), sa.ForeignKey("records.id")),
        # Free text, for a sire that is somebody else's animal. Both sire
        # columns may be null: plenty of births have no recorded father, and
        # inventing one is worse than leaving it blank.
        sa.Column("sire_name", sa.Text),
        sa.Column("date", sa.Date, nullable=False),
        sa.Column("born_count", sa.Integer, nullable=False),
        # Never more than born_count. The difference is written as a Death with
        # cause `stillbirth`, in the same client transaction, so a loss at birth
        # lands in the mortality figures rather than nowhere (SPEC 22).
        sa.Column("surviving_count", sa.Integer, nullable=False),
        sa.Column("vet_id", sa.String(26)),
        sa.Column("notes", sa.Text),
    )
    op.create_index("ix_births_seq", "births", ["seq"])
    op.create_index("ix_births_dam_record_id", "births", ["dam_record_id"])
    op.create_index("ix_births_date", "births", ["date"])

    op.add_column("records", sa.Column("dam_record_id", sa.String(26)))
    op.add_column("records", sa.Column("sire_record_id", sa.String(26)))
    op.add_column("records", sa.Column("birth_id", sa.String(26)))
    op.create_foreign_key(
        "fk_records_dam_record_id", "records", "records", ["dam_record_id"], ["id"]
    )
    op.create_foreign_key(
        "fk_records_sire_record_id", "records", "records", ["sire_record_id"], ["id"]
    )

    # The rename carries every value across. Nothing is recomputed and nothing
    # is cleared: what the farm typed is what happened before births were
    # recorded, and it stays exactly as typed.
    op.alter_column("records", "offspring_count", new_column_name="offspring_baseline")
    op.alter_column(
        "records",
        "offspring_updated_at",
        new_column_name="offspring_baseline_updated_at",
    )


def downgrade() -> None:
    """Puts the column names back and drops the births.

    The offspring baseline survives a downgrade — it is the same values under
    the old names. The birth rows do not, and neither do the parentage links, so
    a downgrade after any birth has been recorded loses the date of birth's
    provenance even though the dates themselves stay on the offspring records.
    """
    op.alter_column(
        "records",
        "offspring_baseline_updated_at",
        new_column_name="offspring_updated_at",
    )
    op.alter_column("records", "offspring_baseline", new_column_name="offspring_count")
    op.drop_constraint("fk_records_sire_record_id", "records", type_="foreignkey")
    op.drop_constraint("fk_records_dam_record_id", "records", type_="foreignkey")
    op.drop_column("records", "birth_id")
    op.drop_column("records", "sire_record_id")
    op.drop_column("records", "dam_record_id")
    op.drop_index("ix_births_date", table_name="births")
    op.drop_index("ix_births_dam_record_id", table_name="births")
    op.drop_index("ix_births_seq", table_name="births")
    op.drop_table("births")
