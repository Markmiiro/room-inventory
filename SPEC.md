# SPEC.md — Room Inventory

Build specification. The screenshots in `screenshots/` show what the app looks
like. **This document defines what it does.** Where they disagree, this document
wins.

The HTML in `reference-only/` is AI-generated mockup. Use it for exact colours and
spacing only. **Do not copy its structure** — it has no data model, no state, and
its sample data contradicts this spec in places. See section 11.

---

## 1. What this is

A livestock record system for one farm, housed in a single building with ten
indoor rooms. It answers four questions: what is in each room, where has this
animal been, what needs attention, and is the farm making money.

**Architecture:** an offline-first PWA backed by a FastAPI server.

Every action writes to the device first and returns immediately. Nothing waits on
the network. A background process pushes changes to the server and pulls other
changes down whenever a connection is available. The app is fully usable — reading
and writing — with no signal at all.

This is not a nicety. The app is used standing next to the animals, in a building
that may have no coverage. An app that can't record a move at that moment is an
app whose records go stale.

**Stack:**

| Layer | Choice |
|---|---|
| Backend | FastAPI, Python 3.12, Pydantic v2, SQLAlchemy 2.x |
| Database | PostgreSQL 16 |
| Migrations | Alembic |
| Frontend | React 18, TypeScript, Tailwind |
| Local store | IndexedDB (via Dexie or idb) |
| Auth | Single user, hashed password, JWT access + refresh |
| Hosting | Railway (app + managed Postgres) |

**Currency is Ugandan Shillings.** Whole numbers, no decimals, thousands
separated: `UGX 1,250,000`. Short form `UGX 1.25M` only on summary cards, never on
a form or a record detail. Store as integer shillings — never floats.

**Auth is a flag.** `AUTH_ENABLED` defaults to false, so the shipped app has no
password and the API is open to anyone who knows its URL. Section 21 is the
decision and its cost; section 8 is what happens when it is turned on.

**Time.** Store all timestamps as UTC ISO 8601. Display in East Africa Time
(UTC+3). Dates without a time (move dates, sale dates) are plain `YYYY-MM-DD`
with no timezone applied.

---

## 2. Vocabulary

These words appear in the UI exactly as written. No synonyms, ever.

| Use | Never use |
|---|---|
| **Room** | pen, barn, wing, stall, sty, coop, paddock, pasture, facility, zone |
| **Move** | transfer, relocate |
| **Animal** | (an individually tagged animal) |
| **Group** | flock, herd, batch |
| **Tag** | ID, identifier |

Code identifiers match: `room`, `move`, `animal`, `group`.

Section 20.2 adds the produce vocabulary — Store, Produce, Sack, Intake,
Outtake, Stock count — and the words banned alongside them. **A store is not a
room**, in the UI or in the data model.

---

## 3. Data model

### 3.1 Fields every entity carries

| Field | Type | Notes |
|---|---|---|
| `id` | string (ULID) | **Generated on the client**, never by the server. This is what lets records created offline keep a stable identity |
| `created_at` | timestamp | UTC |
| `updated_at` | timestamp | UTC. Drives last-write-wins conflict resolution |
| `device_id` | string | Which device last wrote. Breaks `updated_at` ties |
| `deleted_at` | timestamp \| null | Soft delete only. Rows are never physically removed |
| `seq` | bigint | **Server-assigned**, monotonic across the whole database. Clients pull everything after their last known `seq` |

ULIDs are used rather than UUIDs because they sort by creation time, which makes
event logs naturally ordered.

### 3.2 Two classes of entity

This distinction drives the entire sync design.

**Event entities** — `Move`, `Sale`, `Death`, `HealthRecord`, `Purchase`,
`Expense`. Append-only. Once written they are never edited or deleted. Two devices
can both add events without conflict; the merge is simply the union of both sets.
To correct a mistake, add a correcting entry.

**State entities** — `Room`, `Record`, `Customer`, `Vet`, `ExpenseCategory`.
Mutable. These can conflict, and are resolved last-write-wins per field.

### 3.3 Room

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | string | yes | `R1`–`R10`. Unique. Displayed in mono everywhere |
| `name` | string | yes | Plain indoor name, e.g. "Front room" |
| `capacity` | integer | yes | Minimum 1 |
| `is_isolation` | boolean | yes | Exactly one room should have this true |
| `notes` | text | no | |

Room `type` is **derived, never stored**. See 4.2.

### 3.4 Record

The central entity. A record is **either** an animal **or** a group. Any species
can be either — chosen per record, not fixed per species.

| Field | Type | Required | Notes |
|---|---|---|---|
| `kind` | `animal` \| `group` | yes | Immutable after creation |
| `species` | enum | yes | `cattle`, `goats`, `sheep`, `pigs`, `hens`, `ducks`, `geese`, `turkeys`. See 18 |
| `tag` | string | yes | Tag number for animals, group name for groups |
| `breed` | string | no | Free text |
| `sex` | `male` \| `female` | animals only | |
| `date_of_birth` | date | no | Animals only |
| `arrival_date` | date | groups only | |
| `head_count` | integer | yes | Always 1 for animals. 1 or more for groups |
| `offspring_count` | integer | no | Animals only. Typed by hand, never derived |
| `offspring_updated_at` | date | auto | Set whenever `offspring_count` changes |
| `source` | enum | yes | `born_here`, `bought`, `gift` |
| `status` | enum | yes | `active`, `sold`, `dead` |
| `parent_record_id` | string | no | Set when this record came from splitting a group |
| `notes` | text | no | |

**`room_id` is not a stored field.** Current location is derived from the most
recent move. See 4.1. A denormalised `current_room_id` column may exist as a cache
for query performance, but it is always recomputed from moves and never trusted as
the source of truth.

**`head_count` is derived too, and is never synced as a field.** The server
recomputes it from `initial_head_count` less everything that left — head sold,
head died, head split into a child record — clamped at zero. Clients hold a copy
so a screen can react to a write immediately, but that copy is **excluded from
every push**, and a pushed value is ignored if one arrives.

This is what makes 6.7 work, and it is the reason the rule is stated here rather
than left to the implementation. If `head_count` were an ordinary last-write-wins
field, two offline devices selling from the same group would each push their own
arithmetic, and whichever synced second would win by arriving later — silently
erasing a real sale. Because the count is derived, both sales survive, the count
clamps, and the anomaly is recorded.

The same reasoning applies to any future field computed from events: derive it,
do not sync it.

**Offspring** is only meaningful for females. On a male record, hide the field or
label it "Offspring sired". Always display the last-updated date beside the
number — `2 (updated 12 Aug)` — so a stale figure is visibly stale.

**Groups have no per-animal history.** Health records, moves and sales apply to
the whole group or a quantity within it, never to a named individual inside it.

### 3.5 Move (event)

| Field | Type | Required | Notes |
|---|---|---|---|
| `record_id` | string | yes | |
| `from_room_id` | string \| null | yes | Null for initial placement |
| `to_room_id` | string | yes | |
| `date` | date | yes | Defaults to today |
| `count` | integer | yes | 1 for animals; head moved for groups |
| `reason` | enum | yes | `routine`, `weaning`, `sick`, `isolation`, `new_arrival`, `breeding` |
| `note` | text | no | |

### 3.6 HealthRecord (event)

| Field | Type | Required | Notes |
|---|---|---|---|
| `record_id` | string | yes | |
| `type` | enum | yes | `vaccination`, `deworming`, `treatment`, `vitamin`, `other` |
| `product` | string | no | |
| `dose` | string | no | |
| `date` | date | yes | Defaults to today |
| `next_due` | date | no | Drives alerts and calendar |
| `withdrawal_days` | integer | no | 0 or more |
| `vet_id` | string | no | |
| `cost` | integer | no | UGX. A direct cost against this record |
| `notes` | text | no | |

**Withdrawal end date** = `date` + `withdrawal_days`. While that is in the future,
the animal shows an active withdrawal and cannot be sold without explicit
confirmation (see 6.6).

### 3.7 Purchase (event)

`record_id`, `date`, `price` (integer UGX), `seller`, `count`. Created
automatically when a record is added with `source = bought`.

### 3.8 Sale (event)

| Field | Type | Required | Notes |
|---|---|---|---|
| `record_id` | string | yes | |
| `date` | date | yes | |
| `price` | integer | yes | Total for the sale, not per head |
| `count` | integer | yes | Head sold, for partial group sales |
| `customer_id` | string | no | |
| `notes` | text | no | |

A record may carry several sales if it is a group sold in parts.

### 3.9 Death (event)

`record_id`, `date`, `count`, `cause` (`illness`, `injury`, `predator`, `age`,
`stillbirth`, `unknown`), `vet_id`, `notes`.

### 3.10 Expense (event)

| Field | Type | Required | Notes |
|---|---|---|---|
| `amount` | integer | yes | UGX, greater than 0 |
| `category_id` | string | yes | |
| `date` | date | yes | Defaults to today |
| `applies_to` | enum | yes | `farm`, `species`, `room` |
| `applies_to_id` | string | conditional | Species name or room id. Null when `farm` |
| `note` | text | no | |

### 3.11 ExpenseCategory, Customer, Vet (state)

**ExpenseCategory** — `name`, `is_archived`. **Created by the user, not fixed by
the app.** Ships with none; the first expense creates the first category. A
category can be created inline inside the expense form without losing the
half-entered expense.

**Customer** — `name` (required), `phone`, `location`, `notes`.

