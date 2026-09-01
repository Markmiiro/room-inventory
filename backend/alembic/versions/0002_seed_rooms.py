"""Seed the ten rooms. SPEC 6.10.

The building has ten rooms whether or not anyone has typed them in, so they
exist from the first open: no blank screen, no setup wizard, no sample data.

Their IDs are fixed constants rather than freshly minted ULIDs. A device that
has never reached the network seeds the same ten rooms locally, and it must
arrive at the same identities this migration did — otherwise the first sync
would produce twenty rooms. Because the IDs agree, the two seeds are the same
rows, and any renaming the user has done merges by the ordinary field rules.

Revision ID: 0002
Revises: 0001
"""

from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

# Must stay identical to SEED_ROOMS in frontend/src/db/seed.ts.
ROOM_ID_PREFIX = "0000000000000000000000R0"

ROOMS = [
    ("R1", "Room 1"),
    ("R2", "Room 2"),
    ("R3", "Room 3"),
    ("R4", "Room 4"),
    ("R5", "Room 5"),
    ("R6", "Room 6"),
    ("R7", "Room 7"),
    ("R8", "Room 8"),
    ("R9", "Room 9"),
    ("R10", "Room 10"),
]
ISOLATION_CODE = "R4"


def upgrade() -> None:
    now = datetime.now(timezone.utc)
    connection = op.get_bind()

    for index, (code, name) in enumerate(ROOMS, start=1):
        connection.execute(
            sa.text(
                """
                INSERT INTO rooms
                    (id, created_at, updated_at, device_id, deleted_at,
                     field_versions, code, name, capacity, is_isolation, notes)
                VALUES
                    (:id, :now, :now, 'seed', NULL,
                     '{}'::jsonb, :code, :name, 20, :is_isolation, NULL)
                ON CONFLICT DO NOTHING
                """
            ),
            {
                "id": f"{ROOM_ID_PREFIX}{index:02d}",
                "now": now,
                "code": code,
                "name": name,
                "is_isolation": code == ISOLATION_CODE,
            },
        )


def downgrade() -> None:
    op.execute(f"DELETE FROM rooms WHERE id LIKE '{ROOM_ID_PREFIX}%'")
