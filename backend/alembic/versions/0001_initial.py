"""Initial schema: rooms, records, moves, sales, deaths, auth and sync bookkeeping.

Revision ID: 0001
Revises:
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

SEQ_DEFAULT = sa.text("nextval('global_seq')")


def _sync_columns() -> list[sa.Column]:
    return [
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("device_id", sa.String(64), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("seq", sa.BigInteger, server_default=SEQ_DEFAULT, nullable=False),
    ]


def upgrade() -> None:
    # One sequence for the whole database, so `seq` is monotonic across every
    # table and a client can pull with a single cursor.
    op.execute("CREATE SEQUENCE IF NOT EXISTS global_seq")

    op.create_table(
        "rooms",
        *_sync_columns(),
        sa.Column("field_versions", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("code", sa.String(8), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("capacity", sa.Integer, nullable=False),
        sa.Column("is_isolation", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("notes", sa.Text),
    )
    op.create_index("ix_rooms_seq", "rooms", ["seq"])
    # Codes are unique among live rooms only; a soft-deleted room must not block
    # its code being reused.
    op.execute(
        "CREATE UNIQUE INDEX uq_rooms_code_alive ON rooms (code) WHERE deleted_at IS NULL"
    )

    op.create_table(
        "records",
        *_sync_columns(),
        sa.Column("field_versions", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("species", sa.String(16), nullable=False),
        sa.Column("tag", sa.String(80), nullable=False),
        sa.Column("breed", sa.String(120)),
        sa.Column("sex", sa.String(8)),
        sa.Column("date_of_birth", sa.Date),
        sa.Column("arrival_date", sa.Date),
        sa.Column("initial_head_count", sa.Integer, nullable=False, server_default="1"),
        sa.Column("head_count", sa.Integer, nullable=False, server_default="1"),
        sa.Column("offspring_count", sa.Integer),
        sa.Column("offspring_updated_at", sa.Date),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("status", sa.String(8), nullable=False, server_default="active"),
        sa.Column("parent_record_id", sa.String(26), sa.ForeignKey("records.id")),
        sa.Column("notes", sa.Text),
        sa.Column("current_room_id", sa.String(26), sa.ForeignKey("rooms.id")),
    )
    op.create_index("ix_records_seq", "records", ["seq"])
    op.create_index("ix_records_parent", "records", ["parent_record_id"])
    op.create_index("ix_records_room", "records", ["current_room_id"])
    # SPEC 6.13 assumes thousands of rows; the active-list filter needs an index.
    op.create_index("ix_records_status_species", "records", ["status", "species"])

    op.create_table(
        "moves",
        *_sync_columns(),
        sa.Column("record_id", sa.String(26), sa.ForeignKey("records.id"), nullable=False),
        sa.Column("from_room_id", sa.String(26), sa.ForeignKey("rooms.id")),
        sa.Column("to_room_id", sa.String(26), sa.ForeignKey("rooms.id"), nullable=False),
        sa.Column("date", sa.Date, nullable=False),
        sa.Column("count", sa.Integer, nullable=False, server_default="1"),
        sa.Column("reason", sa.String(16), nullable=False),
        sa.Column("note", sa.Text),
    )
    op.create_index("ix_moves_seq", "moves", ["seq"])
    # Current location is the latest move by (date, created_at) — SPEC 4.1.
    op.create_index("ix_moves_record_date", "moves", ["record_id", "date", "created_at"])

    op.create_table(
        "sales",
        *_sync_columns(),
        sa.Column("record_id", sa.String(26), sa.ForeignKey("records.id"), nullable=False),
        sa.Column("date", sa.Date, nullable=False),
        sa.Column("price", sa.BigInteger, nullable=False),
        sa.Column("count", sa.Integer, nullable=False, server_default="1"),
        sa.Column("customer_id", sa.String(26)),
        sa.Column("notes", sa.Text),
    )
    op.create_index("ix_sales_seq", "sales", ["seq"])
    op.create_index("ix_sales_record", "sales", ["record_id"])

    op.create_table(
        "deaths",
        *_sync_columns(),
        sa.Column("record_id", sa.String(26), sa.ForeignKey("records.id"), nullable=False),
        sa.Column("date", sa.Date, nullable=False),
        sa.Column("count", sa.Integer, nullable=False, server_default="1"),
        sa.Column("cause", sa.String(16), nullable=False),
        sa.Column("vet_id", sa.String(26)),
        sa.Column("notes", sa.Text),
    )
    op.create_index("ix_deaths_seq", "deaths", ["seq"])
    op.create_index("ix_deaths_record", "deaths", ["record_id"])

    op.create_table(
        "users",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "refresh_tokens",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("token_hash", sa.String(128), nullable=False, unique=True),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
    )

    op.create_table(
        "sync_anomalies",
        sa.Column("id", sa.String(26), primary_key=True),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("entity", sa.String(32), nullable=False),
        sa.Column("entity_id", sa.String(26), nullable=False),
        sa.Column("detail", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_sync_anomalies_entity", "sync_anomalies", ["entity_id"])


def downgrade() -> None:
    for table in ("sync_anomalies", "refresh_tokens", "users", "deaths", "sales", "moves", "records", "rooms"):
        op.drop_table(table)
    op.execute("DROP SEQUENCE IF EXISTS global_seq")
