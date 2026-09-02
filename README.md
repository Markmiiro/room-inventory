# Room Inventory

Livestock records for one farm, in one building with ten indoor rooms.
Offline-first PWA over a FastAPI + PostgreSQL backend.

**This is the first vertical slice**, not the finished app. It exists to prove
the hardest part works: that a move recorded standing next to the animal, with
no signal, survives and reaches the server later. All fourteen screens are
built.

## Running it

Two processes and a database.

```bash
# Backend
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
createdb room_inventory

cp .env.example .env          # then fill it in:
#   DATABASE_URL           postgresql+psycopg:///room_inventory
#   JWT_SECRET             any long random string
#   INITIAL_PASSWORD_HASH  generate it with the snippet below
.venv/bin/python -c "from app.auth import hash_password; print(hash_password('your-password'))"

.venv/bin/alembic upgrade head        # also seeds the ten rooms
.venv/bin/uvicorn app.main:app --port 8000
```

```bash
# Frontend
cd frontend
npm install
npm run dev                            # http://localhost:5173, proxies /api to :8000
```

Open the app, tap the sync chip in the top bar, and sign in with the password
you hashed. Everything works before you sign in too — it just queues.

## Tests

```bash
cd backend  && .venv/bin/python -m pytest      # 64 tests, needs a local PostgreSQL
cd frontend && npm test                        # 134 tests
```

The suite shells out to `alembic`, so run it with the virtualenv on `PATH`
(`PATH=$PWD/.venv/bin:$PATH`) or the fixture cannot migrate the test database.

### The two-device test

```bash
cd frontend && npm run dev          # in one terminal
bash frontend/e2e/run.sh            # in another
```

Two browser contexts, so two isolated IndexedDB stores — which is what "device"
means to this app. Both sign in, both go offline, both edit different fields of
the same record and both sell five head from the same group of eight, then both
come back. It asserts they converge on identical state, that neither edit was
lost, that both sales survived, that the count clamped at zero, and that the
server recorded the oversell.

It rebuilds its own database and starts its own backend every run. That is
necessary rather than tidy: SPEC 8 rate-limits login to five attempts per
fifteen minutes and the limiter is in-process, so a second run against a warm
server is locked out — and would otherwise "pass" by never syncing at all. The
script checks that sign-in actually took for exactly that reason.

The backend suite creates and drops `room_inventory_test` itself, and runs the
Alembic migrations rather than `create_all` — the sync engine depends on
Postgres specifics (one shared sequence, JSONB, a partial unique index), so
testing against anything else would test a different system.

## How the sync works

The three properties everything else rests on:

**Nothing is rejected for being late.** A device offline for a week is pushing
writes the user already made and moved on from. Refusing them loses real data.
Duplicate tags from two devices are both accepted and an alert is raised
(SPEC 5.4); a group oversold by two offline devices keeps both sales, clamps
the count at zero, and records an anomaly naming the record (SPEC 6.7).

**Pushing twice is harmless.** IDs are minted on the client, so the server
recognises a replay and answers `duplicate`. A push that lands but whose
response is lost is safely retryable.

**The app starts with no network.** SPEC 9 asks for the shell cached and no
network dependency on any screen, and until the service worker existed the app
still needed one online load — the one moment it cannot ask for, since a phone
that has never opened the app in signal is a phone in a livestock building with
nothing on it. `vite-plugin-pwa` precaches the bundle **and the bundled fonts**;
a precache that skipped them would start offline in a fallback face. The API is
never cached: a stale sync response is worse than none, because the app is built
to answer from its own database. A new version shows a bar rather than reloading
under someone typing a tag next to the animal it belongs to (SPEC 9).

**A record stops being fed when it leaves.** SPEC 4.4 charges each record for
the days it was actually present, so the allocation needs to know when a record
left — and that only exists once Sales and Deaths do. This is why they were
built before anything read the allocation: without them an animal sold on the
2nd carries a whole month of feed, which raises no error and produces a number
that simply looks plausible. On the two-record dataset the walkthrough builds,
the difference is about 26,000 shillings on a 300,000 expense.
`departuresFrom()` derives the date and the head that left; a sold record's own
`head_count` is zero, so using it would swing the same number the other way.

**The expense share is an estimate, and says so.** SPEC 4.4 spreads an expense
across a pool weighted by head-days — `head_count × days present`. Ten head for a
fortnight and five head for a month ate the same feed, and only head-days says
so. The calculation is in `frontend/src/domain/allocation.ts`, and its tests were
written before it existed, with every expected figure worked out by hand from the
spec. That ordering matters more here than anywhere else in the app: a wrong
allocation raises no error and produces a plausible number, so a test written
afterwards would only agree with whatever the code already did. The suite is
mutation-checked — breaking the day count, the room boundary, the head weighting,
the period, or the rounding each makes it fail. The *wiring* is mutation-checked
the same way, because a correct formula fed the wrong inputs is the same wrong
number on screen: ignoring the departure date, using the leftover head instead of
the head that left, counting a deleted sale, or walking the leaving events in the
wrong order each break a test.

