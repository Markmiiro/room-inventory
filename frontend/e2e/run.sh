#!/usr/bin/env bash
#
# Two-device convergence, end to end. SPEC 5.4 and 6.7.
#
# Self-contained on purpose: it drops and rebuilds its own database and starts
# its own backend every run. Two things make that necessary rather than tidy —
# SPEC 8 rate-limits login to five attempts per fifteen minutes per IP, and the
# limiter is in-process, so a second run against a warm server is locked out and
# would otherwise "pass" by never syncing at all.
#
# Usage:  frontend/e2e/run.sh   (expects the frontend dev server on :5173)
set -euo pipefail

FRONTEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$FRONTEND/.." && pwd)"
BACKEND="$ROOT/backend"
DB=room_inventory_e2e
PORT=8000
PASSWORD=e2e-test-password
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true' EXIT

cd "$BACKEND"

echo "==> rebuilding $DB"
dropdb --if-exists "$DB"
createdb "$DB"

# The Argon2 hash is full of $, so it is written single-quoted and never
# interpolated by the shell.
"$BACKEND/.venv/bin/python" - "$PASSWORD" "$WORK/env" <<'PY'
import sys, pathlib
sys.path.insert(0, ".")
from app.auth import hash_password
password, out = sys.argv[1], sys.argv[2]
pathlib.Path(out).write_text(
    "DATABASE_URL='postgresql+psycopg:///room_inventory_e2e'\n"
    # SPEC 21 — the flag is false by default, and this test is about the
    # authenticated path: both devices sign in, so it asks for that path
    # explicitly rather than silently exercising the open one.
    "AUTH_ENABLED='true'\n"
    "JWT_SECRET='e2e-only-secret-not-used-anywhere-else'\n"
    "ALLOWED_ORIGINS='http://localhost:5173'\n"
    f"INITIAL_PASSWORD_HASH='{hash_password(password)}'\n"
)
PY

set -a; . "$WORK/env"; set +a

echo "==> migrating"
PATH="$BACKEND/.venv/bin:$PATH" "$BACKEND/.venv/bin/alembic" upgrade head >/dev/null

echo "==> starting the api on :$PORT"
"$BACKEND/.venv/bin/uvicorn" app.main:app --port "$PORT" > "$WORK/api.log" 2>&1 &
API_PID=$!
for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break
  sleep 0.3
done

if ! curl -sf "http://localhost:5173/" >/dev/null; then
  echo "The frontend dev server is not on :5173. Run 'npm run dev' in frontend/ first." >&2
  exit 2
fi

echo "==> running the test"
node "$FRONTEND/e2e/two-device-convergence.mjs"
