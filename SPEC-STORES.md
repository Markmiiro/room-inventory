# SPEC addition — produce stores

To be added as section 20 of SPEC.md. Everything in the existing spec still
applies: client-generated ULIDs, event-versus-state entities, offline-first
sync, head counts never percentages, one yellow button per screen, colour never
carrying meaning alone.

---

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
| `notes` | text | no | |

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
| `unit_price` | integer | no | UGX per kg. Only when reason is `sold` |
| `total_price` | integer | no | UGX. Only when reason is `sold` |
| `customer_id` | string | no | The buyer, when sold |
| `to_store_id` | string | no | Only when reason is `moved` |
| `notes` | text | no | |

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
value at average cost should be visible somewhere. Spoilage in particular is a
real loss the farm should be able to see.

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

SPEC 11 fixes five destinations and says "five is the number". That was written
when the app held only livestock.

**Recommendation: a sixth item, Stores**, between Animals and Calendar. During
harvest this is a daily screen, and burying a daily screen under More is worse
than six tabs. Six fits at 390px, though it needs checking rather than assuming
— the species chips looked fine by estimate and were 100px too wide when
measured.

If six proves too tight, the alternative is putting Stores on the Rooms home
screen as a second section, since both answer "what is in my building". Do not
bury it under More.

### 20.16 Open questions — answer before building

1. **Do you sell coffee by the kilogram or by the sack?** The spec assumes per
   kilogram with the total computed. If you negotiate per sack, the price entry
   should flip round.
2. **Is produce from different harvests kept separate?** This spec pools it —
   one balance per store per produce type, valued at weighted average cost. If
   you keep the March coffee apart from the September coffee because they fetch
   different prices, that needs lots, which is a heavier model and more typing.
   **This is the one decision most expensive to change later.**
3. **Should produce and livestock share one profit figure?** The spec adds them
   to the same farm total, broken out separately. Say if you'd rather they were
   kept entirely apart.
4. **What does a sack of each produce usually weigh?** Not to compute anything
   from — only so the app can flag an entry that looks like a typo.
