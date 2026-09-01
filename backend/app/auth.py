"""Single-user auth. SPEC 8.

One user, but the API is on the public internet, so the token handling is
conventional: short-lived access tokens, long-lived refresh tokens rotated on
use and stored server-side so they can be revoked.

The offline rule in SPEC 8 is a *client* rule, and worth stating here so it is
not undone from this side: an expired token must never cause local data to be
wiped. Nothing in this module deletes anything a client holds.
"""

import hashlib
import hmac
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.orm import Session
from ulid import ULID

from app.config import get_settings
from app.db import get_db
from app.models import RefreshToken, User

ALGORITHM = "HS256"
SINGLE_USER_ID = "00000000000000000000000001"

_hasher = PasswordHasher()  # Argon2id by default
_bearer = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        _hasher.verify(password_hash, password)
    except (VerifyMismatchError, Exception):  # noqa: B014 - argon2 raises several
        return False
    return True


def _now() -> datetime:
    return datetime.now(timezone.utc)


def create_access_token() -> tuple[str, int]:
    settings = get_settings()
    ttl = timedelta(minutes=settings.access_token_minutes)
    expires = _now() + ttl
    token = jwt.encode(
        {"sub": SINGLE_USER_ID, "exp": expires, "iat": _now(), "typ": "access"},
        settings.jwt_secret,
        algorithm=ALGORITHM,
    )
    return token, int(ttl.total_seconds())


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue_refresh_token(db: Session) -> str:
    settings = get_settings()
    raw = str(ULID()) + str(ULID())
    db.add(
        RefreshToken(
            id=str(ULID()),
            token_hash=_digest(raw),
            issued_at=_now(),
            expires_at=_now() + timedelta(days=settings.refresh_token_days),
        )
    )
    return raw


def rotate_refresh_token(db: Session, raw: str) -> str:
    """Consume a refresh token and hand back a fresh one.

    Rotation-on-use means a stolen token is good for at most one exchange, and
    the theft is visible: the legitimate holder's next refresh fails.
    """
    stored = db.scalars(
        select(RefreshToken).where(RefreshToken.token_hash == _digest(raw))
    ).first()
    if stored is None or stored.revoked_at is not None or stored.expires_at <= _now():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "refresh_invalid", "title": "Refresh token is not usable"},
        )
    stored.revoked_at = _now()
    return issue_refresh_token(db)


def revoke_all_refresh_tokens(db: Session) -> None:
    for token in db.scalars(select(RefreshToken).where(RefreshToken.revoked_at.is_(None))).all():
        token.revoked_at = _now()


def get_user(db: Session) -> User | None:
    return db.get(User, SINGLE_USER_ID)


def ensure_user(db: Session) -> User | None:
    """Seed the single user from INITIAL_PASSWORD_HASH if it has not been set.

    There is deliberately no default password: with the variable unset and no
    user row, login simply cannot succeed.
    """
    user = get_user(db)
    if user is not None:
        return user
    initial = get_settings().initial_password_hash
    if not initial:
        return None
    user = User(id=SINGLE_USER_ID, password_hash=initial, updated_at=_now())
    db.add(user)
    db.commit()
    return user


def require_auth(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str:
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "not_authenticated", "title": "Authentication required"},
        )
    try:
        payload = jwt.decode(
            credentials.credentials, get_settings().jwt_secret, algorithms=[ALGORITHM]
        )
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "token_invalid", "title": "Access token is not valid"},
        )
    if payload.get("typ") != "access":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "token_invalid", "title": "Wrong token type"},
        )
    return payload["sub"]


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a, b)