**Vet** — `name` (required), `phone`, `notes`.

---

## 4. Rules and derived values

These are computed identically on client and server. Extract them into shared
logic so the two cannot drift — the client computes them offline, the server
computes them for reports.

### 4.1 Current location

A record's room is the `to_room_id` of its most recent move, ordered by `date`
then `created_at`. Never a stored truth.

After a group split, each resulting record has its own independent move history.

### 4.2 Room occupancy and type

- **Occupancy** = sum of `head_count` across active records currently in the room.
- Displayed as `"45 of 53"`. **Never as a percentage.** Percentages do not appear
  anywhere in this app.
- **Type is derived.** One species present → that species. Two or more → `Mixed`,
  except that two or more *birds* and nothing else → `Birds` (see 18). None →
  `Empty`. If `is_isolation`, the chip reads `Isolation` regardless.
- **Over capacity** when occupancy exceeds capacity: count in alert red, red
  capacity bar, and a chip reading "Over capacity". It **warns, never blocks** —
  the animals are physically there whether the app approves or not.

### 4.3 Splitting a group

When part of a group is moved, sold, or recorded dead:

1. The original's `head_count` is reduced by the quantity.
2. For a **move**, create a new record with the moved quantity, copying species,
   breed, arrival date and source, with `parent_record_id` set and its own move
   history starting at the destination. Derive the tag, e.g. `P-Weaners-2`.
3. For a **sale or death**, no new record is created. The quantity simply leaves
   and the Sale or Death row carries the count.
4. Accrued costs are not redistributed. A split record starts with a proportional
   share of the original purchase cost:
   `original_purchase × (moved_count ÷ original_count)`.

A group can never be split beyond its `head_count`. See 6.7 for what happens when
two offline devices both try.

### 4.4 Estimated cost share

Purchase price and health costs belong directly to a record. Expenses do not — you
feed a room, not an animal. So expenses are allocated:

- `farm` — spread across all active records.
- `species` — spread across active records of that species.
- `room` — spread across active records in that room.

Allocation is weighted by **head-days**: for each record in the pool,
`head_count × days present during the expense's period`. A record present for ten
days of a thirty-day month carries a third of the weight of one present
throughout. For a single-date expense, the period is the month containing it.

**This is an estimate and must always be labelled as one** — the word "estimated"
visible in words, not implied by styling.

### 4.5 Profit and loss

**Per record:**
`profit = sum(sales) − purchase − sum(health costs) − allocated expense share`

**Whole farm, for a period:**
`profit = sum(sales in period) − sum(purchases in period) − sum(expenses in period)`

The farm figure uses actual expenses and is exact. Per-record figures are
estimates and will not sum precisely to the farm total. Say so plainly on the
Money Summary screen rather than hiding it.

Profit in green, loss in alert red, always signed.

### 4.6 Alerts

Computed conditions, not stored flags:

| Alert | Condition | Priority |
|---|---|---|
| Room over capacity | occupancy > capacity | Urgent |
| Treatment overdue | `next_due` < today | Urgent |
| Sync failing | unsynced changes older than 48h | Urgent |
| Withdrawal active | withdrawal end ≥ today | This week |
| Treatment due soon | `next_due` within 7 days | This week |
| Long isolation stay | in isolation room > 14 days | This week |
| Duplicate tag | two active records share a tag | This week |
| Treatment due later | `next_due` within 30 days | Later |

Every alert states its meaning in words. **Colour is never the only signal.**

Empty state: green check, "Nothing needs attention", plus a line naming what was
checked.

### 4.7 Calendar

The same events as Alerts, arranged by date instead of urgency: treatments due,
purchases, sales, moves, deaths. Past entries are history; future ones are
`next_due` dates. The legend labels every marker type in words.

### 4.8 Deleting

- A **room** cannot be deleted while any active record is in it. Offer to move the
  contents first.
- A **record** is never deleted. Selling or death sets `status`; the record and its
  full history stay readable under the "Sold or dead" filter.
- An **expense category** in use is archived, not deleted. Existing expenses keep
  their category name; it stops appearing as a choice.
- **Event entities are append-only.** Correct mistakes by adding a correcting
  entry.

---

## 5. Sync

The part that needs the most care. Get this wrong and the app silently loses data.

### 5.1 Principle

The client is never blocked by the network. Every mutation:

1. Writes to IndexedDB immediately and updates the UI.
2. Appends an operation to a local **outbox**.
3. Returns. The user carries on.

A background worker drains the outbox whenever a connection exists.

### 5.2 Endpoints

**`POST /sync/push`** — client sends a batch of operations from its outbox.

```json
{
  "device_id": "01J8...",
  "operations": [
    { "op": "upsert", "entity": "record", "id": "01J8...", "data": { ... },
      "updated_at": "2026-08-31T09:14:22Z" },
    { "op": "insert", "entity": "move",   "id": "01J8...", "data": { ... } }
  ]
}
```

Server responds with each operation's outcome — `applied`, `duplicate` (already
seen; safe to drop), or `conflict` with the server's winning version attached. It
also returns the current head `seq`.

**`GET /sync/pull?since={seq}&limit=500`** — returns every row with `seq` greater
than the cursor, across all entities, in `seq` order, plus the new cursor and
whether more pages remain.

### 5.3 Idempotency

Because the client generates IDs, pushing the same operation twice is harmless —
the server recognises the ID and returns `duplicate`. **This is essential.** A
push that succeeds on the server but fails on the way back must be safely
retryable. Never assume a failed request means the write didn't land.

### 5.4 Conflict rules

**Event entities never conflict.** Union by `id`. Two devices adding moves offline
both land, and both are correct — the animal really did move twice.

**State entities:** last-write-wins per field, by `updated_at`, ties broken by the
lexically greater `device_id`. Deterministic, so both sides reach the same answer.

**Duplicate tags across devices:** the server does **not** reject. Rejecting data
that was already entered offline is the worst possible outcome — the user has
moved on and won't re-enter it. Both records are accepted, and a "Duplicate tag"
alert is raised for the user to resolve.

**Head count going negative:** clamp at 0, accept both events, and raise an alert
naming the record. See 6.7.

### 5.5 Sync state in the UI

Visible but never alarming:

- A small indicator showing `Synced`, `N changes pending`, or `Offline`.
- Pending changes are shown normally, not greyed out. They are real records.
- Only after **48 hours** of failure does this escalate to an alert.
- Never block an action because sync is behind.

### 5.6 Retry

Exponential backoff starting at 5 seconds, capped at 5 minutes. Retry on regained
connectivity, on app foreground, and every 5 minutes while open. The outbox
survives app restarts.

---

## 6. Edge cases

**6.1 Group split to zero.** `head_count` reaches 0 → status becomes `sold` or
`dead` per cause, record leaves active lists, history stays viewable.

**6.2 Acting on an inactive record.** A `sold` or `dead` record cannot be moved,
treated, sold or killed again. Those actions are hidden, not merely disabled.

**6.3 Moving into a full room.** Allowed. A red warning names how far over
capacity it will go. Proceeds if confirmed.

**6.4 Moving into the same room.** The current room tile is dimmed, labelled
"Current", and cannot be selected.

**6.5 Duplicate tags on one device.** Blocked at entry, naming where the tag is in
use: "This tag is already used by an animal in R3." A tag from a sold or dead
record may be reused. Across devices, see 5.4.

**6.6 Selling during withdrawal.** A red warning names the end date. It is a
confirmation, not a block — the decision is the owner's.

**6.7 Two devices overselling a group.** Group of 8, both devices offline, each
sells 5. Both sales are kept, `head_count` clamps to 0, and an alert reads
"Record P-Weaners was reduced below zero by offline changes — please check."
Never silently discard a sale.

**6.8 Future dates.** Moves, sales, deaths and expenses cannot be dated in the
future. `next_due` must be.

**6.9 Backdated entries.** Allowed up to today. Derived values recompute.

**6.10 First open, no data.** Ten rooms already exist — R1 to R10, generic names,
capacity 20, R4 flagged isolation — with a prompt to rename them and add the first
animals. No blank screen, no setup wizard, no sample data.

**6.11 Offspring on a male.** Hidden, or labelled "Offspring sired". Never removed
from the model.

**6.12 Expense with no categories.** The chip row shows only "+ New category".
Creating one inline does not clear the amount already typed.

**6.13 Very long lists.** Every list is searchable, filterable and paginated, and
assumes thousands of rows. Herd size is not fixed — any number must work without
redesign.

**6.14 Clock skew.** A device with a wrong clock can win conflicts it shouldn't.
The server rejects `updated_at` more than 24 hours in the future, substituting
server time, and logs it.

---

## 7. API

Beyond sync, a small REST surface.

**Auth**
- `POST /auth/login` → access token (30 min) + refresh token (30 days)
- `POST /auth/refresh`
- `POST /auth/change-password`

**Reports** — computed server-side for exactness; the client computes locally when
offline and marks the figure as possibly stale.
- `GET /reports/profit-loss?from=&to=`
- `GET /reports/species-breakdown?from=&to=`
- `GET /reports/record-profit/{record_id}`

**Backup**
- `GET /export/json` — everything, with `schema_version`
- `GET /export/csv?entity=` — records, sales, expenses
- `POST /import/json` — replaces all data, behind an explicit confirmation

**Health**
- `GET /health` — liveness, for the host

Errors return RFC 7807 problem details with a machine-readable `code`, because the
client must distinguish "retry this" from "this will never work" when draining the
outbox.

---

