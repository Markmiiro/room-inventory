"""SPEC 8 — auth."""

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
