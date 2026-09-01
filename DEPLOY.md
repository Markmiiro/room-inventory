# Deploying to Railway

Two services: the FastAPI app and managed Postgres. SPEC 10.

The app **refuses to start** in production if it is not configured — a JWT
secret anyone can read in this repository is a token anyone can mint, which is
SPEC 8's ban on a default password wearing a different hat. `Settings.verify()`
in `backend/app/config.py` is the check; it runs before a single request is
served.

---

## Before the first deploy

### 1. Pin the runtimes

SPEC 10 pins **Python 3.12** and **PostgreSQL 16**. Development runs on 3.10 and
14, so the gap is deliberate and has to be held on purpose.

- `backend/runtime.txt` says `python-3.12`, and `backend/.python-version` says
  `3.12`. Railway's Python builder reads both; keep them agreeing.
- Choose **PostgreSQL 16** when adding the database plugin. Railway does not
  upgrade an existing database in place, so getting this wrong means a dump and
  restore later.

Confirm after deploy, rather than assuming:

```bash
railway run python -c "import sys; print(sys.version)"        # expect 3.12.x
railway run psql "$DATABASE_URL" -c "show server_version;"     # expect 16.x
```

### 2. Set every variable

| Variable | Value | If it is wrong |
|---|---|---|
| `APP_ENV` | `production` | **Without this none of the other checks run.** Set it first. |
| `JWT_SECRET` | 32+ random bytes, unique to this deployment | Startup refuses. Anyone with the repo could mint tokens. |
| `DATABASE_URL` | Railway's Postgres URL, pasted as-is | Startup refuses |
| `ALLOWED_ORIGINS` | the app's own origin, e.g. `https://rooms.example` | Startup refuses if it is unset or still localhost |
| `INITIAL_PASSWORD_HASH` | Argon2id hash of the farm's password | Not required — see below |

Generate the secret and the hash:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"          # JWT_SECRET

cd backend
.venv/bin/python -c "from app.auth import hash_password; print(hash_password('the-real-password'))"
```

Paste the hash into Railway's variable editor directly. Do not pipe it through a
shell — an Argon2 hash is full of `$`, and `$argon2id` expands to nothing.
That failure is silent: the app starts, seeds a user with a mangled hash, and
every login attempt is simply wrong.

**There is no default password**, and there is no fallback. With
`INITIAL_PASSWORD_HASH` unset and no user row, `ensure_user()` returns `None`
and login cannot succeed for anyone. That is a locked door, not an open one, so
deploying without it is safe — you just cannot log in until it is set.

Paste `DATABASE_URL` exactly as Railway gives it. It arrives as
`postgresql://…`, which SQLAlchemy maps to **psycopg2** — a driver this project
does not install, so both Alembic and the app die with
`ModuleNotFoundError: No module named 'psycopg2'`. Alembic dies first, during
the release command, which makes it look like a migration problem rather than a
URL problem. `app/config.py` rewrites the bare scheme to `postgresql+psycopg://`
on the setting that both readers share, so there is nothing to do by hand — but
if you ever see that error, this is where it comes from.

### 3. Migrations on deploy

Railway start command:

```
alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

`&&`, not `;` — a failed migration must stop the deploy rather than start an app
against a schema it does not match.

### 4. Backups, confirmed

SPEC 10: **automated daily backups, retained 30 days. Confirm the host's backups
are actually enabled — do not assume.**

- Turn on scheduled backups on the Postgres service and set retention to 30 days.
- Then **restore one** into a scratch database and count the rows. A backup that
  has never been restored is a belief, not a backup.

```bash
railway run psql "$DATABASE_URL" -c "select count(*) from records;"
```

The app has its own half of this: **More → Back up and export** writes every
table on the device to one JSON file, and the row turns red past seven days or
if there has never been one. That covers what the server has never seen — a
phone offline for a week is the only copy of its own writes.

---

## After every deploy

- [ ] `GET /health` returns `{"status":"ok"}` — wire it to Railway's health check
- [ ] Log in once with the real password
- [ ] `APP_ENV=production` is set (without it the safety checks are inert)
- [ ] HTTPS enforced, HSTS on
- [ ] Open the app on a phone, then turn the phone's radio off and reopen it —
      it must load with no network at all. If it does not, the service worker
      did not install.
- [ ] Check the logs are JSON and that `head_count_clamped` and
      `clock_skew_substituted` are greppable — these are how you find out the
      merge logic is wrong (SPEC 10)

## Things that will bite

**One instance only.** The login rate limiter (SPEC 8: five attempts per fifteen
minutes) is an in-process counter. Scale past one replica and an attacker gets
five attempts *per replica*. Moving it to Postgres is the fix; until then, keep
the replica count at one.

**`seq` is a single database-wide sequence.** Restoring a dump into a database
whose sequence is behind will hand out `seq` values clients have already seen,
and those changes will never be pulled. After any restore:

```sql
select setval('global_seq', (select max(seq) from (
  select max(seq) as seq from rooms union all
  select max(seq) from records union all select max(seq) from moves union all
  select max(seq) from purchases union all select max(seq) from health_records union all
  select max(seq) from sales union all select max(seq) from deaths union all
  select max(seq) from expenses union all select max(seq) from expense_categories union all
  select max(seq) from customers union all select max(seq) from vets
) t));
```

**Room ids are fixed in two places.** `backend/alembic/versions/0002_seed_rooms.py`
and `frontend/src/db/seed.ts` must keep the same ten ids, or a device that
seeded offline will produce twenty rooms on its first sync.