## 8. Auth and security

One user, but the API is on the public internet, so:

- Password hashed with Argon2id. No default password — it is set on first run via
  an environment variable or a one-time setup route that disables itself.
- JWT access tokens, 30 minutes. Refresh tokens 30 days, rotated on use, stored
  server-side so they can be revoked.
- **Tokens must survive offline periods.** If the refresh token expires while
  offline, the app keeps working locally and prompts for login only when it next
  reaches the server. Never wipe local data on an auth failure.
- HTTPS only, HSTS on. CORS restricted to the app's origin.
- Rate limit `/auth/login` — 5 attempts per 15 minutes per IP.
- Secrets from environment variables. Never committed.

**Section 21 makes all of the above conditional on `AUTH_ENABLED`, which
defaults to false.** Everything in this section is what happens when it is
true; 21.2 says plainly what the default costs, and 21.3 lists the three things
that stay on either way.

---

## 9. PWA

- **Manifest** with name, icons at 192px and 512px, `display: standalone`, theme
  colour `#154212`, background `#F4F7F2`.
- **Service worker** caching the app shell for instant offline start. Cache-first
  for assets, and no network dependency for any screen.
- **Bundle fonts locally.** Inter and JetBrains Mono are served from the app, never
  from Google Fonts. Same for icons.
- **Install prompt** offered once, after the user has added their first record —
  not on first open, when they have no reason to want it.
- **Update handling:** a new service worker shows a small "Update available" bar
  rather than reloading under the user's hands mid-entry.

---

## 10. Deployment

- Railway, two services: the FastAPI app and managed Postgres.
- **Pinned runtimes: Python 3.12 and PostgreSQL 16.** Development runs on
  Python 3.10 and PostgreSQL 14, so the gap is deliberate and worth stating:
  deploy is the newer pair, and anything that depends on a version difference
  has to be caught in CI rather than locally. Do not let the deployed versions
  drift without changing this line.
- Alembic migrations run automatically on deploy.
- Config from environment: `DATABASE_URL`, `JWT_SECRET`, `ALLOWED_ORIGINS`,
  `INITIAL_PASSWORD_HASH`.
- **Automated daily database backups, retained 30 days.** Confirm the host's
  backups are actually enabled — do not assume.
- Structured JSON logging. Log every sync conflict and every clamped negative
  count; these are how you find out the sync logic is wrong.
- `GET /health` wired to the host's health check.

---

## 11. Screens

Fourteen, matching `screenshots/`:

Rooms (home) · Room detail · Record detail · Animals list · Move · Add or
purchase · Sell · Log death · Alerts · Calendar · Health · Money summary ·
Expenses · More

Money later gained a second tab, Analytics (19). It is a tab rather than a
fifteenth screen and rather than a sixth destination — see 19.4.

Navigation: **Rooms · Animals · Calendar · Money · More** — bottom bar on mobile,
left sidebar on desktop. One shared navigation component. The mockups show three
different bars because each screen was generated separately; that is an artefact,
not a requirement.

Five destinations, fourteen screens, so nine screens are reached from somewhere
other than the bar. Two of them are whole screens rather than details of a
record, and how they are reached is a decision, not an oversight:

- **Alerts** — from the alert count in the Rooms summary, and from each urgent
  banner on Rooms, which opens the room it names. Alerts is where you go when
  something is already wrong, so it hangs off the screen that tells you so.
- **Health** — from any record, and from More. A treatment is always about a
  particular animal, so the path through a record is the primary one; More
  carries the entry for reaching the whole list cold.

Neither is added to the bottom bar. Five is the number, and Rooms, Animals,
Calendar, Money and More are the five.

Section 20.15 reopens this for Stores, which is a daily screen during harvest
rather than a place you go when something is wrong. That question is open, not
settled — see 20.16.

---

## 12. Known mockup defects

Do not reproduce these:

- **Species icons are wrong throughout.** Material Symbols has no livestock, so the
  mockups show a tractor for cattle, a rat for pigs, a bug for the birds, a bee for
  sheep. See TOKENS.md.
- **Sample data uses banned words** — "Pasture A", "Barn 2", "Pen 3" in dropdown
  options. Replace with the ten real rooms.
- **Two screens invented their own navigation**, one with a "Genetics" tab that is
  not part of this app.
- **One Record Detail file reverted to "Pen"** where the corrected one says "Room".
  The corrected one is right.
- **Tailwind from a CDN, fonts from Google.** Both must be local and bundled.
- Invalid classes: `min-w-[touch_target_min]`, an `@apply` block inside a plain
  `<style>` tag, `Active: scale-95`.
- Mockups show an account icon in the top bar. There is one user and no profile
  screen — remove it.

---

## 13. Treatment schedules

### 13.1 The problem

Today a treatment's next due date is typed by hand, one at a time. Forget to
type it and no reminder ever appears. The app records what was done; it does not
know what is needed.

A schedule turns that around. It is a rule — *this species, at this age or on
this interval, needs this treatment* — set up once and applied automatically to
every animal it fits. Add a calf and its first year of treatments appears
without anyone entering a date.

### 13.2 TreatmentSchedule (state entity)

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | e.g. "Foot and mouth vaccination" |
| `species` | enum \| `all` | yes | Which species this applies to |
| `type` | enum | yes | Same set as HealthRecord: `vaccination`, `deworming`, `treatment`, `vitamin`, `other` |
| `first_due_age_days` | integer | no | Days after birth or arrival for the first dose. Null means interval-only |
| `repeat_every_days` | integer | no | Days between doses after the first. Null means one-off |
| `applies_to` | enum | yes | `animals`, `groups`, `both` |
| `default_product` | string | no | Pre-fills the treatment form |
| `default_withdrawal_days` | integer | no | Pre-fills the treatment form |
| `is_active` | boolean | yes | Archived rather than deleted |
| `notes` | text | no | |

A schedule with only `first_due_age_days` fires once. One with only
`repeat_every_days` fires every N days from birth or arrival. One with both
fires first at the age, then repeats.

### 13.3 Computing what is due

For every active record, for every active schedule matching its species and kind:

- **If no treatment against this schedule exists** — due date is the record's
  date of birth (animals) or arrival date (groups), plus `first_due_age_days`.
  If `first_due_age_days` is null, use `repeat_every_days`.
- **If a treatment against this schedule exists** — due date is the date of the
  most recent such treatment, plus `repeat_every_days`. If `repeat_every_days`
  is null, nothing further is due.

**Intervals count from what actually happened, not from the plan.** Deworm on
the 7th when it was due on the 10th, and the next one counts from the 7th. The
plan is a guide; the animal's real history is the truth.

**HealthRecord gains `schedule_id`** (nullable). A treatment logged from a due
item carries the schedule it satisfies. An ad-hoc treatment — a sick animal —
has it null and does not disturb any schedule.

### 13.4 When the date of birth is unknown

This is the failure mode that matters, because it is silent.

If a record has no date of birth (animals) or no arrival date (groups), age
cannot be computed and **no schedule fires**. The app must not simply stay quiet.

- The record shows a chip reading **"Age unknown — no schedule"**, in words.
- An alert appears under **This week**: "N animals have no date of birth, so
  their treatment schedule cannot run."
- The Animals list gains a filter for it.

Do not guess a date, and do not silently substitute the date the record was
created. A wrong age produces a wrong schedule, which is worse than none.

### 13.5 Seeded schedules

The app ships with a starter set the user edits. Seeding nothing means the
feature is invisible; seeding a fixed set that cannot be changed is worse.

Suggested starting set — **these are a starting point, not veterinary advice,
and the app must say so.** Show a one-line note on the schedules screen: *"These
are starting suggestions. Check them against your vet's advice for your area."*

| Species | Treatment | First due | Repeats |
|---|---|---|---|
| Cattle | Foot and mouth vaccination | 4 months | every 6 months |
| Cattle | Deworming | 2 months | every 3 months |
| Goats | PPR vaccination | 3 months | every 12 months |
| Goats | Deworming | 1 month | every 3 months |
| Sheep | Deworming | 1 month | every 3 months |
| Pigs | Deworming | 2 months | every 3 months |
| All birds | Newcastle vaccination | 7 days | every 3 months |
| All birds | Gumboro vaccination | 14 days | one-off |

All are editable and archivable from day one.

### 13.6 Screens

**Manage schedules** — reached from More. A list grouped by species, each row
showing name, timing in words ("First at 4 months, then every 6 months"), and
how many active records it currently applies to. Add, edit, archive. The
veterinary-advice note sits at the top.

**Health → Due** already groups by Overdue, This week, This month. Scheduled
items appear alongside manually-dated ones, each carrying a small chip naming
its schedule so it is clear where the date came from.

**Record detail → Health tab** gains an upcoming section: what this animal is
due for and when, from its schedules.

---

## 14. Vet visits

### 14.1 The problem

A treatment today is one animal and one product. A real visit is one date, one
vet, several animals, some treated and some only looked at, and a single
call-out fee for the lot. None of that fits.

### 14.2 VetVisit (event entity)

| Field | Type | Required | Notes |
|---|---|---|---|
| `date` | date | yes | May be in the future for a planned visit |
| `vet_id` | string | no | Null if not yet decided |
| `status` | enum | yes | `planned` or `completed` |
| `call_out_fee` | integer | no | UGX. The visit fee, separate from any treatment cost |
| `reason` | string | no | Why the vet was called |
| `notes` | text | no | What the vet said, including advice about animals not treated |

