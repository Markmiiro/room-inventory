"""FastAPI application.

The surface here is small on purpose: sync is the real interface, and the REST
routes exist for the things a client cannot do for itself.
"""

import json
import logging
import sys
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app import sync
from app.auth import (
    ensure_user,
    get_user,
    hash_password,
    issue_refresh_token,
    require_auth,
    revoke_all_refresh_tokens,
    rotate_refresh_token,
    verify_password,
)
from app.config import get_settings
from app.db import get_db
from app.models import SyncAnomaly
from app.rate_limit import login_rate_limit
from app.schemas import (
    ChangePasswordRequest,
    LoginRequest,
    PullResponse,
    PushRequest,
    PushResponse,
    RefreshRequest,
    TokenPair,
)


def configure_logging() -> None:
    """Structured JSON logs (SPEC 10) — sync conflicts and clamped counts are
    how you find out the merge logic is wrong, so they need to be greppable."""

    class JsonFormatter(logging.Formatter):
        def format(self, record: logging.LogRecord) -> str:
            payload = {
                "level": record.levelname,
                "logger": record.name,
                "event": record.getMessage(),
                "time": datetime.now(timezone.utc).isoformat(),
            }
            for key, value in record.__dict__.items():
                if key not in logging.LogRecord("", 0, "", 0, "", (), None).__dict__ and key != "message":
                    payload[key] = value
            return json.dumps(payload, default=str)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.INFO)


configure_logging()
settings = get_settings()
# Before anything is served. A production deployment carrying the repository's
# own JWT secret would work perfectly and be forgeable by anyone who can read
# the source (SPEC 8).
settings.verify()

app = FastAPI(title="Room Inventory", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(HTTPException)
async def problem_detail_handler(request: Request, exc: HTTPException) -> JSONResponse:
    """RFC 7807 problem details with a machine-readable `code` (SPEC 7).

    The client's outbox needs to tell "retry this" from "this will never work";
    a bare status code does not carry enough to decide.
    """
    detail = exc.detail
    if isinstance(detail, dict):
        body = {
            "type": "about:blank",
            "title": detail.get("title", "Request failed"),
            "status": exc.status_code,
            "detail": detail.get("detail"),
            "code": detail.get("code", "error"),
        }
    else:
        body = {
            "type": "about:blank",
            "title": str(detail),
            "status": exc.status_code,
            "detail": None,
            "code": "error",
        }
    return JSONResponse(status_code=exc.status_code, content=body, media_type="application/problem+json")


@app.get("/health")
def health(db: Session = Depends(get_db)) -> dict[str, str]:
    db.execute(text("SELECT 1"))
    return {"status": "ok"}


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------


@app.post("/auth/login", response_model=TokenPair)
def login(
    body: LoginRequest, request: Request, db: Session = Depends(get_db)
) -> TokenPair:
    login_rate_limit(request)  # SPEC 8 — 5 attempts per 15 minutes per IP

    user = ensure_user(db)
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "bad_credentials", "title": "Password is not correct"},
        )
    access, expires_in = _issue(db)
    refresh = issue_refresh_token(db)
    db.commit()
    return TokenPair(access_token=access, refresh_token=refresh, expires_in=expires_in)


@app.post("/auth/refresh", response_model=TokenPair)
def refresh_tokens(body: RefreshRequest, db: Session = Depends(get_db)) -> TokenPair:
    new_refresh = rotate_refresh_token(db, body.refresh_token)
    access, expires_in = _issue(db)
    db.commit()
    return TokenPair(access_token=access, refresh_token=new_refresh, expires_in=expires_in)


@app.post("/auth/change-password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    body: ChangePasswordRequest,
    db: Session = Depends(get_db),
    _: str = Depends(require_auth),
) -> None:
    user = get_user(db)
    if user is None or not verify_password(body.current_password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "bad_credentials", "title": "Current password is not correct"},
        )
    user.password_hash = hash_password(body.new_password)
    user.updated_at = datetime.now(timezone.utc)
    revoke_all_refresh_tokens(db)
    db.commit()


def _issue(db: Session) -> tuple[str, int]:
    from app.auth import create_access_token

    return create_access_token()


# --------------------------------------------------------------------------
# Sync
# --------------------------------------------------------------------------


@app.post("/sync/push", response_model=PushResponse)
def sync_push(
    body: PushRequest,
    db: Session = Depends(get_db),
    _: str = Depends(require_auth),
) -> PushResponse:
    results = sync.apply_push(db, body.device_id, body.operations)
    db.commit()
    return PushResponse(
        results=results, head_seq=sync.head_seq(db), server_time=sync.now()
    )


@app.get("/sync/pull", response_model=PullResponse)
def sync_pull(
    since: int = Query(0, ge=0),
    limit: int = Query(500, ge=1, le=1000),
    db: Session = Depends(get_db),
    _: str = Depends(require_auth),
) -> PullResponse:
    changes, cursor, has_more = sync.pull_changes(db, since, limit)
    return PullResponse(
        changes=changes, cursor=cursor, has_more=has_more, server_time=sync.now()
    )


@app.get("/sync/anomalies")
def sync_anomalies(
    db: Session = Depends(get_db), _: str = Depends(require_auth)
) -> list[dict]:
    """Merges the server had to paper over, so the client can raise them as alerts.

    Currently the negative-head-count clamp from SPEC 6.7.
    """
    rows = db.scalars(
        select(SyncAnomaly).where(SyncAnomaly.resolved_at.is_(None)).order_by(SyncAnomaly.created_at)
    ).all()
    return [
        {
            "id": row.id,
            "kind": row.kind,
            "entity": row.entity,
            "entity_id": row.entity_id,
            "detail": row.detail,
            "created_at": row.created_at.isoformat(),
        }
        for row in rows
    ]
