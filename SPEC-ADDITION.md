# SPEC addition — schedules, vet visits, sale readiness

Three features to add as sections 13, 14 and 15 of SPEC.md. Everything in the
existing spec still applies: same vocabulary, same event-versus-state model,
same offline-first rules, same one-yellow-button design.

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
| Poultry | Newcastle vaccination | 7 days | every 3 months |
| Poultry | Gumboro vaccination | 14 days | one-off |

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
| Poultry (broiler) | 6 weeks |
| Pigs | 6 months |
| Goats | 12 months |
| Sheep | 12 months |
| Cattle | 24 months |

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
- **Sync** — TreatmentSchedule, SaleTarget and VetVisit follow the existing
  rules. Schedules and targets are state entities with per-field
  last-write-wins. Visits and visit notes are events, append-only. Seeded
  schedules need fixed ids in both the migration and the client seed, exactly as
  the ten rooms do, or two devices seeding offline produce duplicates.

---

## 17. Still not built, and named here so it stays visible

- **Birth records.** Offspring is a typed number. There is no birth event, no
  link from offspring to mother, and an animal born on the farm has no arrival
  date of its own. This is the main reason a date of birth goes missing, which
  is what breaks sections 13 and 15. Worth revisiting.
- **Customers and vets are not linked.** A sale stores the buyer as free text,
  so customer history does not work. Section 14 links vets to visits; sales
  still need the same treatment.
- **Partial payment.** A sale is one price on one date. A buyer paying half now
  and half next month has nowhere to go, and the profit figures will be wrong
  until it does.
- **Feed quantity.** Feed is tracked as cost, not as bags in and out. You know
  what you spent, not what you used.
