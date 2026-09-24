"""An outside sire named on the record itself.

SPEC 22.9. The Add form can now name the parents of an animal born here without
recording a birth — the animal already exists, and the event that produced it
was never logged. A mother or a father on this farm is a link, and those columns
exist already. A father who is somebody else's animal had only `births.sire_name`
to live in, and a record added this way has no birth. So the free-text name is
carried on the record as well.

Revision ID: 0013
Revises: 0012
"""

import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("records", sa.Column("sire_name", sa.Text))


def downgrade() -> None:
    op.drop_column("records", "sire_name")