**HealthRecord gains `visit_id`** (nullable). Treatments given during a visit
carry it; self-administered treatments do not.

Both working patterns are supported, which matters because the farm uses both:

- **Called out** — create the visit, add treatments as they happen, mark
  completed.
- **Scheduled** — create a planned visit for a future date. It appears on the
  Calendar and in Alerts as it approaches. Treatments are added when it happens.
- **Self-administered** — log a treatment with no visit, exactly as today.

### 14.3 The call-out fee

Split **evenly across the animals seen on that visit**, where "seen" means
having either a treatment or a note against them in that visit. This is a direct
cost, not the head-day allocation of SPEC 4.4 — a call-out is paid per journey,
not per day of feeding.

A visit with a fee but no animals attached leaves the fee unallocated. It still
counts in the farm total, and Money Summary already states that per-record
figures will not sum to the farm figure.

### 14.4 Animals seen but not treated

The visit needs a way to record "the vet looked at this one and said watch it"
without inventing a treatment that never happened.

Add a **VisitNote**: `visit_id`, `record_id`, `note`. It appears in the animal's
health history as an observation, visually distinct from a treatment, and counts
that animal as seen for the fee split.

### 14.5 Screens

**Vet visits** — reached from More and from Health. A list by date, planned
visits first. Each row: date, vet name, how many animals, the fee.

**Visit detail** — the vet, date, reason, fee, notes, and the list of animals
seen. Add a treatment or a note against any animal from here. One yellow button:
"Add treatment".

**Record detail → Health tab** shows visit-linked treatments with the vet's
name, and visit notes as observations.

**Calendar** shows planned visits.

---

## 15. Sale readiness

### 15.1 The rule

Each species carries a **target sale age**. When a record reaches it, the app
says so. That is the whole feature — deliberately simpler than a cost-based or
market-based judgement, both of which need data the app does not have.

### 15.2 SaleTarget (state entity)

`species`, `target_age_days`, `label` (e.g. "Ready for market"), `is_active`.

**Record gains `sale_target_override_days`** (nullable) — for the animal you are
keeping for breeding, or the one going early.

Suggested seeded defaults, editable:

| Species | Target |
|---|---|
| Hens (broiler) | 6 weeks |
| Ducks | 8 weeks |
| Geese | 12 weeks |
| Turkeys | 16 weeks |
| Pigs | 6 months |
| Goats | 12 months |
| Sheep | 12 months |
| Cattle | 24 months |

The four bird figures are the reason `poultry` had to be split (18). One value
could carry only one number, and the one it carried — six weeks — is a broiler
hen's. A goose held to it would have been called ready to sell at roughly a
third of its market age, every time, with nothing on screen suggesting the
figure was about a different bird.

### 15.3 Behaviour

- Record detail shows **"Ready to sell in 12 days"**, or **"Ready to sell"** in
  green once reached, or nothing where age is unknown.
- Alerts gains **"N animals are ready to sell"** under *This week*, tapping
  through to the filtered list.
- Animals list gains a **Ready to sell** filter chip.
- Age unknown means no readiness figure — same silent-failure rule as 13.4, and
  covered by the same alert.

Never blocks or prompts a sale. It is information, not instruction.

---

## 16. What this changes elsewhere

- **Date of birth becomes load-bearing.** Sections 13 and 15 both depend on it.
  It stays optional to enter, but its absence is now surfaced rather than
  ignored.
- **Alerts (SPEC 4.6)** gains three conditions: scheduled treatment due,
  animals ready to sell, records with no date of birth.
- **Calendar (SPEC 4.7)** gains scheduled treatments and planned vet visits.
- **More** gains Manage schedules, Sale targets, and Vet visits.
- **Money** — visit call-out fees are a new direct cost alongside treatment
  costs.
- **Sync** — TreatmentSchedule, SaleTarget, VetVisit and VisitNote follow the
  existing rules of SPEC 3.2 and 5.4.

  **Schedules, sale targets and vet visits are state entities** with per-field
  last-write-wins. **Visit notes are events**, append-only.

  A visit is a state entity even though it records something that happened,
  which is worth stating plainly because an earlier draft of this section had it
  as an event. It cannot be one. Section 14.2 gives a visit a `status` that
  moves from `planned` to `completed`, and describes the working pattern as
  "create the visit, add treatments as they happen, mark completed" — marking
  completed is an edit to a row that already exists. So are the two things the
  vet leaves behind: the call-out fee and what the vet said are both written
  afterwards. An append-only visit would turn each of those into a *new* visit,
  so a single call-out would be counted several times and its fee split several
  times over (14.3).

  Per-field merging is also what the work needs. One person marking a visit
  completed while another types up the vet's advice must not cost each other
  their edit, which is exactly what SPEC 5.4 is for.

  A visit note has none of that: it is written once, about one animal, on one
  visit, and corrected by adding another note rather than by editing. It is an
  event, and two devices noting the same animal keep both notes.

  Seeded schedules and sale targets need fixed ids in both the migration and the
  client seed, exactly as the ten rooms do, or two devices seeding offline
  produce duplicates.

---

## 17. Still not built, and named here so it stays visible

- ~~**Birth records.**~~ **Built — see section 22.** It was the main reason a
  date of birth went missing, which is what broke sections 13 and 15. An animal
  born here now carries an exact date of birth, its mother and its father; a
  loss at birth is a Death with cause `stillbirth` rather than nothing at all.
  What remains unfixed is the herd that predates it: no date of birth can be
  recovered for a record that never had one (22.7).
- **Customers and vets are not linked.** A sale stores the buyer as free text,
  so customer history does not work. Section 14 links vets to visits; sales
  still need the same treatment.
- **Partial payment.** A sale is one price on one date. A buyer paying half now
  and half next month has nowhere to go, and the profit figures will be wrong
  until it does.
- **Feed quantity.** Feed is tracked as cost, not as bags in and out. You know
  what you spent, not what you used.

---

## 18. The four birds

### 18.1 The problem

`poultry` was one species covering hens, ducks, geese and turkeys. They are not
one thing. They mature at different rates, so they reach market at different
ages, and the single seeded sale target of six weeks (15.2) is a broiler hen's —
right for at most one of the four and quietly wrong for the rest. A goose held
to it is called ready to sell at roughly a third of its market age, every time,
and nothing on screen suggests the number was about a different bird.

The same flattening ran through the rest of the app. A room of hens and a room
of geese both read "Poultry". The Animals filter could not narrow to ducks. Any
money figure broken down by species lumped the lot together.

### 18.2 The enum

`cattle`, `goats`, `sheep`, `pigs`, `hens`, `ducks`, `geese`, `turkeys`.

Mammals first, then birds, each in that order. **This order is the display order
everywhere** — filter chips, list sections, the census — and there is exactly one
runtime list of it, `ALL_SPECIES` in `domain/rules.ts`. Five screens each carried
their own copy before, which is five places to forget when the enum changes, and
precisely how a filter row ends up silently missing a species that records can
still be created with. Screens import the list; they never write one.

`MAMMAL_SPECIES` is derived by subtracting the birds, so adding a species cannot
leave it behind.

### 18.3 Migrating the existing rows

Three kinds of row carried the retired value, and they do not all go to the same
place.

| Row | Becomes | Why |
|---|---|---|
| Record | `hens` | The commonest bird, and the one the old six-week target already described |
| Treatment schedule | `birds` | A rule about the category, which still applies to all four |
| Expense tagged to the species | `hens` | Follows the records it allocates to |

Sending the schedules to `hens` with the records would **silently stop
vaccinating the ducks** — the exact quiet gap 13.1 exists to close. Leaving the
expenses behind would allocate the birds' feed bill to a species no record has,
so its whole cost would drop out of every estimated share (4.4): not visibly
wrong, just gone.

Soft-deleted, sold and dead records are migrated too. They stay readable under
the "Sold or dead" filter (4.8), and a value no longer in the enum breaks every
screen that reads one back.

**`seq` is advanced; `updated_at` is not.** The first is what makes an already
synced device pull the correction. The second is what stops the migration
winning a race it has no business winning: these rows merge last-write-wins per
field (5.4), so a farmer who has already corrected a pen of ducks by hand keeps
that correction.

**Moving a record to `hens` is a guess**, and the app must not pretend otherwise.
The number of rows moved is reported in the server migration's output and stored
on the device, and the Animals screen says it once: *"N records moved from
Poultry to Hens."* A migration that silently retyped part of the flock and
mentioned it nowhere would be indistinguishable from data loss — the records
would still be there, saying the wrong thing, with nothing ever prompting anyone
to look.

### 18.4 `birds` as a schedule scope

`TreatmentSchedule.species` accepts `all`, one species, or `birds`.

The alternative was four copies of every bird schedule, which is a worse trap
than the one being fixed: changing the Newcastle interval becomes four edits
that have to agree, and a farmer who updates three of them gets a schedule
firing differently for ducks than for hens with nothing on screen explaining
why. One row keeps one interval to edit, and keeps the seeded IDs stable, so an
interval already edited survives the split (16).

It is labelled **"All birds"** rather than "Birds", because on the manage
schedules screen the four are also choosable individually and the row needs to
read as a rule about a group rather than as a species alongside Hens.

### 18.5 A room of birds is not a mixed room

4.2 now reads: two or more species → `Mixed`, **unless every species present is
a bird**, in which case `Birds`.

