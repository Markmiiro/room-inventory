# Deploying to Railway

Three services: the FastAPI app, managed Postgres, and the static frontend.
SPEC 10. The backend is below; **the frontend service** is at the end.

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
| `AUTH_ENABLED` | `false` is the default — read the section below before leaving it | Nothing refuses to start. With it false the API is open to anyone with the URL |
| `JWT_SECRET` | 32+ random bytes, unique to this deployment | Startup refuses **when `AUTH_ENABLED=true`**. Anyone with the repo could mint tokens |
| `DATABASE_URL` | Railway's Postgres URL, pasted as-is | Startup refuses |
| `ALLOWED_ORIGINS` | the app's own origin, e.g. `https://rooms.example` | Startup refuses if it is unset or still localhost — whatever `AUTH_ENABLED` says |
| `INITIAL_PASSWORD_HASH` | Argon2id hash of the farm's password | Not required — see below |

### `AUTH_ENABLED`, and what false costs

**It defaults to false, and with it false anyone who finds this backend's URL
can read and write every record** — purchase prices, sale prices, customers,
profit, every animal and every store. The sync endpoints accept pushes, so that
includes changing and deleting what is there. The URL is the only secret, and a
URL is not a secret: it is in browser history, in logs, in the frontend bundle
that names it, and in the hands of anyone who has ever had the link.

That is the trade, stated here so it is not discovered from the consequences.
SPEC 21 is the decision.

Three things stay on either way, because with no token to check they are what is
left:

- **HTTPS and HSTS.** In production a request that arrived over plain HTTP is
  refused with code `https_required`, and every response carries
  `Strict-Transport-Security`.
- **`ALLOWED_ORIGINS`.** Startup still refuses an unset or localhost value.
- **The login rate limiter**, five attempts per fifteen minutes per IP, applied
  to `/auth/login` even while login is switched off.

**To turn authentication on:** set `AUTH_ENABLED=true` and
`INITIAL_PASSWORD_HASH`, and restart. No rebuild, no migration, no frontend
deploy — the client asks `GET /config` on every sync tick and a 401 makes the
password box reappear on a device that was offline when you changed it. Local
data is untouched throughout (SPEC 8).

`GET /config` is unauthenticated by necessity: it answers whether a token is
required, which a client could not ask for if it needed one. It carries one
boolean and nothing about the farm.

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
- [ ] `AUTH_ENABLED` is what you meant it to be. `curl https://<backend>/config`
      answers `{"auth_enabled": …}` — if that says `false`, the URL you just
      curled is all anyone needs to read and change every record
- [ ] With `AUTH_ENABLED=true`: log in once with the real password
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
the replica count at one. This still applies with `AUTH_ENABLED=false`: the
limiter is on the route either way.

**`seq` is a single database-wide sequence.** Restoring a dump into a database
whose sequence is behind will hand out `seq` values clients have already seen,
and those changes will never be pulled. After any restore:

This was a hand-written list of tables, and it had gone stale: it was missing
`treatment_schedules`, `vet_visits`, `visit_notes`, `births` and the five store
tables, so following it set the sequence *below* rows that already existed —
which is the same silent failure it was written to prevent. Use this instead. It
finds every table with a `seq` column, so a table added later is covered, and it
takes the greater of that and the sequence's current value, so it can only ever
move the sequence forward:

```sql
do $$
declare
  t record;
  highest bigint := 0;
  found bigint;
begin
  for t in
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'seq'
  loop
    execute format('select coalesce(max(seq), 0) from %I', t.table_name) into found;
    if found > highest then highest := found; end if;
  end loop;
  perform setval('global_seq', greatest(highest, (select last_value from global_seq)));
end $$;
```

`backend/scripts/reset_data.py` does the same thing in Python, and
`tests/test_reset.py` asserts the sequence never goes backwards — see **Starting
the records again** below.

**Room ids are fixed in two places.** `backend/alembic/versions/0002_seed_rooms.py`
and `frontend/src/db/seed.ts` must keep the same ten ids, or a device that
seeded offline will produce twenty rooms on its first sync.

---

# Starting the records again

Wiping a farm's records is not a `TRUNCATE`, and the two things it is easy to get
wrong both fail silently. `backend/scripts/reset_data.py` does it; the sequence
below is server first, then every device, because a device that still holds the
old rows will push them straight back.

## 1. Take the exports

**From each phone, in the app: More → Backup.** That file is the only copy of
anything a device has not yet synced, and it is the only export this app can
restore (More → Restore from a backup).

Then from the server, which keeps a copy of everything that *had* synced:

```bash
cd backend
railway run python -m scripts.reset_data --export-only
```

It writes `backend/backups/room-inventory-server-<timestamp>.json` — every
table, every row, stamped with the Alembic revision it came from, with produce
weights as strings so the `Numeric` columns do not round on the way out
(SPEC 20.8). Move it somewhere off the machine.

**There is no import route yet.** SPEC 7 names `POST /import/json`; it is not
built. So the server export is for reading and for re-entering by hand. The
device export is the one that restores.

## 2. Wipe the server

