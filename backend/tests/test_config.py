"""The database URL, normalised once for everyone who reads it.

Railway supplies `postgresql://…`, SQLAlchemy maps that to psycopg2, and this
project installs psycopg 3 — so both the app and Alembic die with
`ModuleNotFoundError: No module named 'psycopg2'`. Alembic dies first, during
the release command, which makes a URL problem look like a migration problem.

The rewrite lives on the setting rather than at either call site, because the
app and `alembic/env.py` both read `get_settings().database_url` and the one
thing worse than fixing it in one place is fixing it in one of two.
"""

from app.config import PSYCOPG_SCHEME, Settings, normalise_database_url


class TestNormalisation:
    def test_rewrites_the_scheme_railway_actually_hands_out(self):
        assert (
            normalise_database_url("postgresql://user:pass@host:5432/railway")
            == "postgresql+psycopg://user:pass@host:5432/railway"
        )

    def test_rewrites_the_old_heroku_spelling_too(self):
        # `postgres://` still turns up in copied configuration.
        assert (
            normalise_database_url("postgres://user:pass@host:5432/db")
            == "postgresql+psycopg://user:pass@host:5432/db"
        )

    def test_leaves_a_url_that_is_already_right_alone(self):
        url = "postgresql+psycopg://user@host/db"
        assert normalise_database_url(url) == url

    def test_is_idempotent(self):
        once = normalise_database_url("postgresql://user@host/db")
        assert normalise_database_url(once) == once

    def test_respects_a_driver_someone_named_on_purpose(self):
        # Swapping this silently would hide the real answer, which is that the
        # project pins psycopg 3. An explicit choice gets an honest failure.
        url = "postgresql+psycopg2://user@host/db"
        assert normalise_database_url(url) == url

    def test_leaves_other_databases_alone(self):
        assert normalise_database_url("sqlite:///local.db") == "sqlite:///local.db"

    def test_keeps_the_query_string(self):
        # Managed Postgres commonly appends `?sslmode=require`, and losing it
        # turns a working deployment into a connection that is refused.
        assert (
            normalise_database_url("postgresql://u:p@host/db?sslmode=require")
            == "postgresql+psycopg://u:p@host/db?sslmode=require"
        )

    def test_keeps_credentials_that_contain_url_escapes(self):
        # Railway generates passwords with punctuation in them.
        url = "postgresql://user:p%40ss%2Fword@host:5432/db"
        assert normalise_database_url(url) == (
            "postgresql+psycopg://user:p%40ss%2Fword@host:5432/db"
        )

    def test_keeps_the_empty_host_of_the_unix_socket_form(self):
        # `postgresql:///db` connects over the local socket, and it is the form
        # this project's own README and e2e runner use. Rebuilding the URL
        # through urlunsplit collapses those three slashes to one and produces
        # something SQLAlchemy refuses to parse.
        assert (
            normalise_database_url("postgresql:///room_inventory")
            == "postgresql+psycopg:///room_inventory"
        )

    def test_ignores_a_string_that_is_not_a_url(self):
        assert normalise_database_url("room_inventory") == "room_inventory"

    def test_matches_the_scheme_case_insensitively(self):
        assert (
            normalise_database_url("POSTGRESQL://user@host/db")
            == "postgresql+psycopg://user@host/db"
        )

    def test_survives_an_empty_value(self):
        # An unset variable must not blow up before `verify()` can say so.
        assert normalise_database_url("") == ""


class TestSettingsUseIt:
    """The rewrite has to happen on the setting, or the two readers diverge."""

    def test_settings_normalise_on_construction(self):
        settings = Settings(database_url="postgresql://user@host/db")
        assert settings.database_url.startswith(f"{PSYCOPG_SCHEME}://")

    def test_the_app_and_alembic_read_the_same_normalised_value(self):
        # `app/db.py` builds its engine from this, and `alembic/env.py` sets
        # `sqlalchemy.url` from it. Same object, so they cannot disagree.
        settings = Settings(database_url="postgres://user@host/db")
        assert settings.database_url == "postgresql+psycopg://user@host/db"

    def test_a_bare_development_url_is_still_recognised_as_the_default(self):
        # `verify()` refuses to start production on the development database.
        # That check compares strings, so it has to see the normalised form.
        from app.config import DEV_DATABASE_URL, MisconfiguredError

        bare = DEV_DATABASE_URL.replace("postgresql+psycopg://", "postgresql://")
        settings = Settings(
            app_env="production",
            jwt_secret="a-real-secret-from-the-environment",
            database_url=bare,
            allowed_origins="https://rooms.example",
        )

        try:
            settings.verify()
        except MisconfiguredError as error:
            assert "DATABASE_URL" in str(error)
        else:
            raise AssertionError("should have refused the development database")