Without this the split would have quietly relabelled rooms. A room that read
"Poultry" yesterday holds hens and ducks today and would read "Mixed" — the word
for cattle sharing with goats, a warning that unlike animals are together. Four
kinds of bird in one room is the ordinary case it was never about. Mixed still
means mixed for everything else, including one bird species housed with a mammal.

### 18.6 Eight species on a 390px screen

Two changes, and only together do they work.

**The chips wrap.** The filter row scrolled horizontally, and measured on a
390px viewport it wanted 462px of chips inside a 358px box. Pigs was clipped and
the last species sat entirely off the edge, reachable only by dragging a strip
that gives no sign there is anything further along. That was already true before
the split — the species at the end had stopped existing for anyone who did not
think to swipe. Wrapping costs a second line and makes every species visible
without having to be discovered.

**The birds collapse into one chip**, opening into a further row when chosen:

```
All · Cattle · Goats · Sheep          ← wraps
Pigs · Birds
        All birds · Hens · Ducks · Geese     ← only while Birds is chosen
        Turkeys
```

Wrapping alone would have left nine chips over three lines, pushing the list
itself off the first screen. Together they fit six on two lines. Measured on a
390px viewport: every chip fully visible, no horizontal overflow, 48px touch
targets.

The Birds chip stays active while one of the four is selected, so the second row
never appears to belong to nothing, and it never appears at all for a farm that
keeps no birds.

`birds` is a real filter value, not just a heading: "show me the birds" is worth
asking on a farm keeping four kinds, and the old single `poultry` value could
answer it only by accident.

---

## 19. Analytics

A second tab on Money, answering what the farm holds and what it has cost and
earned. Three parts.

### 19.1 Headcount census

Every species with live head, and a farm total:

```
Cattle 7 · Pigs 2 · Hens 240
```

**Head counts, never percentages** (4.2). Animals and groups are both counted by
head — one cow is one head, a flock of 240 hens is 240. Each row also names how
many records those head are spread across, because one flock of 240 and 240
single birds are the same headcount and a very different farm.

A species with no live head is left out rather than shown as zero. A farm that
has never kept geese should not have to read a line telling it so, and one that
sold its last goose last month is told by the line's absence rather than by a
zero that reads like a mistake.

**One counting rule, taking a date.** `censusAsAt(date, …)` is the only count;
"right now" is that function asked for today, not a second and simpler version
of it. This is the whole design of the module. A live count and an as-at count
that can drift apart produce two screens disagreeing about how many hens the
farm has, with no way for a reader to tell which is lying.

The rule is the server's own, from `app/domain/reconcile.py`, with a date bound
added to each term:

```
head = initial_head_count − sold − died − split away        (clamped at zero)
```

Everything the app knows about a count is an event carrying a date, which is
what makes the as-at view cheap: no snapshots and no history table, just the
same subtraction with `<= asAt` on each part. The clamp is 6.7: two offline
devices can each sell 5 head from a group of 8, both sales are real and both are
kept, so the count floors at zero and the anomaly is raised on the server.

The date bound on *splits* is the subtle part. A split moves head to a child
record with its own history (4.3), so before the split date the head was still
on the parent, and that is where a past census must count it. Subtracting every
child regardless of date would show a group already short of head it had not yet
lost.

### 19.2 Money by species

For the chosen period, per species: **spent** on purchases, **earned** on sales,
and the **difference**, with a farm total row.

**Laid out as a list, not a table.** Four columns measured 462px of content in a
358px box on a 390px screen, which put Difference — the one figure the screen is
opened for — off the right edge behind an inner scrollbar nobody knows is there.
Each species is a stacked row instead: the difference leads on the right, the
counts sit under the name, and the two exact figures it came from sit beneath.
No horizontal scrolling anywhere.

These are exact. Purchases and sales belong to a record directly and carry their
own price, so nothing here is allocated and none of it needs the "estimated"
labelling 4.4 requires.

**The difference is not profit, and the screen says so in words.** It carries no
expenses, no treatment costs and no call-out fees, because none of those can be
pinned on a species exactly (4.4). A farmer reading `+2,400,000` beside Hens and
taking it as what the hens made would be wrong by the whole feed bill. The
summary tab keeps the exact farm profit and the estimated per-record figures;
this tab points at it.

Money on a purchase or sale whose record cannot be found is reported as its own
line rather than dropped. Records are only ever soft-deleted (4.8) so it should
always be zero, but a table of money that quietly does not add up is worse than
one that names its remainder.

### 19.3 Counts beside the money

Every money row also carries `4 bought, 2 sold`.

Without them a single UGX 4M bull reads exactly like forty hens at 100,000 each.
The money alone cannot tell those apart, and they are entirely different pieces
of news.

### 19.4 Where it lives

**A tab on Money, not a sixth destination.** 11 fixes five and means it.

Analytics belongs with Money on the merits rather than by elimination: both read
sales and purchases, both are asked over a period, and the period selector is
the same control. The period lives above both tabs, so switching keeps it —
someone who set five years to look at the census does not want the money table
answering for twelve months instead.

The tab is in the URL (`/money` and `/money/analytics`), so the back button
leaves Analytics rather than the whole screen, and a reload lands where it was.
`/money/*` is a single route, which is what keeps the shell mounted, and the
chosen period alive, as the tabs swap underneath it.

### 19.5 What this shares

Nothing here re-derives a figure that already exists.

- `domain/period.ts` — the window, the membership test and the wording. Two
  screens each working out their own range is how they end up reporting
  different periods under an identical label.
- `domain/money.ts` — `farmMoney` is 4.5's farm figure, now read by both tabs
  rather than summed inside the summary screen.
- `domain/census.ts` — the counting rule above.
- `components/PeriodSelector.tsx` — one selector, so both tabs always offer the
  same choices.

---

*Merged from `SPEC-STORES.md`. Everything already in this document still applies
to section 20 — client-generated ULIDs, event-versus-state entities,
offline-first sync, head counts never percentages, one yellow button per screen,
and colour never carrying meaning alone.*

## 20. Stores and produce

### 20.1 What this is

The farm has two stores holding harvested and bought produce — coffee, maize and
beans. The app must answer: how many sacks are in each store, what they weigh,
what has left and why, what was sold and for how much, and what came in and
where it came from.

This is a **second inventory running alongside the livestock one**. It shares
the app, the sync engine, the design language and the money figures. It does not
share the data model. Produce is measured in kilograms and sacks; animals are
counted in head. Conflating the two corrupts both.

### 20.2 Vocabulary

| Use | Never use |
|---|---|
| **Store** | warehouse, granary, silo, room |
| **Produce** | crop, goods, commodity |
| **Sack** | bag, bale bag |
| **Intake** | delivery, receipt, stock-in |
| **Outtake** | withdrawal, issue, stock-out |
| **Stock count** | audit, stock-take |

**A store is not a Room.** Do not reuse the Room entity. Rooms have a capacity in
head, a species type and animals inside them; putting sacks in one would corrupt
occupancy, room type derivation and every alert that reads them.

### 20.3 Store (state entity)

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | string | yes | `S1`, `S2`. Unique. Displayed in mono |
| `name` | string | yes | Plain name, e.g. "Upper store" |
| `capacity_sacks` | integer | no | Optional. Warns when exceeded, never blocks |
| `notes` | text | no | |

Seeded with two stores at fixed ids, the same pattern as the ten rooms —
identical in the migration and the client seed, or two devices seeding offline
produce four stores.

### 20.4 ProduceType (state entity)

`name` (required, unique), `is_active`, `notes`.

**Seeded with Coffee, Maize and Beans**, at fixed ids, and the user can add more
— groundnuts, matooke, whatever the farm grows next. Never a hardcoded enum.
This is the mistake the species enum made, which then took a nine-file migration
to undo.

### 20.5 StockIntake (event)

Produce arriving in a store.

| Field | Type | Required | Notes |
|---|---|---|---|
| `store_id` | string | yes | |
| `produce_type_id` | string | yes | |
| `date` | date | yes | Defaults to today |
| `sacks` | integer | no | How many sacks |
| `kg` | number | yes | Total weight |
| `source` | enum | yes | `garden` or `bought` |
| `garden_name` | string | no | Which garden, when source is garden |
| `seller` | string | no | When source is bought |
| `customer_id` | string | no | Optional link to a Customer, when bought from a known supplier |
| `cost` | integer | no | UGX. Required when source is `bought`, absent when `garden` |
| `harvest_label` | string | no | Free text, e.g. "March 2026". See 20.16 Q2 |
| `notes` | text | no | |

`harvest_label` is a **label, not a lot**. It records which harvest a delivery
came from without giving it a separate balance or valuation, because nothing can
say which physical kilograms later left a pooled store. It costs nothing at
entry and accrues from day one, so a farm that later needs true lots has
labelled intake history to seed them from.

### 20.6 StockOuttake (event)

Produce leaving a store.

| Field | Type | Required | Notes |
|---|---|---|---|
| `store_id` | string | yes | |
| `produce_type_id` | string | yes | |
| `date` | date | yes | Defaults to today |
| `sacks` | integer | no | |
| `kg` | number | yes | |
| `reason` | enum | yes | See below |
| `price_basis` | enum | no | `kg` or `sack`. What was negotiated. Only when `sold` |
| `unit_price` | integer | no | UGX per kg or per sack, per `price_basis`. Only when `sold` |
| `total_price` | integer | no | UGX. **The stored truth.** Only when `sold` |
| `customer_id` | string | no | The buyer, when sold |
| `to_store_id` | string | no | Only when reason is `moved` |
| `notes` | text | no | |

