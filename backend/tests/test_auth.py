"""SPEC 8 — auth. SPEC 21 — and the switch that turns it off.

The `open_client` fixture sets `AUTH_ENABLED=true` explicitly, because the
shipped default is now false (SPEC 21). Everything below it is the
authentication-on behaviour, unchanged: the flag restores it exactly.
"""

import pytest

from app.auth import hash_password
from app.config import get_settings
from app.rate_limit import reset_rate_limit


@pytest.fixture
def open_client(db, monkeypatch):
    """A client with real auth in place, unlike the `client` fixture."""
    from fastapi.testclient import TestClient

    from app.db import get_db
    from app.main import app

    get_settings.cache_clear()
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("INITIAL_PASSWORD_HASH", hash_password("correct horse battery"))
    monkeypatch.setenv("JWT_SECRET", "test-secret")
    reset_rate_limit()

    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
    get_settings.cache_clear()


def test_sync_requires_a_token(open_client):
    response = open_client.get("/sync/pull?since=0")
    assert response.status_code == 401
    assert response.json()["code"] == "not_authenticated"


def test_login_then_pull(open_client):
    tokens = open_client.post("/auth/login", json={"password": "correct horse battery"}).json()
    response = open_client.get(
        "/sync/pull?since=0", headers={"Authorization": f"Bearer {tokens['access_token']}"}
    )
    assert response.status_code == 200


def test_a_wrong_password_gives_a_coded_problem_detail(open_client):
    response = open_client.post("/auth/login", json={"password": "wrong"})
    assert response.status_code == 401
    body = response.json()
    assert body["code"] == "bad_credentials"
    assert body["status"] == 401


