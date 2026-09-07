import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { PlusIcon, SearchIcon } from "../components/Icons";
import { todayInEAT } from "../db/ids";
import { activeRecords, liveRooms } from "../db/queries";
import { META, getMeta, setMeta } from "../db/schema";
import type { Record_, Room, Species } from "../db/types";
import { AGE_UNKNOWN_CHIP, isAgeUnknown } from "../domain/age";
import { formatAge, headUnit, plural } from "../domain/format";
import { ALL_SPECIES, BIRD_SPECIES, MAMMAL_SPECIES, isBird, speciesLabel } from "../domain/rules";
import { useLiveQuery } from "../sync/useSync";

/**
 * SPEC 18 — what the filter row can be set to.
 *
 * `birds` is a real filter value, not just a heading: "show me the birds" is a
 * question worth asking on a farm holding four kinds of them, and it is also
 * what keeps the top row down to six chips. See the chip row below.
 */
type SpeciesFilter = Species | "birds" | "all";

function matchesSpeciesFilter(species: Species, filter: SpeciesFilter): boolean {
  if (filter === "all") return true;
  if (filter === "birds") return isBird(species);
  return species === filter;
}

/** SPEC 6.13 — every list assumes thousands of rows. Rendering them all would
 *  make the screen unusable on the phone this app is for, so the list is capped
 *  and says so, with search and the species filter as the way through it. */
const PAGE = 100;

/**
 * Animals — every active record on the farm, grouped by species.
 *
 * Laid out against `screenshots/04-animals-list.png`, with two of the mockup's
 * defects left out: the search placeholder says "tags" rather than "IDs"
 * (SPEC 2 bans "ID"), and the sample data's "Finisher Pen A" is exactly the
 * banned vocabulary SPEC 12 warns about. The mockup's per-row alert marker
 * needs the Alerts rules, which are not built yet.
 */
