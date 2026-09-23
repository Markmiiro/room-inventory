import type { Birth, Death, Record_, Sale } from "../db/types";
import { plural } from "./format";

/**
 * SPEC 22 — the rules a birth obeys, as pure functions.
 *
 * They live here rather than in the form for the reason SPEC 4 gives about
 * every other derived value: the screen is not the only caller. The same
 * eligibility rule decides whether Record detail offers "Log birth" and whether
 * the Log birth screen accepts a dam picked from the Calendar, and an offspring
 * total that was worked out inside a component could not be tested without
 * rendering one.
 *
 * The one thing this module deliberately does not do is compute an offspring
 * figure by overwriting anything. The typed baseline and the counted births are
 * two separate numbers with two separate origins, and they are added at the
 * point of display. See `offspringTotal`.
 */

/**
 * Whether a record can be a dam.
 *
 * SPEC 22: only offered on female animals — and a group can be the dam of a
 * hatch. A group has no sex, because a group is not one animal; refusing groups
 * to keep the rule tidy would mean the hatch the spec explicitly names could
 * not be recorded at all.
 *
 * Males are excluded rather than warned about. An animal recorded as male did
 * not give birth, and the useful thing to do with a sire is name him on the
 * birth — which `sire_record_id` is for.
 */
export function canBeDam(record: Record_): boolean {
  if (record.deleted_at) return false;
  if (record.kind === "group") return true;
  return record.sex === "female";
}

/** Whether a record can be named as the sire: any male animal on the farm,
 *  sold or dead included — he may well have been sold since. */
export function canBeSire(record: Record_): boolean {
  return !record.deleted_at && record.kind === "animal" && record.sex === "male";
}

/**
 * When a dam stopped being on the farm, if she has.
 *
 * SPEC 22 allows a backdated birth against a dam who has since been sold or
 * died, because the birth really happened and refusing it would lose it. The
 * date is needed for the warning: a birth dated *after* she left is either a
 * typo or a record of somebody else's animal, and both want a person to look.
 */
export function departureDate(
  record: Record_,
  sales: Sale[],
  deaths: Death[],
): string | null {
  const dates = [
    ...sales.filter((s) => s.record_id === record.id && !s.deleted_at).map((s) => s.date),
    ...deaths.filter((d) => d.record_id === record.id && !d.deleted_at).map((d) => d.date),
  ];
  if (dates.length === 0) return null;
  // The last one: a group sold in parts left over several days, and the birth
  // is only questionable once every head had gone.
  return dates.sort()[dates.length - 1]!;
}

export interface BirthDraft {
  dam: Record_;
  date: string;
  bornCount: number;
  survivingCount: number;
}

export interface BirthProblem {
  /** Blocks the entry. */
  error: string | null;
  /** Lets the entry through, having said what looks wrong (SPEC 4.2's rule
   *  about warning rather than blocking, restated for a date nobody else can
   *  check). */
  warning: string | null;
}

/**
 * What is wrong with a birth, if anything.
 *
 * The split between error and warning is the whole point of returning both. A
 * count that contradicts itself is arithmetic and cannot be right, so it is
 * refused. A date that sits oddly against a dam who has left the farm is a
 * judgement only the person holding the phone can make, so it is named and
 * allowed — refusing it would push somebody into typing a different date to get
 * past the form, which is a worse record than a true one with a warning on it.
 */
export function checkBirth(draft: BirthDraft, today: string): BirthProblem {
  const { dam, date, bornCount, survivingCount } = draft;

  if (!canBeDam(dam)) {
    return {
      error:
        dam.kind === "animal" && dam.sex === "male"
          ? `${dam.tag} is recorded as male. A birth is logged against the mother.`
          : `${dam.tag} cannot be recorded as a mother.`,
      warning: null,
    };
  }

  if (!Number.isInteger(bornCount) || bornCount < 1) {
    return { error: "How many were born must be a whole number, 1 or more.", warning: null };
  }
  if (!Number.isInteger(survivingCount) || survivingCount < 0) {
    return { error: "How many survived must be a whole number, or zero.", warning: null };
  }
  if (survivingCount > bornCount) {
    return {
      error: `More surviving (${survivingCount}) than born (${bornCount}). Check both numbers.`,
      warning: null,
    };
  }

  // SPEC 6.8 and 22 — never in the future, backdating always allowed.
  if (date > today) return { error: "A birth cannot be dated in the future.", warning: null };

  // SPEC 22 — a birth cannot precede the dam's own date of birth. This is the
  // one date comparison that is an error rather than a warning: an animal born
  // before its mother is not a judgement call.
  const damBorn = dam.kind === "animal" ? dam.date_of_birth : dam.arrival_date;
  if (damBorn && date < damBorn) {
    return {
      error:
        dam.kind === "animal"
          ? `${dam.tag} was born on ${damBorn}. A birth cannot be earlier than that.`
          : `${dam.tag} arrived on ${damBorn}. A birth cannot be earlier than that.`,
      warning: null,
    };
  }

  return { error: null, warning: null };
}

