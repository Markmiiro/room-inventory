from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# The values that only make sense on a laptop. Booting with any of them in
# production means the deployment is not configured, and a JWT secret everyone
# can read in the repository is a signing key everyone can forge.
DEV_JWT_SECRET = "dev-only-not-a-real-secret"
DEV_DATABASE_URL = "postgresql+psycopg://supreme@localhost:5432/room_inventory"


# The scheme SQLAlchemy needs to reach for psycopg 3. A bare `postgresql://`
# makes it load psycopg2 instead, which this project does not install.
PSYCOPG_SCHEME = "postgresql+psycopg"

# What managed hosts hand out. Railway and Render use the first; the second is
# the old Heroku spelling that still turns up in copied config.
_BARE_POSTGRES_SCHEMES = {"postgresql", "postgres"}


def normalise_database_url(url: str) -> str:
    """Point a bare Postgres URL at psycopg 3.

    Railway supplies `postgresql://…`, and SQLAlchemy maps that to psycopg2 —
    which is not installed here, so both the app and Alembic die with
    `ModuleNotFoundError: No module named 'psycopg2'`. Alembic dies first,
    during the release command, which makes it look like a migration problem
    rather than a URL problem.

    Only a *bare* scheme is rewritten. A URL that names its driver explicitly is
    left alone: someone who wrote `+psycopg2` meant it, and silently swapping
    their driver would hide the real answer, which is that this project pins
    psycopg 3. Non-Postgres URLs pass through untouched.

    Everything else about the URL — credentials, host, port, database, and query
    parameters such as `?sslmode=require` — is carried over byte for byte,
    including the empty host of the unix-socket form `postgresql:///db`.
    """
    scheme, separator, rest = url.partition("://")
    if not separator or scheme.lower() not in _BARE_POSTGRES_SCHEMES:
        return url

    # Only the scheme is replaced, and the rest of the string is carried over
    # untouched. Round-tripping through urlsplit/urlunsplit looks tidier and is
    # wrong: with an empty host it collapses the socket form `postgresql:///db`
    # to `postgresql+psycopg:/db`, which SQLAlchemy cannot parse at all.
    return f"{PSYCOPG_SCHEME}://{rest}"


class MisconfiguredError(RuntimeError):
    """Raised at startup rather than serving requests with a known-bad secret."""


class Settings(BaseSettings):
    """Runtime config. Everything comes from the environment; nothing is committed."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # "production" makes the checks in `verify()` fatal. Railway sets it.
    app_env: str = "development"

    database_url: str = DEV_DATABASE_URL
    jwt_secret: str = DEV_JWT_SECRET
    allowed_origins: str = "http://localhost:5173"

    # Set on first run. When empty, the one-time setup route is open.
    initial_password_hash: str = ""

    access_token_minutes: int = 30
    refresh_token_days: int = 30

    # 6.14 — an updated_at further ahead than this is treated as clock skew.
    max_clock_skew_hours: int = 24

    @field_validator("database_url")
    @classmethod
    def _use_psycopg3(cls, value: str) -> str:
        """Normalised once, here, so the app and `alembic/env.py` cannot
        disagree — both read this setting and neither touches the raw
        environment variable."""
        return normalise_database_url(value)

    @property
    def origins(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.app_env.strip().lower() == "production"

    def verify(self) -> None:
        """Refuse to start a production deployment that is not configured.

        SPEC 8 forbids a default password, and the same reasoning covers every
        other credential with a value baked into the repository: a JWT secret
        anyone can read is a token anyone can mint. Failing at boot is loud.
        Serving requests with a known key is silent, and stays silent until it
        matters.
        """
        if not self.is_production:
            return

        problems: list[str] = []
        if not self.jwt_secret or self.jwt_secret == DEV_JWT_SECRET:
            problems.append("JWT_SECRET is unset or still the development value")
        if not self.database_url or self.database_url == DEV_DATABASE_URL:
            problems.append("DATABASE_URL is unset or still the development value")
        if not self.allowed_origins.strip() or "localhost" in self.allowed_origins:
            problems.append("ALLOWED_ORIGINS is unset or still points at localhost")
        # INITIAL_PASSWORD_HASH is deliberately not required: SPEC 8 allows a
        # one-time setup route instead, and with neither set login simply cannot
        # succeed. That is a locked door, not an open one.

        if problems:
            raise MisconfiguredError(
                "Refusing to start in production: " + "; ".join(problems)
            )


@lru_cache
def get_settings() -> Settings:
    return Settings()
