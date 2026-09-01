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
| `species` | enum | yes | `cattle`, `goats`, `sheep`, `pigs`, `poultry` |
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
- **Type is derived.** One species present → that species. Two or more → `Mixed`.
  None → `Empty`. If `is_isolation`, the chip reads `Isolation` regardless.
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

---

## 12. Known mockup defects

Do not reproduce these:

- **Species icons are wrong throughout.** Material Symbols has no livestock, so the
  mockups show a tractor for cattle, a rat for pigs, a bug for poultry, a bee for
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