/** SPEC 22 — the warning for a dam who had already left. Separate from
 *  `checkBirth` because it needs her sales and deaths, which the pure count and
 *  date rules do not. */
export function departureWarning(
  dam: Record_,
  date: string,
  sales: Sale[],
  deaths: Death[],
): string | null {
  if (dam.status === "active") return null;
  const left = departureDate(dam, sales, deaths);
  if (!left || date <= left) {
    return `${dam.tag} is recorded as ${dam.status}. The birth will still be recorded.`;
  }
  return `${dam.tag} was recorded as ${dam.status} on ${left}, which is before this date. Check the date — the birth will still be recorded.`;
}

/**
 * How the offspring of a birth are recorded.
 *
 * SPEC 22: one or two get individual animal records, more are offered as a
 * group. The threshold is on **born_count** rather than on the survivors,
 * because every one born gets a record — see `recordBirth`. A litter of eight
 * with two survivors is still eight records' worth of event, and drawing eight
 * tag fields on a phone is the thing the group exists to avoid.
 */
export const INDIVIDUAL_LIMIT = 2;

export function offspringShape(bornCount: number): "individual" | "group" {
  return bornCount <= INDIVIDUAL_LIMIT ? "individual" : "group";
}

/**
 * SPEC 22 — the offspring figure, said as the sum of its two parts.
 *
 * Never one number. The baseline was typed by a person about a time the app has
 * no records of; the births are counted from events. Adding them silently and
 * showing one figure would make the typed half unfalsifiable — nobody could
 * tell which part of a wrong number was wrong.
 *
 * Surviving offspring are what is counted. A stillbirth is in the mortality
 * figures, on its own record and under its own cause, and counting it here as
 * well would have the same loss adding to two different totals.
 */
export function offspringTotal(
  record: Record_,
  births: Birth[],
): { total: number; baseline: number | null; fromBirths: number; birthCount: number } {
  const mine = births.filter((b) => b.dam_record_id === record.id && !b.deleted_at);
  const fromBirths = mine.reduce((sum, birth) => sum + birth.surviving_count, 0);
  const baseline = record.offspring_baseline;
  return {
    total: (baseline ?? 0) + fromBirths,
    baseline,
    fromBirths,
    birthCount: mine.length,
  };
}

/**
 * Where the total came from, in words.
 *
 * The total itself is `offspringTotal().total` and is shown as the figure; this
 * is the line under it. They are separate so the screen can give the number the
 * weight it deserves and still say plainly what it is made of — the two halves
 * have different origins, and one of them is somebody's memory.
 *
 * Null when there is nothing to say: no typed baseline and no births.
 */
export function describeOffspringParts(
  count: ReturnType<typeof offspringTotal>,
  baselineUpdatedAt: string | null,
): string | null {
  const { baseline, fromBirths, birthCount } = count;
  if (baseline === null && birthCount === 0) return null;

  const parts: string[] = [];
  if (baseline !== null) {
    // The last-updated date stays beside the typed number, so a stale figure
    // reads as stale (SPEC 3.4).
    parts.push(
      `${baseline} typed in${baselineUpdatedAt ? ` (updated ${baselineUpdatedAt})` : ""}`,
    );
  }
  if (birthCount > 0) {
    parts.push(`${fromBirths} from ${birthCount} recorded ${plural(birthCount, "birth")}`);
  }
  return parts.join(" plus ");
}

/**
 * The part of a tag a sequence is numbered from.
 *
 * A trailing `-1` is a suffix this app added and is replaced; a trailing `-084`
 * is part of the tag the farm chose and is kept. The distinction is the leading
 * zero, and it is the only signal available: `C-084` and `C-084-1` are
 * indistinguishable in shape, and stripping both would turn the calf of `C-084`
 * into `C-2` — a tag with nothing of its mother in it, and one that collides
 * with the next animal in any other zero-padded series.
 *
 * Generated suffixes never carry a leading zero, so the rule is safe in the
 * direction that matters: the worst it can do is keep a suffix somebody typed
 * by hand as `-07`, which produces `C-07-1` rather than `C-08`. That is a
 * longer tag, not a wrong one.
 */
export function tagStem(tag: string): string {
  return tag.replace(/-([1-9]\d*)$/, "");
}

/**
 * SPEC 22 — the next tags in a sequence, reusing the rule the split already
 * follows.
 *
 * A group split derives `P-Weaners-2` from `P-Weaners` (SPEC 4.3), and an
 * offspring tag wants exactly the same shape for exactly the same reason: it
 * has to be unique, and it should say what it came from. This is the pure half
 * of that rule; `nextSequentialTags` in `db/mutations.ts` is the half that
 * knows what tags are already taken.
 */
export function sequentialTags(root: string, taken: Set<string>, howMany: number): string[] {
  const stem = tagStem(root);
  const out: string[] = [];
  let suffix = 1;
  while (out.length < howMany) {
    const candidate = `${stem}-${suffix}`;
    if (!taken.has(candidate)) {
      out.push(candidate);
      taken.add(candidate);
    }
    suffix += 1;
  }
  return out;
}
