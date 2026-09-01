"""Login rate limiting. SPEC 8 — 5 attempts per 15 minutes per IP.

An in-process fixed window is enough for a single-instance deployment. If the
app is ever scaled past one replica this needs to move to Postgres or Redis,
because per-process counters would then let an attacker get 5 attempts per
replica.
"""

import time
from collections import defaultdict

from fastapi import HTTPException, Request, status

MAX_ATTEMPTS = 5
WINDOW_SECONDS = 15 * 60

_attempts: dict[str, list[float]] = defaultdict(list)


def login_rate_limit(request: Request) -> None:
    ip = request.client.host if request.client else "unknown"
    cutoff = time.monotonic() - WINDOW_SECONDS

    recent = [t for t in _attempts[ip] if t > cutoff]
    if len(recent) >= MAX_ATTEMPTS:
        _attempts[ip] = recent
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "code": "rate_limited",
                "title": "Too many login attempts",
                "detail": "Try again in a few minutes.",
            },
        )

    recent.append(time.monotonic())
    _attempts[ip] = recent


def reset_rate_limit() -> None:
    """For tests."""
    _attempts.clear()
