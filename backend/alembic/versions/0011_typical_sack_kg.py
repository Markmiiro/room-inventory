"""What a sack of each produce usually weighs.

SPEC 20.17. Set by the farm rather than shipped as a guess, and used for exactly
one thing: warning that an entry looks like a typo. When an intake or outtake
gives both sacks and kilograms and the implied weight per sack is more than half
away from this figure, the form says so in words and lets the entry through.

**Nothing is ever computed from it.** SPEC 20.8 is explicit that sacks and
kilograms are tracked independently and neither is derived from the other — a
sack of coffee and a sack of maize weigh different amounts, and two sacks of the
same coffee are not identical. Multiplying sacks by this to fill in a missing
weight would turn a hint into a fabricated measurement.

Nullable, with no default. A seeded number would be one the farm never chose,
quietly deciding what counts as a typo on their scales; with the column empty no
warning fires and everything else works normally.

Revision ID: 0011
Revises: 0010
"""

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("produce_types", sa.Column("typical_sack_kg", sa.Numeric(12, 3), nullable=True))


def downgrade() -> None:
    """Drops the farm's own figures. Nothing else reads the column, so no
    balance or money figure changes — only the typo warning stops firing."""
    op.drop_column("produce_types", "typical_sack_kg")