**`total_price` is authoritative; `unit_price` is what was typed.** A sale
negotiated per sack must not be back-computed into a price per kilogram — 20.8
forbids deriving either quantity from the other, and a farm may well sell coffee
by the kilogram and maize by the sack. The form offers a per kg / per sack
toggle, multiplies out, and stores the total. Every money figure reads the
total, so none of them depends on how the deal was worded.

**Reasons:** `sold`, `home_use`, `seed`, `gift`, `spoiled`, `processing`,
`moved`, `other`. A reason is always required — "what left the store and why" is
the whole point of the feature, and an unexplained outtake is a hole in the
records.

**Moving between the two stores** is one outtake with reason `moved` and a
`to_store_id`, which the app mirrors as a matching intake in the destination.
Both carry the same date and quantities. The pair must be created in one
transaction so a half-completed move can't leave produce in neither store.

### 20.7 StockCount (event)

A physical count, reconciling the ledger against what is actually in the store.

`store_id`, `produce_type_id`, `date`, `counted_sacks`, `counted_kg`, `notes`.

**This is not optional decoration.** Coffee loses weight as it dries, beans are
taken by weevils, and sacks get miscounted. Without a stock count the ledger
drifts from reality and there is no honest way to correct it — people would
otherwise invent a fake outtake, which pollutes the reasons that make this
feature useful.

The difference between the counted figure and the derived balance is the
**variance**. It is displayed in words, never silently absorbed:
*"Counted 43 sacks, ledger says 47 — 4 sacks short."*

### 20.8 The balance is derived, never stored

For each `(store_id, produce_type_id)`:

```
sacks = Σ intake.sacks − Σ outtake.sacks, adjusted by the latest stock count
kg    = Σ intake.kg    − Σ outtake.kg,    adjusted by the latest stock count
```

A stock count resets the running total to the counted figure from its date
onward. Events after it accumulate from there.

Same rule as `head_count` in SPEC 3.4: **computed from events, never synced as a
field.** Two devices selling from the same store offline would otherwise each
push their own arithmetic and the later one would erase a real sale.

**Sacks and kilograms are tracked independently. Neither is derived from the
other.** A sack of coffee and a sack of maize weigh different amounts, and two
sacks of the same coffee are not identical. The app may display an average sack
weight as information — *"about 62 kg per sack"* — but must never compute one
figure from the other or use an assumed sack weight anywhere.

`kg` is required on every event; `sacks` is optional. Weight is what gets sold
and what determines value; sacks are a physical count for checking the store.
If sacks are entered on some events and not others, the sack balance is marked
**"partial"** on screen rather than shown as though it were complete.

### 20.9 What produce is worth

**Weighted average cost per kilogram**, per store per produce type.

- **Bought produce** enters at its purchase cost.
- **Garden produce enters at zero cost.** Growing it cost money — labour, seed,
  fertiliser — but those are already recorded as Expenses. Giving it a second
  notional cost here would count the same money twice and understate the farm's
  profit.

State this on screen in words wherever a produce value appears. A figure that
looks like a valuation but isn't one is exactly the failure the head-day
allocation was built to avoid.

### 20.10 Money

Produce money joins the farm's figures, broken out rather than blended:

- **A `sold` outtake is income.** It appears in the farm profit and loss for its
  period, and gets its own row in Money → Analytics beside the species.
- **A `bought` intake is a cost**, the same way an animal purchase is.
- **Garden intakes are neither.** They add stock at zero cost.
- **Money → Analytics** gains a Produce section: for each type, kilograms in,
  kilograms out, spent, earned, difference.
- **The census in Analytics** gains produce alongside the headcount — *"Coffee
  1,240 kg · Maize 380 kg"* — using the same date-bounded replay so there is one
  counting rule, not two.

Outtakes for `home_use`, `seed`, `gift` and `spoiled` earn nothing, and their
value at average cost is shown on the produce row: *"186 kg left without being
sold, 186 kg of it spoiled — about UGX 150,000 at what it cost."*

The average is drawn from **every** purchase rather than the period's, because
produce bought last year and eaten this year cost what it cost; re-deriving it
from one period's purchases would price this year's spoilage off sacks that had
nothing to do with it. Where nothing was ever bought the weight is shown with no
value, because then the cost is unknown rather than zero — and a loss reported
as "UGX 0" reads as no loss at all.

**A move is not produce leaving the farm.** It is excluded from weight out
entirely: the mirrored intake has already added it back, so counting it would
double the weight and report a loss that never happened.

Head and kilograms are never added together. The census shows "what the farm
holds" in head and "what the stores hold" in kilograms as two sections, because
a total across both would mean nothing.

### 20.11 Screens

**Stores** — the entry point. Each store as a card: code, name, and a line per
produce type showing sacks and kilograms. A store holding nothing says so. Under
the cards, a farm total per produce type across both stores.

**Store detail** — what's in this store, one row per produce type with the
current balance, average sack weight, and value at average cost clearly labelled
as an estimate. Two tabs: **Stock** and **History**. History is every intake,
outtake and count in date order, each showing quantity, reason and money where
there is any. One yellow button: **"Take out"**, since removing stock is the
frequent action.

**Add stock** — store, produce type, date defaulting to today, sacks, kilograms,
then source as two large cards: **From garden** or **Bought**. Garden reveals the
garden name. Bought reveals cost and seller, with the seller selectable from
Customers or created inline.

**Take out stock** — store, produce type, date, sacks, kilograms, then reason as
pill chips. Choosing **Sold** reveals price per kilogram, with the total computed
and shown large as it is typed, plus the buyer from Customers or created inline.
Choosing **Moved** reveals the destination store. All other reasons need only a
note. Above the quantity field, show what is currently in the store, so nobody
has to remember.

**Stock count** — pick store and produce type, see the ledger balance, enter what
was actually counted, and see the variance stated in words before confirming.

**Manage stores** and **Manage produce types** — under More.

### 20.12 Alerts

Added to the existing rules in `domain/alerts.ts`, not derived separately:

| Alert | Condition | Priority |
|---|---|---|
| Store balance went negative | An outtake took a balance below zero | Urgent |
| Store over capacity | Sacks exceed `capacity_sacks` | This week |
| No stock count in 90 days | Per store and produce type, where stock exists | Later |
| Large variance | A stock count differs from the ledger by more than 10% | This week |

### 20.13 Sync

Stores and produce types are **state** entities with per-field last-write-wins.
Intakes, outtakes and stock counts are **events**, append-only.

**Note the `record_id` trap.** `_apply_event` in `backend/app/sync.py` previously
read `fields["record_id"]` unconditionally, which crashed on expenses and killed
whole batches. Stock events have no `record_id` either. That was fixed during
Batch D — confirm the fix covers these new tables rather than assuming.

### 20.14 Edge cases

**20.14.1 Taking out more than is there.** Warn before confirming, naming the
current balance, but allow it — the produce may physically be there when the
ledger is wrong. The balance clamps at zero, both events are kept, and an alert
is raised. Same rule as SPEC 6.7 for oversold groups.

**20.14.2 Two devices selling the same stock offline.** Both outtakes are kept.
Neither is rejected — data already entered offline is never thrown away. The
balance clamps and the alert names the store.

**20.14.3 Sacks entered on some events but not others.** The sack balance is
shown with a **"partial"** label. Kilograms remain exact.

**20.14.4 A stock count that finds more than the ledger.** Perfectly normal, and
handled identically to finding less. The variance reads *"4 sacks more than the
ledger"*.

**20.14.5 Deleting a store or produce type with stock.** Blocked while a balance
exists. Offer to move the stock first. Produce types with history are archived,
never deleted.

**20.14.6 Future dates.** Intakes, outtakes and counts cannot be dated in the
future. Backdating to any date up to today is allowed and recomputes the
balance.

**20.14.7 Moving to the same store.** The current store is not selectable as a
destination.

**20.14.8 A move where the mirrored intake fails.** Impossible by construction —
outtake and intake are written in one transaction, or neither is.

### 20.15 Where it lives in the navigation

**A sixth item, Stores**, between Animals and Calendar.

SPEC 11 fixes five destinations and says "five is the number". That was written
when the app held only livestock. During harvest this is a daily screen, and
burying a daily screen under More costs more than a sixth tab does.

Measured in Chrome before it went in, rather than estimated — the species chips
looked fine by estimate and were 100px too wide when checked:

| Viewport | Tab width | Widest label | Clipped | Tap height |
|---|---|---|---|---|
| 390px | 65px | Calendar, 62px | none | 62px |
| 360px | 60px | Calendar, 62px | none | 62px |
| 320px | 51px | Calendar, 62px | none | 62px |

Six fits, with room to spare at 390px and none clipped even at 320px. `Calendar`
is the constraint; a seventh destination, or a label longer than it, would need
measuring again rather than assuming.

### 20.16 Decisions

Answered before Batch G. Recorded here with their reasoning, because each one
is cheaper to understand than to rediscover.

**1. Price entry — a toggle, with the total stored.** Sales may be negotiated
per kilogram or per sack, so the form offers both and stores `total_price`. See
20.6.

**2. Produce is pooled, not held in lots.** One balance per store per produce
type at weighted average cost, plus a free-text `harvest_label` on intakes
(20.5).

The cost of this choice is that the weighted average blends harvests: the app
cannot say what the March coffee fetched against the September coffee.

