"""SPEC 22 — births.

The reason this feature exists is a silent failure: an animal born on the farm
had no date of birth, so no treatment schedule fired for it and no sale
readiness computed (SPEC 13.4, 15.3). The server's part is small — a birth is
an event, and events are the easy half of sync — so these tests concentrate on
the two places it could still go wrong: the derived head count of an offspring
group that lost some at birth, and the renamed offspring column.
"""

from tests.conftest import (
    op_birth,
    op_death,
    op_record,
    op_room,
    push,
    statuses,
    ts,
    ulid,
)


def test_a_birth_is_accepted_as_an_event(client):
    dam = ulid("dam")
    body = push(
        client,
        "device-a",
        [
            op_record(dam, ts(0), sex="female", date_of_birth="2023-05-01"),
            op_birth(ulid("b1"), ts(1), dam, born_count=1, surviving_count=1),
        ],
    )
    assert statuses(body) == ["applied", "applied"]


def test_pushing_the_same_birth_twice_is_harmless(client):
    """SPEC 5.3 — a push that lands but whose response is lost must be
    retryable. A birth replayed as a second birth would double an animal's
    recorded offspring."""
    dam = ulid("dam")
    push(client, "device-a", [op_record(dam, ts(0), sex="female")])
    first = push(client, "device-a", [op_birth(ulid("b1"), ts(1), dam)])
    again = push(client, "device-a", [op_birth(ulid("b1"), ts(1), dam)])

    assert statuses(first) == ["applied"]
    assert statuses(again) == ["duplicate"]


def test_a_birth_with_no_dam_is_rejected_rather_than_retried_forever(client):
    """A malformed operation will never succeed, so it is named and dropped
    rather than left to block everything queued behind it (SPEC 7)."""
    body = push(
        client,
        "device-a",
        [{"op": "insert", "entity": "birth", "id": ulid("b1"),
          "data": {"date": "2026-09-01", "born_count": 1, "surviving_count": 1},
          "updated_at": ts(0)}],
    )
    assert statuses(body) == ["rejected"]
    assert "dam_record_id" in body["results"][0]["message"]


def test_the_offspring_records_carry_their_parentage(client):
    dam, sire, calf = ulid("dam"), ulid("sire"), ulid("calf")
    push(
        client,
        "device-a",
        [
            op_record(dam, ts(0), sex="female"),
            op_record(sire, ts(0), tag="C-900", sex="male"),
            op_birth(ulid("b1"), ts(1), dam, sire_record_id=sire),
            op_record(
                calf,
                ts(2),
                tag="C-084-1",
                sex="female",
                date_of_birth="2026-09-01",
                source="born_here",
                dam_record_id=dam,
                sire_record_id=sire,
                birth_id=ulid("b1"),
            ),
        ],
    )

    rows = client.get("/sync/pull?since=0").json()["changes"]
    stored = next(r["data"] for r in rows if r["entity"] == "record" and r["id"] == calf)
    assert stored["dam_record_id"] == dam
    assert stored["sire_record_id"] == sire
    assert stored["birth_id"] == ulid("b1")
    # The whole point of the feature: an exact date, on the server too.
    assert stored["date_of_birth"] == "2026-09-01"


def test_an_animal_added_as_born_here_names_its_parents_without_a_birth(client):
    """SPEC 22.9 — the Add form links an existing animal to its mother and names
    an outside father, with no Birth row behind it."""
    dam, calf = ulid("dam"), ulid("calf")
    body = push(
        client,
        "device-a",
        [
            op_record(dam, ts(0), sex="female"),
            op_record(
                calf,
                ts(1),
                tag="C-085",
                sex="female",
                source="born_here",
                dam_record_id=dam,
                sire_name="Neighbour's Boran bull",
            ),
        ],
    )
    assert statuses(body) == ["applied", "applied"]

    rows = client.get("/sync/pull?since=0").json()["changes"]
    stored = next(r["data"] for r in rows if r["entity"] == "record" and r["id"] == calf)
    assert stored["dam_record_id"] == dam
    assert stored["sire_name"] == "Neighbour's Boran bull"
    assert stored["birth_id"] is None
    assert not [r for r in rows if r["entity"] == "birth"]


def test_stillbirths_reduce_the_offspring_group_by_derivation(client):
    """SPEC 22 and 3.4 — the head count is derived from the events.

    A hatch of 20 with 18 surviving is one group record of 20 and a Death of 2.
    Nothing types 18 anywhere: the server subtracts it, which is what stops two
    devices' arithmetic overwriting each other (SPEC 6.7).
    """
    dam, chicks = ulid("dam"), ulid("chicks")
    push(
        client,
        "device-a",
        [
            op_record(dam, ts(0), kind="group", species="hens", tag="H-Layers",
                      initial_head_count=12),
            op_birth(ulid("b1"), ts(1), dam, born_count=20, surviving_count=18),
            op_record(chicks, ts(2), kind="group", species="hens", tag="H-Layers-1",
                      initial_head_count=20, source="born_here", dam_record_id=dam,
                      birth_id=ulid("b1")),
            op_death(ulid("d1"), ts(3), chicks, count=2, cause="stillbirth"),
        ],
    )

    rows = client.get("/sync/pull?since=0").json()["changes"]
    stored = next(r["data"] for r in rows if r["entity"] == "record" and r["id"] == chicks)
    assert stored["initial_head_count"] == 20
    assert stored["head_count"] == 18
    # And the dam is untouched: giving birth takes nothing out of her.
    mother = next(r["data"] for r in rows if r["entity"] == "record" and r["id"] == dam)
    assert mother["head_count"] == 12
    assert mother["status"] == "active"