**Alerts are computed, never stored.** SPEC 4.6 is a list of conditions, and
`frontend/src/domain/alerts.ts` is that list as a pure function of rooms,
records, moves, treatments and the outbox. Four screens read it — Alerts groups
by urgency, Rooms banners the urgent ones, Room detail marks the rows it names,
Calendar arranges the dated ones by day. A rule written into any one of those
screens is a rule the other three quietly disagree with, which is why the module
takes plain data and returns plain data and is tested without a database.

**Both sides converge.** State entities merge last-write-wins *per field*, over
a total order of `(updated_at, device_id)`. Per field matters: one device
renaming a room while another changes its capacity must not lose either edit.
Each state row carries a `field_versions` map of per-field stamps to make that
possible.

### What is derived, never stored

Two caches are recomputed on the server from events and never trusted from a
push (`backend/app/domain/reconcile.py`):

- `current_room_id` — the destination of the latest move, by date then
  `created_at`.
- `head_count` — `initial_head_count` less everything that left: head sold,
  head died, head split into child records, clamped at zero.

The second is what makes SPEC 6.7 work. If `head_count` were an ordinary
last-write-wins field, the second device's stale arithmetic would win simply by
arriving later, and a real sale would vanish. The client updates its own copy
for immediate feedback but deliberately never pushes it.

### The ten rooms

They are seeded twice — once by migration `0002`, once locally on first open —
with **fixed, identical IDs** in both places. A device that has never reached
the network still has to arrive at the same ten rooms, or the first sync would
produce twenty. If you change the IDs, change them in both
`backend/alembic/versions/0002_seed_rooms.py` and `frontend/src/db/seed.ts`.

## Checking the mobile layout

The app is used one-handed in a livestock building, so 390px is the width that
matters — and a desktop browser window will not go narrow enough to check it
honestly. Media queries evaluate against an iframe's own viewport, so:

```
http://localhost:5173/dev/viewport.html?routes=/,/move,/rooms/<id>
```

renders each route in a 390px frame side by side. Desktop is checked at the
768px `md` breakpoint, where the bottom bar gives way to the sidebar and the
lists go multi-column. It is served only in dev and
is not copied into a build. Check any new screen there before calling it done:
the bottom nav and any action bar are both `fixed bottom-0` and will stack if a
screen shows them together.

Screens that own the bottom of the display for one task — Move, and presumably
Sell, Log death and Add or purchase — belong in `FOCUSED_ROUTES` in `App.tsx`.
That hides the bottom nav, gives the screen's own action bar the space, and
turns the top-left control into a cancel button.

## Layout

```
backend/
  app/
    models.py            SQLAlchemy: state entities carry field_versions, events do not
    sync.py              /sync/push and /sync/pull
    auth.py              Argon2id, JWT access + rotating refresh
    domain/merge.py      per-field last-write-wins
    domain/reconcile.py  the derived values above
  alembic/versions/      0001 schema, 0002 the ten rooms, 0003 purchases,
                         0004 health records, 0005 expenses and contacts
  tests/                 conflict cases first

frontend/src/
  db/mutations.ts        every write: IndexedDB + outbox, one transaction, then return
  db/schema.ts           Dexie tables
  db/seed.ts             the ten rooms, ids matched to the migration
  domain/rules.ts        occupancy, room type, current location — mirrors the server
  domain/alerts.ts       SPEC 4.6, as pure functions — four screens read them
  domain/calendar.ts     SPEC 4.7, the same events arranged by date
  domain/allocation.ts   SPEC 4.4 head-day expense shares — tests written first
  sync/engine.ts         outbox drain, backoff, pull cursor
  db/backup.ts           the whole device as one JSON file
  screens/               Rooms, RoomDetail, RecordDetail, Animals, AddPurchase,
                         Move, Health, Alerts, Calendar, Sell, LogDeath,
                         Expenses, Money, More, Contacts
```

## What is not built yet

All fourteen screens exist and every entity in SPEC 3 has a table on both sides.
What is left is the shell rather than the app: the **service worker** (SPEC 9),
so the app still needs a first load online; **import** to go with the export;
and the reports beyond the Money summary.

Sales and deaths are recorded and drive the money figures, but they are not yet
drawn on the Calendar. When they are, they belong in `domain/calendar.ts` beside
the events already there — not in the screen.

Record detail is built, but only its History tab has data behind it. The mockup's
Health and Money tabs are named as missing on the screen rather than drawn as
empty panels: an empty health tab reads as "nothing has happened to this animal",
which is a worse lie than "not built".

`Sale` and `Death` already exist as models: SPEC 6.7 is a conflict case about
selling, so it could not be tested without them. `Purchase` is fully wired —
SPEC 3.7 says one is created automatically whenever a record is added with
`source = bought`, so Add or purchase could not be honest without it.

### Why a vet visit is a state entity