The cost of the alternative was higher. Lots need an allocation from each
outtake to the lots it drew from — a many-to-many relationship this app has
nowhere else — and a mandatory lot picker on the action 20.11 names as the
frequent one. More seriously, lot balances are only honest if the lots are
physically separable in the store; co-mingled sacks would make them precise-
looking fiction, which is the failure 20.9 and 4.4 exist to refuse.

Reversibility is asymmetric and was the deciding factor. Lots collapse to pooled
for free. Pooled expands to lots mechanically in code, but **the history does not
come with it** — nothing can retroactively say which kilograms left in June — so
lots would begin from the switchover date. `harvest_label` is the hedge: it costs
nothing now and leaves labelled intake history to seed lots from later.

**3. One farm profit figure, with produce broken out.** Produce sales and bought
intakes join 4.5's farm total; produce also gets its own line and its own
Analytics section. Excluding it would make the headline wrong in exactly the
season it matters most.

Expect the farm figure to swing sharply positive when garden produce is sold:
it entered at zero cost (20.9) because growing it was already recorded as
Expenses, so the whole sale price lands with no matching cost. That is correct
rather than double-counted, and **the screen must say so in words.**

**4. Typical sack weights — set in the app, not hardcoded.** The farm enters
them per produce type and they ship empty. See 20.17.

### 20.17 Typical sack weight

`ProduceType` carries an optional `typical_sack_kg`, edited on **Manage produce
types**. It ships empty for every type.

**The farm sets it, and the app never guesses it.** A seeded default would be a
number nobody chose, quietly deciding what counts as a typo on somebody else's
scales — and a wrong one is worse than none, because it starts questioning
entries that are correct.

**It is used for exactly one thing.** When an intake or outtake records **both**
sacks and kilograms, and the implied weight per sack is more than half away from
the typical figure in either direction, the form says so in words, naming both
numbers:

> That is about 600 kg per sack. Coffee is usually around 60 kg. Is that right?

The threshold is deliberately wide. Sacks vary, a half-full one is a real thing,
and a warning that fires on an ordinary load is one people learn to scroll past —
at which point it catches nothing.

**It warns and never blocks.** The confirm button stays enabled. The farm knows
its own sacks better than the app does, and refusing the entry would push
someone into typing a different number to get past the form, which is worse than
a wrong number they can see.

**Nothing is ever computed from it.** `sackWeightWarning` returns a message or
nothing — never a quantity. The app must never multiply sacks by a typical
weight to fill in a missing kilogram figure, anywhere. 20.8 is the reason: sacks
and kilograms are tracked independently and neither is derived from the other,
because a sack of coffee and a sack of maize weigh different amounts and two
sacks of the same coffee are not identical. A figure invented that way would be
indistinguishable on screen from one somebody weighed.

**With nothing set, nothing changes.** No warning appears, and every other part
of the store screens works exactly as it does now — which is the shipped state,
so it is the case that matters most.

Manage produce types explains all of this above the field. An unexplained
optional number on a settings screen is one people either ignore or fill in
wrongly, and both outcomes are worse than the field not being there.

---

## 21. Authentication as a config flag

### 21.1 The decision

`AUTH_ENABLED` is an environment variable on the backend, **default false**.

- **False** — no password anywhere in the app, no token on the wire. The sync
  engine talks to the API directly.
- **True** — everything behaves exactly as section 8 describes. Same routes,
  same Argon2id hash, same rotating refresh tokens, same 401s.

The auth code, the `users` table, the refresh tokens and the login rate limiter
all stay in place. **Nothing is deleted**, and that is the whole point of doing
it this way: deleting them would make the decision irreversible and a rebuild
would be the only way back. A flag is one variable in the host's dashboard and
a restart.

There was never a login *screen* to remove. Signing in has always lived in the
sync panel behind the chip in the top bar, beside the thing it affects — so
what this actually removes is the password box, and only while the server says
it wants no password.

### 21.2 What this costs, plainly

**With `AUTH_ENABLED` false, anyone who finds the backend URL can read and
write every record.** Purchase prices, sale prices, customers, profit, every
animal and every store. Not read-only: the sync endpoints accept pushes, so a
stranger can also change or delete what is there.

There is no partial protection and no rate limit on that. The URL is the
secret, and a URL is not a secret: it travels in browser history, in server
logs, in a screenshot of the address bar, in whatever the frontend bundle is
served with. Anyone who has ever had the link keeps it after they stop being
somebody the farm trusts.

This is written here rather than softened because the alternative is somebody
discovering it later from the consequences.

### 21.3 What stays on, whatever the flag says

Three things are not conditional, and the reason is the same for all three:
with no token to check, they are what is left.

- **HTTPS only, HSTS on.** More necessary when auth is off, not less — there is
  no token on the wire, so the transport is carrying the farm's whole record in
  whatever the connection provides. In production a request that arrived over
  plain HTTP is refused with code `https_required`, and every response carries
  `Strict-Transport-Security`.
- **`ALLOWED_ORIGINS` restricted to the frontend's origin.** Startup still
  refuses a production deployment where it is unset or still points at
  localhost.
- **The rate limiter on the auth routes.** Five attempts per fifteen minutes
  per IP, still applied to `/auth/login` while it is switched off. An
  unauthenticated deployment is exactly the one whose login route should not be
  free to probe.

`JWT_SECRET` is the one startup check that becomes conditional. With auth off
nothing is signed, and demanding a key to sign nothing would be a boot failure
with no security behind it.

### 21.4 How the client knows

**`GET /config`** — unauthenticated, one boolean: `{"auth_enabled": false}`.

It has to be unauthenticated, because its whole purpose is to say whether a
token is required and a client that needed one to find out could never use the
answer. It carries nothing about the farm.

The client asks on every sync tick and caches the answer, which survives a
restart. Three states, and the third is not a placeholder:

| State | What the sync panel shows |
|---|---|
| `off` | No password box, and the sentence in 21.2 in words |
| `required` | The password box, exactly as today |
| `unknown` | The password box |

`unknown` keeps the box because a device that has never reached the server
cannot tell the two apart, and hiding the only way to sign in is the worse
mistake — it cannot be recovered from the phone, whereas a password box on a
server that wants none merely says so when it is used.

**A 401 from any request sets the state to `required`**, whatever was cached.
That is what makes the flag safe to turn back on: a device that was offline
when it happened discovers it from the first refusal rather than from a support
call.

While the state is `off` the client sends no `Authorization` header at all,
even if it is still holding a token from before. The server ignores a token in
that state rather than refusing it, so a device that signed in last month keeps
working.

### 21.5 Turning it back on

Set `AUTH_ENABLED=true` and `INITIAL_PASSWORD_HASH`, and restart. No rebuild,
no migration, no frontend deploy. The first sync gets a 401, the sync panel
grows its password box again, and local data is untouched throughout — SPEC 8's
rule that an auth failure never wipes a device applies here too.

---

## 22. Birth records

### 22.1 The problem

SPEC 17 named this as the gap that makes two shipped features silently useless,
and it was right: an animal born on this farm had no date of birth, because
nothing recorded the day it was born. With no date of birth its treatment
schedule does not fire (13.4) and its sale readiness does not compute (15.3).
The app went quietest about the animals it should know most about.

Offspring was a number typed by hand. There was no link from a calf to its
mother, no record of how many were born against how many lived, and a loss at
birth had nowhere to go at all — so it went nowhere.

### 22.2 Birth (event entity)

| Field | Type | Required | Notes |
|---|---|---|---|
| `dam_record_id` | string | yes | The mother. A female animal, or a group |
| `sire_record_id` | string | no | A record on this farm |
| `sire_name` | string | no | Free text, for an outside sire |
| `date` | date | yes | Defaults to today. Never in the future |
| `born_count` | integer | yes | 1 or more |
| `surviving_count` | integer | yes | Never more than `born_count` |
| `vet_id` | string | no | |
| `notes` | text | no | |

**An event**: append-only, never edited, corrected by adding (3.2). Two devices
recording the same morning offline both keep their row, and a duplicate is
visible as two births rather than resolved into one wrong one.

Both sire fields may be null. Plenty of births have no recorded father, and
inventing one is worse than a blank.

**Record gains `dam_record_id`, `sire_record_id` and `birth_id`**, all optional
and all set only on an offspring record created from a birth. They are null for
everything bought, given, or already on the farm before this shipped — which is
most of the herd and always will be.

`dam_record_id` and `sire_record_id` are foreign keys; `birth_id` deliberately
is not. The birth row is pushed one operation ahead of the offspring that point
at it, and each operation in a batch lands in its own savepoint (5.2). A
constraint there would turn a reordered or retried batch into a *rejected
offspring record* — the animal lost to keep a link tidy, which is the wrong
trade.

### 22.3 What a birth does, in one transaction

1. **Creates the offspring.** One or two get individual animal records with
   `date_of_birth` set to the birth date, `source = born_here`, species and
   breed inherited from the dam, and sex asked per offspring. More than two are
   recorded as one group instead. The tags are suggested by the same
   sequential-tag helper a group split uses (4.3).
2. **Places them in the dam's current room**, as an initial move with no origin
   (3.5). A dam who is in no room gives her offspring no move rather than an
   invented one.
3. **Where `born_count` exceeds `surviving_count`, writes a Death for the
   difference with cause `stillbirth`.** Losses at birth do not vanish.

All of it or none of it. A tab closed halfway through must not leave a calf
with no date of birth, or a loss with nothing recording it — the two silent
failures this section exists to end.

