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
