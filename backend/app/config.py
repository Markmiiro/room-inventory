from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

# The values that only make sense on a laptop. Booting with any of them in
# production means the deployment is not configured, and a JWT secret everyone
# can read in the repository is a signing key everyone can forge.
DEV_JWT_SECRET = "dev-only-not-a-real-secret"
DEV_DATABASE_URL = "postgresql+psycopg://supreme@localhost:5432/room_inventory"


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