```bash
# Report first. Deletes nothing, writes nothing.
railway run python -m scripts.reset_data

# Then, and only with the flag:
railway run python -m scripts.reset_data --confirm --expect-database railway
```

With no `--confirm` it prints what it would delete, by table and count, and
stops. `--expect-database` refuses unless the name matches, which is worth using
on a host where `DATABASE_URL` comes from the environment and you cannot see
what you are aimed at. A `--confirm` run always writes the export first, and
`--no-export` is refused alongside it.

What it keeps, and why:

| Kept | Reason |
|---|---|
| The ten rooms, eight treatment schedules, two stores, three produce types | Their ids are fixed in the migrations *and* in `frontend/src/db/seed.ts`. Delete them and the next device to sync creates a second set (SPEC 6.10) |
| `users` | A password is a credential, not a record. Wiping it locks the farm out of its own API |
| `alembic_version` | The schema's own bookkeeping. Clearing it makes the next deploy re-run every migration |

`refresh_tokens` **is** cleared, so with `AUTH_ENABLED=true` every device is
asked for the password again. No local data is touched by that (SPEC 8).

The table list is derived from the SQLAlchemy metadata rather than typed out, so
a table added later is included by existing. The seeded ids are read from the
migrations that wrote them, and the script **refuses to run** if they are not
where it expects — as written, a drift there would delete the seed rather than
keep it.

## 3. What it does to `seq`, and why it does not restart it

`global_seq` is **advanced, never rewound.** Restarting it at 1 is the obvious
thing and it is wrong: a device pulls everything above the cursor it holds, so
numbers below that cursor are numbers it will never ask for. Every row written
after such a reset would be invisible to that device, permanently, with the sync
indicator still reporting Synced.

Instead the surviving seeded rows are re-stamped from the top of the sequence.
That makes them *newer* than any cursor in the field, so a device that was not
wiped pulls them and writes them over the copies it already has — same ids, so
an upsert rather than a duplicate — and carries on. `updated_at` is deliberately
left alone: it is what the per-field merge reads (SPEC 5.4), and the seeds are
backdated on purpose so any renaming the farm has done still wins.

## 4. Clear every device

A wiped server and a full device is not a fresh start, and the reason is worth
being precise about: **this reset is a hard delete, and a hard delete is
invisible to sync.** Everything the app itself deletes is a soft delete that
travels as a row (SPEC 4.8); rows removed underneath it do not travel at all. So
a device that is not cleared keeps its entire copy of the farm, shows no sign
that anything happened, and pushes back whatever was still in its outbox.

Do every phone and tablet that has ever opened the app, and do them after the
server, not before.

**What has to go**, all of which a "site data" clear covers in one action: the
IndexedDB database **`room-inventory`** (every record, the outbox, and the pull
cursor), `localStorage` (`access_token`, `refresh_token`, `auth_state`) and the
service worker's caches. On the Home Screen the app is called **Room
Inventory**, shortened to **Rooms** under the icon.

### iPhone / iPad — Safari

Settings → Safari → Advanced → Website Data → find the app's domain → swipe left
→ Delete. That is the one to prefer: **Clear History and Website Data** on the
Safari settings screen works too, and takes every other site with it.

### iPhone / iPad — installed from the Home Screen

**Its storage is separate from Safari's**, so clearing Safari does not touch it,
and this is the one people miss. Delete the app: press and hold the Home Screen
icon → Remove App → Delete App. That deletes its data with it. Then add it
again from Safari (Share → Add to Home Screen).

If both exist — a Safari tab *and* a Home Screen app — clear both. They are two
stores with two copies of the farm.

### Android — Chrome

Chrome → ⋮ → Settings → Site settings → All sites → find the app's domain →
**Clear & reset**. Or, from the page itself: tap the padlock in the address bar
→ Cookies and site data → Delete.

### Android — installed from the Home Screen

The installed app is a separate Android app with its own storage. Settings →
Apps → **Room Inventory** → Storage & cache → **Clear storage** (not just Clear
cache — that leaves the records). Uninstalling it does the same thing. Its data
is not cleared by clearing Chrome's.

On some Android builds it appears under Settings → Apps → See all apps, and the
storage screen calls the button *Manage space*. If the app is not listed at all
it was added as a plain shortcut rather than installed, in which case its data
is Chrome's and the step above it is the one that clears it.

### Then check it took

Open the app. You should see the ten rooms, the eight treatment schedules and
the two stores — freshly seeded locally — and nothing else: no animals, no
sales, and the sync chip reporting no pending changes. Ten rooms rather than
twenty is the signal that the seeded ids survived the server wipe.

---

# The frontend service

A second Railway service on the same repository, **root directory `frontend/`**.
It builds a static bundle and serves it; it never talks to Postgres.

## 1. The one variable

| Variable | Value | If it is wrong |
|---|---|---|
| `VITE_API_BASE` | the backend service's origin — **scheme included, no path, no trailing slash**, e.g. `https://room-inventory-api.up.railway.app` | Every sync and login fails; the app still opens and still works offline, so this looks like "sync is broken", not "the URL is wrong" |