def test_an_individual_stillbirth_marks_only_the_offspring_dead(client):
    """The Death hangs off the offspring's own record, never the mother's.

    Against the dam it would have reduced *her* head count and, for a single
    animal, marked the mother dead — which is why every offspring born gets a
    record, survivors and losses alike.
    """
    dam, lost = ulid("dam"), ulid("lost")
    push(
        client,
        "device-a",
        [
            op_record(dam, ts(0), sex="female"),
            op_birth(ulid("b1"), ts(1), dam, born_count=1, surviving_count=0),
            op_record(lost, ts(2), tag="C-084-1", source="born_here",
                      date_of_birth="2026-09-01", dam_record_id=dam, birth_id=ulid("b1")),
            op_death(ulid("d1"), ts(3), lost, count=1, cause="stillbirth"),
        ],
    )

    rows = client.get("/sync/pull?since=0").json()["changes"]
    stored = next(r["data"] for r in rows if r["entity"] == "record" and r["id"] == lost)
    assert (stored["head_count"], stored["status"]) == (0, "dead")
    mother = next(r["data"] for r in rows if r["entity"] == "record" and r["id"] == dam)
    assert (mother["head_count"], mother["status"]) == (1, "active")


def test_two_devices_recording_births_offline_keep_both(client):
    """SPEC 5.4 — events never conflict, and the merge is the union.

    Two births on one dam are two births. Resolving them into one would discard
    an animal that exists.
    """
    dam = ulid("dam")
    push(client, "device-a", [op_record(dam, ts(0), sex="female")])
    push(client, "device-a", [op_birth(ulid("b1"), ts(1), dam, date="2026-09-01")])
    push(client, "device-b", [op_birth(ulid("b2"), ts(1), dam, date="2026-09-01")])

    rows = client.get("/sync/pull?since=0").json()["changes"]
    births = [r for r in rows if r["entity"] == "birth"]
    assert {b["id"] for b in births} == {ulid("b1"), ulid("b2")}


def test_a_birth_in_the_same_batch_as_its_offspring_lands_in_order(client):
    """The birth is queued first and the offspring's `birth_id` carries no
    foreign key, so neither ordering nor a missing birth can cost the animal."""
    dam, calf = ulid("dam"), ulid("calf")
    body = push(
        client,
        "device-a",
        [
            op_record(dam, ts(0), sex="female"),
            # Deliberately the wrong way round.
            op_record(calf, ts(2), tag="C-084-1", source="born_here",
                      dam_record_id=dam, birth_id=ulid("b1")),
            op_birth(ulid("b1"), ts(1), dam),
        ],
    )
    assert statuses(body) == ["applied", "applied", "applied"]


# ---------------------------------------------------------------------------
# The renamed offspring column
# ---------------------------------------------------------------------------


def test_the_offspring_baseline_is_stored_under_its_new_name(client):
    dam = ulid("dam")
    push(
        client,
        "device-a",
        [op_record(dam, ts(0), sex="female", offspring_baseline=2,
                   offspring_baseline_updated_at="2026-08-12")],
    )
    rows = client.get("/sync/pull?since=0").json()["changes"]
    stored = next(r["data"] for r in rows if r["entity"] == "record")
    assert stored["offspring_baseline"] == 2
    assert stored["offspring_baseline_updated_at"] == "2026-08-12"


def test_the_old_field_name_is_still_accepted(client):
    """A device that was offline when the rename shipped is still holding outbox
    entries spelled the old way. Unknown fields are ignored rather than
    rejected, which here would silently drop a number somebody typed."""
    dam = ulid("dam")
    push(client, "device-a", [op_record(dam, ts(0), sex="female", offspring_count=3,
                                        offspring_updated_at="2026-07-01")])

    rows = client.get("/sync/pull?since=0").json()["changes"]
    stored = next(r["data"] for r in rows if r["entity"] == "record")
    assert stored["offspring_baseline"] == 3
    assert stored["offspring_baseline_updated_at"] == "2026-07-01"


def test_the_new_name_wins_when_a_client_sends_both(client):
    dam = ulid("dam")
    push(
        client,
        "device-a",
        [op_record(dam, ts(0), sex="female", offspring_count=3, offspring_baseline=5)],
    )
    rows = client.get("/sync/pull?since=0").json()["changes"]
    stored = next(r["data"] for r in rows if r["entity"] == "record")
    assert stored["offspring_baseline"] == 5


def test_a_birth_never_writes_the_baseline(client):
    """SPEC 22 — one source of truth. The typed figure is what happened before
    births were recorded, and the app adds the two at display time rather than
    accumulating into the field somebody typed."""
    dam = ulid("dam")
    push(client, "device-a", [op_record(dam, ts(0), sex="female", offspring_baseline=2)])
    push(client, "device-a", [op_birth(ulid("b1"), ts(1), dam, born_count=2, surviving_count=2)])

    rows = client.get("/sync/pull?since=0").json()["changes"]
    stored = next(r["data"] for r in rows if r["entity"] == "record")
    assert stored["offspring_baseline"] == 2


def test_births_come_down_the_pull_cursor_like_any_other_entity(client):
    dam = ulid("dam")
    push(client, "device-a", [op_record(dam, ts(0), sex="female")])
    push(client, "device-a", [op_birth(ulid("b1"), ts(1), dam)])

    entities = {r["entity"] for r in client.get("/sync/pull?since=0").json()["changes"]}
    assert "birth" in entities
