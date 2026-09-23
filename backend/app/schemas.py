"""Pydantic v2 wire models."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# The entity names a client may push. Split by class, because the two are
# merged by completely different rules (SPEC 3.2, 5.4).
# `vet_visit` is here rather than in EVENT_ENTITIES despite SPEC 16 calling it
# an event: a visit is marked completed and annotated after it is created, which
# an append-only row cannot express. See the docstring on models.VetVisit.
STATE_ENTITIES = {"room", "record", "treatment_schedule", "vet_visit", "store", "produce_type"}
EVENT_ENTITIES = {
    "move", "sale", "death", "purchase", "health_record", "expense", "visit_note",
    # SPEC 22. A birth happened on a day; a mistake is corrected by adding
    # another row, never by editing this one.
    "birth",
    # SPEC 20.13. Intakes, outtakes and counts are append-only: the balance is
    # derived by folding them (SPEC 20.8), so an edited event would silently
    # restate a balance rather than correct it. A mistake is corrected by adding
    # a stock count, which is exactly what one is for.
    "stock_intake", "stock_outtake", "stock_count",
}
SYNCED_ENTITIES = STATE_ENTITIES | EVENT_ENTITIES

EntityName = Literal[
    "room", "record", "move", "sale", "death", "purchase", "health_record",
    "expense_category", "customer", "vet", "expense", "treatment_schedule",
    "vet_visit", "visit_note", "birth",
    "store", "produce_type", "stock_intake", "stock_outtake", "stock_count",
]


class Operation(BaseModel):
    op: Literal["upsert", "insert"]
    entity: EntityName
    id: str = Field(min_length=1, max_length=26)
    data: dict[str, Any]
    updated_at: datetime

    # Optional per-field stamps. A client that tracks only a row-level
    # updated_at omits this and every field inherits the operation's stamp.
    field_updated_at: dict[str, datetime] | None = None


class PushRequest(BaseModel):
    device_id: str = Field(min_length=1, max_length=64)
    operations: list[Operation] = Field(max_length=500)


class OperationResult(BaseModel):
    id: str
    entity: EntityName
    # applied  — the write landed
    # duplicate — already seen, safe to drop from the outbox (SPEC 5.3)
    # conflict — the server's version won at least one field; `server` holds it
    # rejected — will never succeed; the client should stop retrying
    status: Literal["applied", "duplicate", "conflict", "rejected"]
    server: dict[str, Any] | None = None
    message: str | None = None


class PushResponse(BaseModel):
    results: list[OperationResult]
    head_seq: int
    server_time: datetime


class PullChange(BaseModel):
    entity: EntityName
    id: str
    seq: int
    data: dict[str, Any]


class PullResponse(BaseModel):
    changes: list[PullChange]
    cursor: int
    has_more: bool
    server_time: datetime


class LoginRequest(BaseModel):
    password: str = Field(min_length=1, max_length=256)


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int


class RefreshRequest(BaseModel):
    refresh_token: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=10, max_length=256)


class Problem(BaseModel):
    """RFC 7807. `code` is what the outbox drain branches on (SPEC 7)."""

    model_config = ConfigDict(populate_by_name=True)

    type: str = "about:blank"
    title: str
    status: int
    detail: str | None = None
    code: str