export function AnimalsScreen() {
  const records = useLiveQuery(activeRecords, [], [] as Record_[]);
  const rooms = useLiveQuery(liveRooms, [], [] as Room[]);

  const [search, setSearch] = useState("");
  const [species, setSpecies] = useState<SpeciesFilter>("all");
  // SPEC 13.4 — a filter for the records whose age cannot be computed, so the
  // list of what to fix in is reachable rather than only countable on Alerts.
  const [ageUnknownOnly, setAgeUnknownOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  const roomById = useMemo(() => new Map(rooms.map((room) => [room.id, room])), [rooms]);

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return records
      .filter((record) => matchesSpeciesFilter(record.species, species))
      .filter((record) => !ageUnknownOnly || isAgeUnknown(record))
      .filter(
        (record) =>
          !needle ||
          record.tag.toLowerCase().includes(needle) ||
          (record.breed ?? "").toLowerCase().includes(needle) ||
          speciesLabel(record.species).toLowerCase().includes(needle),
      )
      .sort((a, b) =>
        a.species === b.species
          ? a.tag.localeCompare(b.tag)
          : ALL_SPECIES.indexOf(a.species) - ALL_SPECIES.indexOf(b.species),
      );
  }, [records, search, species, ageUnknownOnly]);

  // The bird row is open while the birds are the subject, whether that is all
  // of them or one of them.
  const birdsOpen = species === "birds" || (species !== "all" && isBird(species));

  function choose(next: SpeciesFilter) {
    setSpecies(next);
    setLimit(PAGE);
  }

  const shown = matches.slice(0, limit);
  const missingAge = useMemo(() => records.filter(isAgeUnknown).length, [records]);
  const animals = matches.filter((r) => r.kind === "animal").length;
  const groups = matches.length - animals;

  // Section headers, so a long list stays readable while scrolling past it.
  const sections = useMemo(() => {
    const bySpecies = new Map<Species, Record_[]>();
    for (const record of shown) {
      const list = bySpecies.get(record.species) ?? [];
      list.push(record);
      bySpecies.set(record.species, list);
    }
    return [...bySpecies.entries()];
  }, [shown]);

  return (
    <div className="pb-40 md:pb-24">
      <div className="relative">
        <SearchIcon className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          className="field pl-12"
          placeholder="Search animals, groups or tags"
          aria-label="Search animals, groups or tags"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setLimit(PAGE);
          }}
        />
      </div>

      {/*
        SPEC 18 — eight species, six chips.
        Splitting poultry into four would have made this row nine chips wide on
        a 390px screen. Every one of them would have been off the edge of it,
        reachable only by swiping a horizontal strip with no indication that
        there was anything further along — the species at the end would simply
        have stopped existing for anyone who did not think to drag.

        So the birds collapse into one chip, and the four open in a second row
        underneath when it is chosen. That keeps the top row at six, which is
        one fewer than it held before the split, and it makes "show me the
        birds" answerable in a tap — a question worth asking on a farm that
        keeps four kinds of them, and one the old single `poultry` value could
        answer only by accident.

        The second row appears only when it is relevant, so nobody who keeps no
        birds ever sees it.
      */}
      <div className="mt-3 flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Filter by species">
        <FilterChip active={species === "all"} onClick={() => choose("all")}>
          All
        </FilterChip>
        {MAMMAL_SPECIES.map((option) => (
          <FilterChip key={option} active={species === option} onClick={() => choose(option)}>
            {speciesLabel(option)}
          </FilterChip>
        ))}
        {/* Stays active while one of the four is chosen, so the row below it
            never appears to belong to nothing. */}
        <FilterChip active={birdsOpen} onClick={() => choose("birds")}>
          Birds
        </FilterChip>
      </div>

      {birdsOpen && (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Filter by bird">
          <FilterChip active={species === "birds"} onClick={() => choose("birds")}>
            All birds
          </FilterChip>
          {BIRD_SPECIES.map((option) => (
            <FilterChip key={option} active={species === option} onClick={() => choose(option)}>
              {speciesLabel(option)}
            </FilterChip>
          ))}
        </div>
      )}

      {/* Kept out of the species row: it is a different question, and it only
          appears when there is something to find (SPEC 13.4). */}
      {missingAge > 0 && (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          <FilterChip
            active={ageUnknownOnly}
            onClick={() => {
              setAgeUnknownOnly((on) => !on);
              setLimit(PAGE);
            }}
          >
            No date of birth · {missingAge}
          </FilterChip>
        </div>
      )}

      <PoultrySplitNote />

      <p className="data-label mt-3">
        {animals} {plural(animals, "animal")} · {groups} {plural(groups, "group")}
      </p>

      {matches.length === 0 ? (
        <p className="card p-6 mt-4 text-body-md text-text-muted text-center">
          {records.length === 0
            ? "No animals yet. Add the first one below."
            : ageUnknownOnly
              ? "Every record has an age. Nothing is missing a date of birth."
              : "Nothing matches that search."}
        </p>
      ) : (
        sections.map(([group, rows]) => (
          <section key={group} className="mt-6">
            <h2 className="text-headline-sm text-primary">{speciesLabel(group)}</h2>
            <ul className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {rows.map((record) => (
                <li key={record.id}>
                  <AnimalRow record={record} room={roomById.get(record.current_room_id ?? "")} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {matches.length > shown.length && (
        <button
          type="button"
          className="btn-quiet w-full mt-4"
          onClick={() => setLimit((n) => n + PAGE)}
        >
          Show more · {matches.length - shown.length} left
        </button>
      )}

      <Link
        to="/add"
        aria-label="Add animal"
        className="btn-secondary fixed right-4 bottom-24 md:bottom-8 z-30 h-14 w-14 !px-0 rounded-xl"
      >
        <PlusIcon className="w-7 h-7" />
      </Link>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`chip shrink-0 min-h-touch md:min-h-touch-desktop px-4 border ${
        active
          ? "bg-primary text-white border-primary"
          : "bg-card text-text border-border"
      }`}
    >
      {children}
    </button>
  );
}

function AnimalRow({ record, room }: { record: Record_; room: Room | undefined }) {
  const since = record.date_of_birth ?? record.arrival_date;
  const age = since ? formatAge(since, todayInEAT()) : null;

  const unknownAge = isAgeUnknown(record);

  const detail = [
    record.breed,
    record.kind === "animal" ? (record.sex === "male" ? "M" : record.sex ? "F" : null) : null,
    record.kind === "group" ? `${record.head_count} ${headUnit(record.head_count)}` : null,
    age,
  ].filter(Boolean);

  return (
    <Link
      to={`/records/${record.id}`}
      className="card flex items-center justify-between gap-3 p-4 min-h-row"
    >
      <div className="min-w-0">
        <p className="flex items-center gap-2">
          <span
            className={`chip ${
              record.kind === "group" ? "bg-action text-action-text" : "bg-success text-success-text"
            }`}
          >
            {record.kind}
          </span>
          <span className="data-value font-bold truncate">{record.tag}</span>
        </p>
        <p className="text-body-md text-text-muted truncate mt-1">
          {detail.length > 0 ? detail.join(" · ") : speciesLabel(record.species)}
        </p>
      </div>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <span className="chip bg-background text-text-muted border border-border">
          {room?.code ?? "No room"}
        </span>
        {/* SPEC 13.4 — in words, on the row. Colour alone would not say it. */}
        {unknownAge && (
          <span className="chip bg-alert-bg text-alert-text">{AGE_UNKNOWN_CHIP}</span>
        )}
      </span>
    </Link>
  );
}

/**
 * What the SPEC 18 split changed, said out loud.
 *
 * The migration moved every `poultry` record onto `hens` because that is the
 * only defensible destination — but it is still a guess for any bird that was
 * not a hen, and the app is the one thing that cannot tell which. The person
 * holding the phone can.
 *
 * So the count is shown rather than logged, once, with the filter that reaches
 * the rows in question. A migration that silently retyped part of the flock and
 * mentioned it nowhere would be indistinguishable from data loss — the records
 * would still be there, saying the wrong thing, and nothing would ever prompt
 * anyone to look.
 *
 * It is dismissible and does not come back: this is information, not an alert,
 * and SPEC 4.6 keeps those separate.
 */
function PoultrySplitNote() {
  const moved = useLiveQuery(() => getMeta(META.poultrySplit, 0), [], 0);
  const seen = useLiveQuery(() => getMeta(META.poultrySplitSeen, false), [], false);

  if (!moved || seen) return null;

  return (
    <div className="card p-4 mt-3">
      <p className="text-body-md text-text">
        {moved} {plural(moved, "record")} moved from Poultry to Hens.
      </p>
      <p className="text-body-md text-text-muted mt-1">
        Poultry is now four species — hens, ducks, geese and turkeys. Anything that
        was not a hen needs changing on the record itself.
      </p>
      <button
        type="button"
        className="chip mt-3 min-h-touch md:min-h-touch-desktop px-4 border border-border bg-card text-text"
        onClick={() => void setMeta(META.poultrySplitSeen, true)}
      >
        Done
      </button>
    </div>
  );
}
