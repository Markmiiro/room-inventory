"""Field-level last-write-wins.

SPEC 5.4 resolves state entities "last-write-wins per field, by ``updated_at``,
ties broken by the lexically greater ``device_id``". Per *field* is the important
word: if one device renames a room while another changes its capacity, both
edits must survive. A whole-row comparison would throw one of them away.

Every state row therefore carries ``field_versions``, a map of field name to the
stamp of the write that last set it. Because the comparison is a total order over
``(updated_at, device_id)``, two devices merging the same operations in different
orders reach the same row.
"""

from datetime import datetime
from typing import Any, NamedTuple


class Stamp(NamedTuple):
    updated_at: datetime
    device_id: str

    def as_json(self) -> dict[str, str]:
        return {"updated_at": self.updated_at.isoformat(), "device_id": self.device_id}

    @classmethod
    def from_json(cls, raw: dict[str, str]) -> "Stamp":
        return cls(datetime.fromisoformat(raw["updated_at"]), raw["device_id"])


class MergeResult(NamedTuple):
    values: dict[str, Any]  # fields to write onto the row
    field_versions: dict[str, dict[str, str]]  # the new stamp map
    lost_fields: list[str]  # incoming fields the server's version beat
    changed_fields: list[str]  # fields the incoming write actually moved


def merge_fields(
    incoming: dict[str, Any],
    incoming_stamps: dict[str, Stamp],
    stored: dict[str, Any],
    stored_versions: dict[str, dict[str, str]],
) -> MergeResult:
    """Merge one pushed state entity into the row already held.

    ``incoming_stamps`` allows a per-field stamp; a client that only tracks a
    single row-level ``updated_at`` simply passes the same stamp for every field.
    """
    values: dict[str, Any] = {}
    versions = dict(stored_versions)
    lost: list[str] = []
    changed: list[str] = []

    for field, new_value in incoming.items():
        stamp = incoming_stamps[field]
        raw_existing = stored_versions.get(field)

        if raw_existing is None:
            # The server has never had a stamped write for this field, so the
            # incoming one is the only claim on it.
            values[field] = new_value
            versions[field] = stamp.as_json()
            if stored.get(field) != new_value:
                changed.append(field)
            continue

        existing = Stamp.from_json(raw_existing)
        if stamp > existing:
            values[field] = new_value
            versions[field] = stamp.as_json()
            if stored.get(field) != new_value:
                changed.append(field)
        elif stamp == existing:
            # The same write replayed. Idempotent by construction: leave it be.
            pass
        else:
            lost.append(field)

    return MergeResult(values=values, field_versions=versions, lost_fields=lost, changed_fields=changed)