def test_refresh_tokens_rotate_and_the_old_one_stops_working(open_client):
    first = open_client.post("/auth/login", json={"password": "correct horse battery"}).json()

    second = open_client.post("/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert second.status_code == 200
    assert second.json()["refresh_token"] != first["refresh_token"]

    replay = open_client.post("/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert replay.status_code == 401
    assert replay.json()["code"] == "refresh_invalid"


def test_login_is_rate_limited(open_client):
    """SPEC 8 — 5 attempts per 15 minutes per IP."""
    for _ in range(5):
        open_client.post("/auth/login", json={"password": "wrong"})

    response = open_client.post("/auth/login", json={"password": "wrong"})
    assert response.status_code == 429
    assert response.json()["code"] == "rate_limited"


def test_health_needs_no_token(open_client):
    assert open_client.get("/health").json() == {"status": "ok"}


# ---------------------------------------------------------------------------
# 8 — no credential may have a value baked into the repository
# ---------------------------------------------------------------------------


def test_development_starts_with_whatever_is_lying_around():
    from app.config import Settings

    Settings(app_env="development").verify()  # does not raise


def test_production_refuses_the_repositorys_own_jwt_secret():
    """SPEC 8 forbids a default password. A signing key anyone can read in the
    source is the same failure wearing a different hat: it mints tokens."""
    import pytest

    from app.config import DEV_JWT_SECRET, MisconfiguredError, Settings

    with pytest.raises(MisconfiguredError, match="JWT_SECRET"):
        Settings(
            app_env="production",
            # Only checked when tokens are actually being signed (SPEC 21).
            auth_enabled=True,
            jwt_secret=DEV_JWT_SECRET,
            database_url="postgresql+psycopg://user@db/prod",
            allowed_origins="https://rooms.example",
        ).verify()


def test_production_refuses_a_localhost_cors_origin():
    import pytest

    from app.config import MisconfiguredError, Settings

    with pytest.raises(MisconfiguredError, match="ALLOWED_ORIGINS"):
        Settings(
            app_env="production",
            jwt_secret="a-real-secret-from-the-environment",
            database_url="postgresql+psycopg://user@db/prod",
            allowed_origins="http://localhost:5173",
        ).verify()


def test_production_refuses_the_development_database():
    import pytest

    from app.config import DEV_DATABASE_URL, MisconfiguredError, Settings

    with pytest.raises(MisconfiguredError, match="DATABASE_URL"):
        Settings(
            app_env="production",
            jwt_secret="a-real-secret-from-the-environment",
            database_url=DEV_DATABASE_URL,
            allowed_origins="https://rooms.example",
        ).verify()


def test_a_properly_configured_production_starts():
    from app.config import Settings

    Settings(
        app_env="production",
        jwt_secret="a-real-secret-from-the-environment",
        database_url="postgresql+psycopg://user@db/prod",
        allowed_origins="https://rooms.example",
    ).verify()


def test_production_does_not_require_an_initial_password_hash():
    """SPEC 8 allows a one-time setup route instead. With neither set, login
    cannot succeed — a locked door, not an open one."""
    from app.config import Settings

    Settings(
        app_env="production",
        jwt_secret="a-real-secret-from-the-environment",
        database_url="postgresql+psycopg://user@db/prod",
        allowed_origins="https://rooms.example",
        initial_password_hash="",
    ).verify()


# ---------------------------------------------------------------------------
# SPEC 21 — authentication as a config flag
# ---------------------------------------------------------------------------


@pytest.fixture
def no_auth_client(db, monkeypatch):
    """A client against the shipped default: `AUTH_ENABLED` unset, so false."""
    from fastapi.testclient import TestClient

    from app.db import get_db
    from app.main import app

    get_settings.cache_clear()
    monkeypatch.delenv("AUTH_ENABLED", raising=False)
    monkeypatch.setenv("INITIAL_PASSWORD_HASH", hash_password("correct horse battery"))
    reset_rate_limit()

    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
    get_settings.cache_clear()


def test_the_default_is_off(no_auth_client):
    """The flag ships false, and the server says so where the client can read
    it without a token — which is the only way the app can render honestly."""
    assert no_auth_client.get("/config").json() == {"auth_enabled": False}


def test_config_reports_the_flag_when_it_is_on(open_client):
    assert open_client.get("/config").json() == {"auth_enabled": True}


def test_sync_needs_no_token_when_auth_is_off(no_auth_client):
    assert no_auth_client.get("/sync/pull?since=0").status_code == 200
    push = no_auth_client.post(
        "/sync/push", json={"device_id": "device-a", "operations": []}
    )
    assert push.status_code == 200


def test_anomalies_need_no_token_when_auth_is_off(no_auth_client):
    assert no_auth_client.get("/sync/anomalies").status_code == 200


def test_login_says_plainly_that_it_is_switched_off(no_auth_client):
    """Not a 401 and not a 404. A client that asked for a password has to be
    told the server is not asking for one, rather than left to infer it."""
    response = no_auth_client.post("/auth/login", json={"password": "correct horse battery"})
    assert response.status_code == 409
    assert response.json()["code"] == "auth_disabled"


def test_refresh_says_the_same(no_auth_client):
    response = no_auth_client.post("/auth/refresh", json={"refresh_token": "anything"})
    assert response.status_code == 409
    assert response.json()["code"] == "auth_disabled"


def test_the_login_rate_limit_still_applies_with_auth_off(no_auth_client):
    """SPEC 21 keeps the limiter on whatever the flag says. The route is the one
    an unauthenticated deployment should least like being probed for free."""
    for _ in range(5):
        no_auth_client.post("/auth/login", json={"password": "wrong"})

    response = no_auth_client.post("/auth/login", json={"password": "wrong"})
    assert response.status_code == 429
    assert response.json()["code"] == "rate_limited"


def test_a_token_is_simply_ignored_when_auth_is_off(no_auth_client):
    """A device that signed in before the flag was flipped keeps working. Its
    stored token is stale and meaningless, and must not be a 401."""
    response = no_auth_client.get(
        "/sync/pull?since=0", headers={"Authorization": "Bearer not-a-real-token"}
    )
    assert response.status_code == 200


def test_production_does_not_require_a_jwt_secret_with_auth_off():
    """Nothing is signed, so there is no key to demand. The origin restriction
    is still required — see the test below."""
    from app.config import DEV_JWT_SECRET, Settings

    Settings(
        app_env="production",
        auth_enabled=False,
        jwt_secret=DEV_JWT_SECRET,
        database_url="postgresql+psycopg://user@db/prod",
        allowed_origins="https://rooms.example",
    ).verify()


def test_production_still_requires_a_real_cors_origin_with_auth_off():
    """SPEC 21 keeps ALLOWED_ORIGINS restricted whatever the flag says — with
    no token to check it is one of the few things left."""
    from app.config import MisconfiguredError, Settings

    with pytest.raises(MisconfiguredError, match="ALLOWED_ORIGINS"):
        Settings(
            app_env="production",
            auth_enabled=False,
            database_url="postgresql+psycopg://user@db/prod",
            allowed_origins="http://localhost:5173",
        ).verify()
