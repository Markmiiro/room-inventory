"""Recover the arrival dates that were discarded for animals.

`createRecord` used to keep `arrival_date` only for groups, so for an animal the
date typed on the add form was dropped on the way to the database. It was not
quite lost: the record's first move — the initial placement, with a null
`from_room_id` — was dated with exactly that value, so the typed date survives
there.

This backfill copies it back. That makes it a **recovery of data the user
entered**, not a guess: the date being written is the same date they typed, read
from the row it was written to instead of the one it should have been.

Two limits, both deliberate:

* Only rows where `arrival_date IS NULL` are touched, so a value entered since
  the fix — or merged from another device — is never overwritten.
* An animal added with no room has no initial move and therefore nothing to
  recover. It stays null rather than being given today's date, which would be
  the invented age SPEC 13.4 forbids.

This changes no ages. SPEC 13.3 counts an animal's age from its date of birth,
and `frontend/src/domain/age.ts` does not read `arrival_date` for an animal — a
two-year-old cow bought last week arrived last week and is not a week old. What
it fixes is the record of when the animal joined the farm.

`seq` is advanced on every row written, or a client that had already pulled the
record would never see the correction (see `_next_seq` in app/sync.py).

Revision ID: 0007
Revises: 0006
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


# Exposed as a constant so the tests can run the statement this migration
# actually ships rather than a copy of it that can drift away from it. It is
# written to be safe to apply more than once: `arrival_date IS NULL` means a
# second run matches nothing.
BACKFILL_SQL = """
            UPDATE records AS r
               SET arrival_date = first_move.date,
                   seq          = nextval('global_seq')
              FROM (
                    SELECT DISTINCT ON (m.record_id)
                           m.record_id,
                           m.date
                      FROM moves AS m
                     WHERE m.from_room_id IS NULL
                       AND m.deleted_at IS NULL
                     -- SPEC 4.1 orders by date then created_at, and the initial
                     -- placement is the earliest of them.
                     ORDER BY m.record_id, m.date, m.created_at
                   ) AS first_move
             WHERE r.id = first_move.record_id
               AND r.kind = 'animal'
               AND r.arrival_date IS NULL
               AND r.deleted_at IS NULL
"""


def upgrade() -> None:
    op.execute(sa.text(BACKFILL_SQL))


def downgrade() -> None:
    """Deliberately not reversible.

    Clearing every animal's arrival date would also discard the ones entered by
    hand after the fix, which this migration cannot tell apart from the ones it
    wrote. Leaving the recovered values in place is harmless: the column was
    always nullable and always meant the same thing.
    """
