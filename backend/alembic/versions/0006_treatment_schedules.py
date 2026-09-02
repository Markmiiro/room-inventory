"""Treatment schedules, and the link from a treatment to the schedule it satisfies.

SPEC 13. A schedule is a **state** entity and carries `field_versions`, so two
devices editing different fields of the same schedule both keep their edit
(SPEC 5.4) — one changing the interval and another the default product must not
cost each other their work.

The eight starter rows are seeded here with fixed IDs, and those IDs must stay
identical to `SEED_SCHEDULES` in `frontend/src/db/seed.ts`. This is the same
requirement as the ten rooms in `0002`, and for a sharper reason: two devices
that seeded offline and disagreed on IDs would sync into sixteen schedules, and
every animal on the farm would then be told twice that it is due for the same
vaccination. Because the IDs agree, the two seeds are the same rows, and any
edit the user has made merges by the ordinary field rules.

`health_records.schedule_id` is nullable and stays that way. A treatment given
ad hoc — a sick animal — has no schedule behind it, and SPEC 13.3 is explicit
that such a dose must not disturb any schedule's next date.

Revision ID: 0006
Revises: 0005
"""

from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

SEQ_DEFAULT = sa.text("nextval('global_seq')")

# Must stay identical to SCHEDULE_ID_PREFIX in frontend/src/db/seed.ts.
SCHEDULE_ID_PREFIX = "0000000000000000000000S0"

# Must stay identical to SEED_SCHEDULES in frontend/src/db/seed.ts, in this
# order — the position in this list is what mints the ID.
#
# SPEC 13.5: "these are a starting point, not veterinary advice". Months are
# written as 30 days and years as 365, consistently, so that what the user sees
# on the schedules screen is a number they can recognise and edit rather than a
# calendar calculation they cannot.
SCHEDULES = [
    # (name, species, type, first_due_age_days, repeat_every_days)
    ("Foot and mouth vaccination", "cattle", "vaccination", 120, 180),
    ("Deworming", "cattle", "deworming", 60, 90),
    ("PPR vaccination", "goats", "vaccination", 90, 365),
    ("Deworming", "goats", "deworming", 30, 90),
    ("Deworming", "sheep", "deworming", 30, 90),
    ("Deworming", "pigs", "deworming", 60, 90),
    ("Newcastle vaccination", "poultry", "vaccination", 7, 90),
    # Listed as one-off in SPEC 13.5, so it has no interval.
    ("Gumboro vaccination", "poultry", "vaccination", 14, None),
]


def upgrade() -> None:
    op.create_table(
        "treatment_schedules",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("device_id", sa.String(64), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("seq", sa.BigInteger, server_default=SEQ_DEFAULT, nullable=False),
        sa.Column("field_versions", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("species", sa.String(16), nullable=False),
        sa.Column("type", sa.String(16), nullable=False),
        sa.Column("first_due_age_days", sa.Integer),
        sa.Column("repeat_every_days", sa.Integer),
        sa.Column("applies_to", sa.String(8), nullable=False, server_default="both"),
        sa.Column("default_product", sa.Text),
        sa.Column("default_withdrawal_days", sa.Integer),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("notes", sa.Text),
    )
    op.create_index("ix_treatment_schedules_seq", "treatment_schedules", ["seq"])
    # Every read of the due computation is "the schedules for this species".
    op.create_index("ix_treatment_schedules_species", "treatment_schedules", ["species"])

    # SPEC 13.3 — which schedule a dose satisfied. Indexed because the due
    # computation asks "the most recent treatment against this schedule" for
    # every record it considers (SPEC 6.13).
    op.add_column("health_records", sa.Column("schedule_id", sa.String(26), nullable=True))
    op.create_foreign_key(
        "fk_health_records_schedule",
        "health_records",
        "treatment_schedules",
        ["schedule_id"],
        ["id"],
    )
    op.create_index("ix_health_records_schedule_id", "health_records", ["schedule_id"])

    _seed()


def _seed() -> None:
    """The eight starter schedules, at IDs the client seed also uses.

    `ON CONFLICT DO NOTHING` because a device may have seeded these locally and
    pushed them before this migration ran. Its rows and these rows are the same
    rows, so the first one to land wins and the second is a no-op — which is the
    whole point of the IDs being fixed.
    """
    now = datetime.now(timezone.utc)
    connection = op.get_bind()

    for index, (name, species, kind, first_due, repeat) in enumerate(SCHEDULES, start=1):
        connection.execute(
            sa.text(
                """
                INSERT INTO treatment_schedules
                    (id, created_at, updated_at, device_id, deleted_at,
                     field_versions, name, species, type, first_due_age_days,
                     repeat_every_days, applies_to, default_product,
                     default_withdrawal_days, is_active, notes)
                VALUES
                    (:id, :now, :now, 'seed', NULL,
                     '{}'::jsonb, :name, :species, :type, :first_due,
                     :repeat, 'both', NULL, NULL, TRUE, NULL)
                ON CONFLICT DO NOTHING
                """
            ),
            {
                "id": f"{SCHEDULE_ID_PREFIX}{index:02d}",
                "now": now,
                "name": name,
                "species": species,
                "type": kind,
                "first_due": first_due,
                "repeat": repeat,
            },
        )


def downgrade() -> None:
    op.drop_index("ix_health_records_schedule_id", table_name="health_records")
    op.drop_constraint("fk_health_records_schedule", "health_records", type_="foreignkey")
    op.drop_column("health_records", "schedule_id")
    op.drop_index("ix_treatment_schedules_species", table_name="treatment_schedules")
    op.drop_index("ix_treatment_schedules_seq", table_name="treatment_schedules")
    op.drop_table("treatment_schedules")