**The `https://` is not optional.** A value with no scheme —
`room-inventory-api.up.railway.app` — is a *relative* URL reference, so the
browser resolves it against the frontend's own origin and posts to
`https://<frontend>/room-inventory-api.up.railway.app/auth/login`. The
frontend's static server answers `405` with `allow: GET, HEAD`, and the request
never leaves the frontend service. A 405 on sign-in means this, every time: the
backend returns 401 for a bad password and has no route that can produce a 405.

`frontend/src/sync/api.ts:10` is the only place it is read:

```ts
const BASE_URL = import.meta.env.VITE_API_BASE ?? "/api";
```

**No `/api` suffix.** The backend mounts its routes at the root — `/auth/login`,
`/sync/push`, `/sync/pull`, `/health` (`backend/app/main.py`). The `/api` in the
fallback exists only for `npm run dev`, where `vite.config.ts` proxies `/api` to
`localhost:8000` and *strips the prefix on the way through*. Copying that `/api`
into the deployed value produces `…/api/auth/login`, which is a 404 from a
server that is otherwise perfectly healthy.

No trailing slash either — paths are concatenated directly (`${BASE_URL}${path}`).

## 2. It is baked in at build time, not read at runtime

Vite inlines `import.meta.env.VITE_*` into the bundle during `vite build`. The
built file contains the literal string; nothing reads an environment variable in
the browser. You can see it in the current `dist/`:

```bash
grep -o '"/api"' frontend/dist/assets/index-*.js     # the inlined default
grep -c 'import\.meta\.env' frontend/dist/assets/index-*.js   # 0
```

Consequences, in order of how much they cost:

- **`VITE_API_BASE` must be set before the first build that you intend to ship.**
  A build that ran without it ships `"/api"` hardcoded, and every request goes
  to the frontend's own origin.
- **Changing it later requires a rebuild, not a restart.** Editing the variable
  on Railway triggers a redeploy, which re-runs the build — that is enough. But
  a restart or a rollback to a previously built image is not: the old value is
  in the JavaScript.
- **Verify after deploy rather than assuming**, because a cached build layer
  will happily reuse the old bundle:

  ```bash
  curl -s https://<frontend-domain>/assets/index-*.js | grep -o 'https://[a-z0-9.-]*railway.app'
  ```

  Easier: open the app, open the network tab, log in, and read where the
  `/auth/login` request actually went.

- **Devices hold the old bundle.** The service worker precaches the app shell
  (SPEC 9) with `registerType: "prompt"`, so a phone that already has the app
  keeps running the old JavaScript — old API base included — until someone
  accepts the update prompt. After changing the backend URL, expect installed
  devices to lag a session behind.

## 3. Build and start commands

Railway's Node builder picks up `npm run build` on its own. The start command:

```
npm run start
```

which is `vite preview --host 0.0.0.0 --port ${PORT:-4173}` in
`frontend/package.json`. `vite preview` serves `dist/` and falls back to
`index.html` for unknown paths, which is what react-router deep links and the
service worker's `navigateFallback` both need — a plain file server without that
fallback 404s on a reload of `/rooms/3`.

Two things that are easy to get wrong here:

- **`vite preview` needs the dev dependencies.** Vite is in `devDependencies`,
  so do not set `NPM_CONFIG_PRODUCTION=true` or otherwise prune them — the start
  command then fails with `vite: not found` *after* a build that succeeded.
- **`preview.allowedHosts` must stay in `vite.config.ts`.** Vite 6 answers every
  request whose `Host` header it was not told about with
  `403 Blocked request. This host is not allowed.` Railway's generated domain is
  not knowable in advance, so the config sets `allowedHosts: true`. Remove it and
  the deploy goes green and serves 403 to everyone.

Point Railway's health check at `/`.

## 4. The backend has to be told about it

The two services are now different origins, so this is real CORS, not a
same-origin app any more.

- Set the **backend's** `ALLOWED_ORIGINS` to the **frontend's** origin
  (`https://<frontend-domain>`), not the backend's own. The backend sends
  `allow_credentials=True` with an explicit origin list, so a wildcard is not an
  option — the origin has to match exactly, scheme included, no trailing slash.
- This is a chicken-and-egg pair: deploy the frontend first to get its domain,
  set `ALLOWED_ORIGINS` on the backend, then set `VITE_API_BASE` on the frontend
  and let it rebuild.
- `VITE_API_BASE` must be **https**. The app is served over https, so an http
  API URL is blocked as mixed content before the request is even made.

## 5. After every frontend deploy

- [ ] Log in — this is the only check that exercises `VITE_API_BASE` and
      `ALLOWED_ORIGINS` together. A CORS failure and a wrong URL look identical
      from the UI, so read the browser console to tell them apart
- [ ] Reload on a deep link (`/rooms/…`) — a 404 means the SPA fallback is gone
- [ ] Load the app on a phone, turn the radio off, reopen it — it must still
      start (SPEC 9). This is the same check as the backend list, but it is the
      frontend service that can break it
- [ ] Confirm the shipped bundle carries the backend URL you expect, per §2
