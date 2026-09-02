"""Test fixtures.

Tests run against a real PostgreSQL database created from the Alembic
migrations, not from ``metadata.create_all``. The sync engine leans on
Postgres-specific behaviour — one shared sequence, JSONB, a partial unique
index — so testing against anything else would be testing a different system.
"""

import os
import subprocess
from datetime import datetime, timedelta, timezone

import pytest

TEST_DB = os.environ.get("TEST_DATABASE_NAME", "room_inventory_test")
TEST_URL = os.environ.get(
    "TEST_DATABASE_URL", f"postgresql+psycopg:///{TEST_DB}"
)

os.environ["DATABASE_URL"] = TEST_URL
os.environ["JWT_SECRET"] = "test-secret"
os.environ["ALLOWED_ORIGINS"] = "http://localhost:5173"


@pytest.fixture(scope="session", autouse=True)
def migrated_database():
    subprocess.run(["dropdb", "--if-exists", TEST_DB], check=True)
    subprocess.run(["createdb", TEST_DB], check=True)
    subprocess.run(
        ["alembic", "upgrade", "head"],
        check=True,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        env={**os.environ, "DATABASE_URL": TEST_URL},
    )
    yield


@pytest.fixture
def db(migrated_database):
    from app.db import SessionLocal, engine
    from sqlalchemy import text

    # Every synced table, so one test cannot see another's rows. The list has to
    # be complete: a table left out here leaks across tests, and the symptom is
    # a test that passes alone and fails in the suite. `CASCADE` handles the
    # foreign keys between them, and the seeded rows a migration wrote go too —
    # tests that need rooms or schedules push their own.
    with engine.begin() as conn:
        conn.execute(
            text(
                "TRUNCATE moves, sales, deaths, purchases, health_records, "
                "expenses, expense_categories, customers, vets, "
                "treatment_schedules, records, rooms, "
                "sync_anomalies, refresh_tokens, users RESTART IDENTITY CASCADE"
            )
        )
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def client(db):
    from fastapi.testclient import TestClient

    from app.auth import require_auth
    from app.db import get_db
    from app.main import app

    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[require_auth] = lambda: "test-user"
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Builders. ULIDs are 26 characters; tests use readable stand-ins of that width.
# ---------------------------------------------------------------------------


def ulid(label: str) -> str:
    return label.upper().ljust(26, "0")[:26]


def ts(offset_seconds: int = 0) -> str:
    return (datetime(2026, 8, 31, 9, 0, 0, tzinfo=timezone.utc) + timedelta(seconds=offset_seconds)).isoformat()


def op_room(id_: str, at: str, **fields):
    data = {"code": "R1", "name": "Front room", "capacity": 20, "is_isolation": False}
    data.update(fields)
    return {"op": "upsert", "entity": "room", "id": id_, "data": data, "updated_at": at}


def op_record(id_: str, at: str, **fields):
    data = {
        "kind": "animal",
        "species": "cattle",
        "tag": "C-084",
        "source": "bought",
        "status": "active",
        "initial_head_count": 1,
    }
    data.update(fields)
    return {"op": "upsert", "entity": "record", "id": id_, "data": data, "updated_at": at}


def op_move(id_: str, at: str, record_id: str, to_room_id: str, **fields):
    data = {
        "record_id": record_id,
        "from_room_id": None,
        "to_room_id": to_room_id,
        "date": "2026-08-31",
        "count": 1,
        "reason": "routine",
    }
    data.update(fields)
    return {"op": "insert", "entity": "move", "id": id_, "data": data, "updated_at": at}


def op_sale(id_: str, at: str, record_id: str, count: int, price: int = 500_000):
    return {
        "op": "insert",
        "entity": "sale",
        "id": id_,
        "data": {"record_id": record_id, "date": "2026-08-31", "price": price, "count": count},
        "updated_at": at,
    }


def op_purchase(
    id_: str, at: str, record_id: str, price: int = 1_500_000, count: int = 1, seller: str = "Nakawa market"
):
    return {
        "op": "insert",
        "entity": "purchase",
        "id": id_,
        "data": {
            "record_id": record_id,
            "date": "2026-08-31",
            "price": price,
            "seller": seller,
            "count": count,
        },
        "updated_at": at,
    }


def op_health(
    id_: str, at: str, record_id: str, type_: str = "vaccination", **fields
):
    data = {"record_id": record_id, "type": type_, "date": "2026-08-31"}
    data.update(fields)
    return {"op": "insert", "entity": "health_record", "id": id_, "data": data, "updated_at": at}


def op_schedule(id_: str, at: str, **fields):
    data = {
        "name": "Deworming",
        "species": "cattle",
        "type": "deworming",
        "first_due_age_days": 60,
        "repeat_every_days": 90,
        "applies_to": "both",
        "is_active": True,
    }
    data.update(fields)
    return {
        "op": "upsert",
        "entity": "treatment_schedule",
        "id": id_,
        "data": data,
        "updated_at": at,
    }


def op_expense(id_: str, at: str, category_id: str, amount: int = 50_000, **fields):
    data = {
        "amount": amount,
        "category_id": category_id,
        "date": "2026-08-31",
        "applies_to": "farm",
    }
    data.update(fields)
    return {"op": "insert", "entity": "expense", "id": id_, "data": data, "updated_at": at}


def op_category(id_: str, at: str, name: str = "Feed"):
    return {
        "op": "upsert",
        "entity": "expense_category",
        "id": id_,
        "data": {"name": name, "is_archived": False},
        "updated_at": at,
    }


def push(client, device_id: str, operations: list[dict]):
    response = client.post(
        "/sync/push", json={"device_id": device_id, "operations": operations}
    )
    assert response.status_code == 200, response.text
    return response.json()


def statuses(body: dict) -> list[str]:
    return [r["status"] for r in body["results"]]