Worth knowing, because an earlier draft of SPEC 16 said the opposite and the
spec was amended rather than the code.

SPEC 14.2 gives a visit a `status` that moves from `planned` to `completed`, and
its call-out fee and the vet's advice are both written afterwards onto a row
that already exists. An append-only visit would turn each of those into a *new*
visit, so one call-out would be counted several times and its fee split several
times over. So `VetVisit` carries `field_versions` and merges per field like a
room — which is also what the work needs, since one person marking a visit
completed and another typing up the advice must not overwrite each other
(SPEC 5.4).

`VisitNote` has none of that. It is written once, about one animal, on one
visit, and corrected by adding another note. It is an event, and two devices
noting the same animal keep both notes.

### Deliberately not built, and named so it stays visible

SPEC 17 lists four gaps that are decisions rather than oversights. They are
repeated here because a gap nobody can see is a gap nobody fixes, and the first
of them is load-bearing for two features that *are* built.

- **Birth records.** Offspring is a typed number. There is no birth event, no
  link from offspring to mother, and an animal born on the farm has no arrival
  date of its own. This is the main reason a date of birth goes missing, and a
  record with no date of birth fires no treatment schedule (SPEC 13.4) and shows
  no sale readiness (SPEC 15.3). The app says so rather than going quiet — a
  chip on the record, a filter on the Animals list, and an alert under This
  week — but saying so is not the same as fixing it.
- **Customers and vets are not linked.** A sale stores the buyer as free text,
  so customer history does not work. SPEC 14 links vets to visits; sales still
  need the same treatment.
- **Partial payment.** A sale is one price on one date. A buyer paying half now
  and half next month has nowhere to go, and the profit figures will be wrong
  until it does.
- **Feed quantity.** Feed is tracked as cost, not as bags in and out. You know
  what you spent, not what you used.

One more was found while building SPEC 13 and has since been **fixed**, but is
worth recording because the fix does less than it first appears to:

- **An animal's arrival date used to be discarded.** The Add or purchase form
  asked for one and the user typed it, but `createRecord` kept `arrival_date`
  only for groups, so for an animal it was stored as null and survived only as
  the date of its first move. It is now kept for both kinds, shown on Record
  detail, and editable. The dates already lost are recovered from that first
  move — on the server by migration `0007`, and on each device by the version 8
  upgrade in `db/schema.ts`, both reading the same move so they agree without
  talking. `db/backfill.ts` holds the rule.

  **This does not close the age gap, and must not be made to.** An arrival date
  is not an age. A two-year-old cow bought last week arrived last week and is
  not a week old, so `domain/age.ts` still counts an animal's age from its date
  of birth alone, exactly as SPEC 13.3 says. Only a group's age comes from its
  arrival. So birth records remain the real fix for the missing ages, and the
  add and edit forms now say plainly what a blank date of birth costs.

### Restoring a backup

`More → Restore from a backup` replaces everything on the device. That is what
makes refusing a bad file the whole feature: a half-applied import leaves a
device holding a mixture of two farms with no way to tell which rows came from
where, and there is no undo. So `parseBackup()` validates the whole file —
format, `schema_version`, every table's shape, and no table this build does not
know — before a single row is written, and the confirmation says what it is
about to destroy and what it will write. The restore itself is one transaction
over every table: a clear that succeeded followed by a write that failed would
leave the device empty, which is the one outcome worse than refusing the file.

The outbox is exported and restored with everything else. An export taken
offline describes work the server has never seen, and dropping it would lose
exactly the writes this app exists to protect.

### Where the mockups are wrong

SPEC 12 lists the known defects. Three more were found while building against
them, and the code deliberately does not match the picture:

- **Animals list** samples a group called "Finisher Pen A" and a search
  placeholder reading "Search animals, groups, or IDs". Both are SPEC 2
  violations — "pen" is a banned word for a room, and a tag is never an "ID".
  The built screen says "Search animals, groups or tags". Do not "fix" it back.
- **Alerts** puts a long isolation stay in Urgent at seven days and unsynced
  changes in Later. SPEC 4.6 says This week at fourteen days, and Urgent for
  unsynced work older than 48 hours. The rules follow the spec.
- **Room detail** ships a `tailwind.config` with a syntax error, which silently
  discards the whole theme and renders the mockup unstyled. `_render.py` repairs
  it before rendering, and then checks the rendered pixels: a page whose theme
  did not apply is reported `ok: false` rather than quietly written to disk.
- **Add expense** and **Manage categories** both show four categories already in
  place. That is sample data, not a seed — SPEC 3.11 ships with none, and the
  first expense creates the first one, so the empty state is the normal first
  state.
- **More** calls rooms "inventory zones". "Zone" is banned vocabulary (SPEC 2).

Species icons are rendered as words. TOKENS.md asks for five custom SVGs and
says to use the species name as text until they exist, rather than a misleading
icon. `frontend/src/components/SpeciesLabel.tsx` is the single place to change.