**Every offspring born gets a record, survivors and losses alike.** The
stillbirth Death has to hang off something, and the only other candidate was
the dam — which would have reduced *her* head count and, for a single animal,
marked the mother dead from her own calf's loss. A record for an animal that
did not live reads strangely for a moment and is the honest shape: it holds one
date, one cause, and it keeps the farm's mortality figures complete.

For a group, the record is created holding `born_count` and the stillbirths
take the difference back out, so its head count **derives** to the surviving
figure rather than being typed (3.4). Nothing anywhere types the surviving
count into a head count column.

### 22.4 Offspring count — one source of truth

The typed `offspring_count` is renamed **`offspring_baseline`**, with
`offspring_updated_at` becoming `offspring_baseline_updated_at`. The values
carry across untouched.

It now means: *what happened before births were recorded in the app*, typed by
somebody who was there. **Nothing in the app ever writes it.** A birth adds a
Birth row and leaves the typed figure exactly as typed.

The total is displayed as its two parts, never as one number:

> Offspring · 5 — 2 typed in (updated 12 Aug 2026) plus 3 from 2 recorded births

Summing them silently would make the typed half unfalsifiable: nobody could
tell which part of a wrong number was wrong. The baseline keeps the
last-updated date it always carried, for the same reason it always had one.

The renaming is not cosmetic. A field still called `offspring_count` that no
longer holds the offspring count is exactly how a screen ends up showing one of
the two numbers and labelling it the other.

**Surviving offspring are what the birth half counts.** A stillbirth is already
in the mortality figures, on its own record and under its own cause; counting
it here as well would have one loss adding to two different totals.

### 22.5 Screens

**Log birth** — a fifteenth screen, reached from Record detail on any female
animal or group, and from the Calendar with the selected day carried through. It
is not a destination on the bottom bar; five is still the number (11), with
Stores the sixth (20.15).

It has to be quick, because it is used standing next to an animal that has just
given birth: the dam, the date, how many born, how many survived, then the
offspring. Everything else defaults to something right most of the time — today,
the dam's species and breed, her room — and the surviving count follows the born
count while they agree, so the ordinary case needs one number rather than two.

**Record detail on a dam** lists her offspring, each tappable, sold and dead
ones included: they are still hers, and leaving them out would disagree with
the total shown above them.

**Record detail on an offspring** shows its dam and sire, tappable, with the
birth's date and how many it was one of. An outside sire is shown as the name
recorded, with nothing to open.

**Calendar** shows births on their date, never as scheduled — a birth is a thing
that happened, and the app has no notion of a due date for one. Tapping it opens
the dam, which is where the offspring are listed.

### 22.6 Rules

- **Only offered on female animals.** A male is not offered it: he did not give
  birth, and the useful thing to do with a sire is name him on the birth. An
  animal whose sex has not been recorded is not offered it either — nothing is
  assumed from an empty field.
- **A group can be the dam** — a hatch — creating a group of offspring. A group
  has no sex because a group is not one animal, and refusing groups to keep the
  rule tidy would mean the hatch could not be recorded at all.
- **A birth cannot precede the dam's own date of birth** (or her arrival date,
  for a group), and cannot be in the future. Both are errors rather than
  warnings: an animal born before its mother is not a judgement call.
- **A dam with no date of birth of her own accepts any past date.** The unknown
  case stays unknown rather than being guessed at, exactly as 13.4 requires
  everywhere else.
- **A dam that is sold or dead can still have a backdated birth logged**, with a
  warning naming the date she left if the birth is after it. A warning and not a
  block: the birth really happened, and refusing it would lose it. Refusing
  would also push somebody into typing a different date to get past the form,
  which is a worse record than a true one with a warning on it.
- **`surviving_count` may be zero.** A birth where nothing lived is a real event
  with real losses to record.
- **Birth is an event**: append-only, never edited. Correct by adding.

### 22.7 What this fixes, and what it does not

Every animal born here from now on has an exact date of birth, so its treatment
schedule fires and its sale readiness computes. Such an animal never enters the
"no date of birth" alert at all — not because the alert was weakened, but
because the date is there from the moment the record is created.

**What the alert still covers is every record somebody typed in without a
date** — bought, given, or born here before this shipped. That is the whole
existing herd, and nothing here backfills it: a date of birth cannot be
recovered from a record that never had one, and guessing it would produce a
wrong schedule, which 13.4 is explicit is worse than none. The alert stays, and
on a farm with no history entered it will keep naming the same records until
somebody fills them in.

### 22.8 Sync

`Birth` is an event and follows 5.4's event rules: union by id, never a
conflict. The offspring records, their moves and the stillbirth Deaths are
ordinary records, moves and deaths and need no special handling.

The renamed column is the one migration hazard. A device that was offline when
the rename shipped is still holding outbox entries spelled `offspring_count`,
and unknown fields are ignored rather than rejected — which here would silently
drop a number somebody typed. The server accepts the old spellings and maps
them, once, on the way in.

Births are included in the device export, and `schema_version` is bumped
alongside it: a birth is the only record of where an animal born here came from,
so a restore without them leaves offspring with a date of birth and no mother.

### 22.9 Naming the parents on the Add form

An animal born here before births were recorded, or one whose birth was simply
never logged, can still be linked to its parents. When the Add form's source is
**Born here** it shows a **Parents** section:

- **Mother** — a searchable list of female animals and groups of the species
  selected above, each shown with its tag and current room. Optional, but the
  form asks for her. Choosing her fills in species, breed and room from her (the
  room only if she is still on the farm). All three stay editable.
- **Father** — the same list for males, or a free-text name for a sire that is
  not on this farm. The name is stored on the record as `records.sire_name`
  (migration 0013), because this route has no Birth to put it on.

Choosing a mother sets `dam_record_id`, so she lists the new record among her
offspring and it names her on its own screen. It does **not** create a Birth.
This route records an animal that already exists; Log birth records the event,
with its born and surviving counts and any stillbirths. The section says so, and
links to Log birth.

For the same reason a record linked this way is not added to the mother's
offspring figure (22.4). That figure is the typed baseline plus births counted,
and an animal old enough to be added after the fact is most likely already in
the baseline. Her offspring list marks it "no birth logged", so the list and
the figure can be told apart.

---

## 23. Clearing a device

### 23.1 Why it is in the app

Wiping the server is a script (`backend/scripts/reset_data.py`). Wiping a device
was four paths across two platforms — Safari's Website Data, an iOS Home Screen
app, Chrome's Site settings, an Android installed app — and **one of them is not
reachable from the browser's own settings at all**. A PWA added to the Home
Screen keeps its own store, so clearing Safari leaves the farm intact and the
app still full, which reads as the wipe having failed rather than having missed
a copy.

So it is a control in **More → Data**, under the two that can save what it
destroys. A button in the app cannot be missed, and it can say what it is about
to do in words the settings screens cannot.

### 23.2 What it clears

Every recorded row on the device: records, moves, births, sales, deaths, health
records, purchases, vet visits, visit notes, expenses, expense categories,
customers, vets, and every stock intake, outtake and count. The outbox goes with
them.

The table list is taken from Dexie's own table list rather than typed out, for
the reason 22.8's server counterpart gives: a table added later is cleared by
existing rather than by somebody remembering.

### 23.3 What it keeps, and why

- **The seeded rows**, at their fixed ids — the ten rooms, eight treatment
  schedules, two stores, three produce types. Deleting them would not lose data;
  it would produce a *second* set of them on the next sync (6.10), which looks
  like a mistake the farm made rather than one the app made. It also means the
  app is usable the moment the clear finishes: no blank screen, no setup wizard.
- **`device_id`**. It breaks ties in conflict resolution (5.4), and a device
  that changed identity every time it was cleared would merge unpredictably.
- **The seeded flags** in `meta`, since the rows they describe are staying.

The **pull cursor is reset to zero**. Left where it was, the device would never
re-pull what it had just deleted, and the two sides would disagree for ever with
nothing on screen saying so. At zero the next sync asks for everything, and the
device ends up holding exactly what the server holds — which is the only state
worth calling cleared.

Tokens are dropped too. They belong to the session the device had rather than to
the next one; with auth on, the next sync asks for the password again. SPEC 8's
rule that an auth failure never wipes local data is untouched — here the person
asked for precisely that.

### 23.4 What it does not do

**It does not clear the server**, and the confirmation says so. A client can
soft-delete a state entity but not an event — `deleted_at` is not writable on an
event (5.2's `WRITABLE`) — so a device cannot wipe the farm for everybody, and
adding an endpoint that could would be a "delete everything" button standing
open on the public internet whenever `AUTH_ENABLED` is false (21.2).

So if the server still holds records, the next sync brings them back to the
cleared device. That is the sync model working, not a fault, and somebody
expecting a clean slate has to be told before they tap rather than after.

A full reset is therefore both halves: **the script on the server, the button on
each device**. Whichever is done first, nothing should sync in the gap.

### 23.5 The confirmation

Three losses, each a different kind, each stated:

1. **Unsent changes are gone for good.** Everything else can come back from the
   server; these never reached it. They are *counted* rather than described —
   "11 changes have not reached the server yet".
2. **The server is untouched** (23.4).
3. **The seeded rows stay** (23.3).

The word `DELETE` has to be typed. This is the only control in the app that
destroys records outright rather than marking them sold or dead, and a mis-tap
on a phone in a pocket should not be able to reach it. Afterwards it reports
what went, by table and count — the same report the server script prints, for
the same reason: a wipe that says only "done" is a wipe nobody can check.
