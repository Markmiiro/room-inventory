"""Split the `poultry` species into hens, ducks, geese and turkeys.

SPEC 18. `poultry` was one enum value standing in for four birds that are not
one thing. They mature at different ages, so they reach market at different ages
(SPEC 15), and the single seeded sale target — six weeks, a broiler hen's — was
right for at most one of them and quietly wrong for the other three.

The enum loses a value, so every row still carrying it has to be moved. There
are three kinds of row and they do not all go to the same place:

* **Records** go to `hens`. It is a guess, and the only defensible one: the hen
  is far and away the most common bird on a smallholding, and the old value's
  own six-week target was a broiler hen's, so a `poultry` record was already
  being treated as a hen everywhere its age mattered. The count of rows moved is
  reported in the migration output, and the client shows the same number once on
  the Animals screen, because the person holding the phone is the only one who
  knows which pens actually held ducks. A migration that silently retyped part
  of the flock and said nothing would be indistinguishable from data loss.

* **Treatment schedules** go to `birds`, not to `hens`. A schedule is a rule
  rather than an animal. The Newcastle and Gumboro rows were written for poultry
  as a category and still apply to all four, so narrowing them to hens would
  silently stop vaccinating the ducks — the exact quiet gap SPEC 13.1 exists to
  close. Keeping one row rather than splitting it into four also keeps one
  interval to edit: four copies that must be kept agreeing is a worse trap than
  the one being fixed, and a farmer who updated three of them would get a
  schedule firing differently for ducks than for hens with nothing on screen
  saying why. The seeded IDs are untouched, so an interval already edited
  survives (SPEC 16).

* **Expenses tagged to the species** go to `hens`, alongside the records they
  allocate to. Missing these would leave the birds' feed bill allocated to a
  species no record has, and its whole cost would drop silently out of every
  estimated share (SPEC 4.4) — not visibly wrong, just gone.

`seq` is advanced on every row written, or a client that had already pulled the
row would never see the correction (see `_next_seq` in app/sync.py).

`updated_at` is deliberately **not** advanced. These rows are resolved
last-write-wins per field (SPEC 5.4), and a device that has already corrected a
pen of ducks by hand must keep that correction when this lands. Touching
`updated_at` would make the migration win every one of those races.

The species column is a plain `String(16)`, not a Postgres enum, so there is no
type to alter — `turkeys` fits, and the constraint that matters lives in the
TypeScript union and in this migration agreeing with it.

Revision ID: 0009
Revises: 0008
"""

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


# Exposed as constants so the tests run the statements this migration actually
# ships rather than copies that can drift from them. Each is safe to apply more
# than once: after the first run nothing matches `= 'poultry'`.
RECORDS_SQL = """
    UPDATE records
       SET species = 'hens',
           seq     = nextval('global_seq')
     WHERE species = 'poultry'
"""

SCHEDULES_SQL = """
    UPDATE treatment_schedules
       SET species = 'birds',
           seq     = nextval('global_seq')
     WHERE species = 'poultry'
"""

EXPENSES_SQL = """
    UPDATE expenses
       SET applies_to_id = 'hens',
           seq           = nextval('global_seq')
     WHERE applies_to    = 'species'
       AND applies_to_id = 'poultry'
"""


def upgrade() -> None:
    connection = op.get_bind()

    records = connection.execute(sa.text(RECORDS_SQL)).rowcount
    schedules = connection.execute(sa.text(SCHEDULES_SQL)).rowcount
    expenses = connection.execute(sa.text(EXPENSES_SQL)).rowcount

    # Printed rather than logged so it lands in the deploy output, where the
    # person running the migration will actually see it. The record count is the
    # one that needs a human: every one of those rows is now a hen, and some of
    # them were not.
    print(
        f"SPEC 18: moved {records} record(s) from poultry to hens, "
        f"{schedules} treatment schedule(s) to birds, "
        f"and {expenses} species-tagged expense(s) to hens."
    )


def downgrade() -> None:
    """Deliberately not reversible.

    Collapsing hens, ducks, geese and turkeys back into `poultry` would discard
    every correction made since the split — precisely the information the split
    exists to make recordable, and the part of it this migration could not
    supply itself. Moving only the hens back would be worse still: it would be
    indistinguishable from a farm that really does keep only ducks and geese.
    """
