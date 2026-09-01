import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { BackIcon } from "../components/Icons";
import { todayInEAT } from "../db/ids";
import {
  allDeaths,
  allHealth,
  allMoves,
  allPurchases,
  allSales,
  liveRooms,
} from "../db/queries";
import { db } from "../db/schema";
import type { Death, HealthRecord, Move, Purchase, Record_, Room, Sale } from "../db/types";
import {
  calendarEvents,
  eventsByDate,
  KIND_LABEL,
  monthGrid,
  type CalendarEvent,
  type CalendarKind,
} from "../domain/calendar";
import { formatDate } from "../domain/format";
import { useLiveQuery } from "../sync/useSync";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Calendar — SPEC 4.7, the same events as Alerts arranged by date.
 *
 * Which events those are is decided in `domain/calendar.ts`, beside the alert
 * rules it shares vocabulary with. This screen paints them.
 *
 * The legend names every marker in words, because a row of coloured dots is
 * unreadable to anyone who cannot tell them apart — and the dots on a day are
 * summarised in that day's accessible label for the same reason.
 */
export function CalendarScreen() {
  const today = todayInEAT();
  const [selected, setSelected] = useState(today);
  const [view, setView] = useState<"month" | "list">("month");

  const records = useLiveQuery(() => db.records.toArray(), [], [] as Record_[]);
  const rooms = useLiveQuery(liveRooms, [], [] as Room[]);
  const moves = useLiveQuery(allMoves, [], [] as Move[]);
  const purchases = useLiveQuery(allPurchases, [], [] as Purchase[]);
  const health = useLiveQuery(allHealth, [], [] as HealthRecord[]);
  const sales = useLiveQuery(allSales, [], [] as Sale[]);
  const deaths = useLiveQuery(allDeaths, [], [] as Death[]);

  const events = useMemo(
    () => calendarEvents({ records, rooms, moves, purchases, health, sales, deaths, today }),
    [records, rooms, moves, purchases, health, sales, deaths, today],
  );
  const byDate = useMemo(() => eventsByDate(events), [events]);

  const [year, month] = useMemo(() => {
    const [y, m] = selected.split("-").map(Number);
    return [y ?? 2026, m ?? 1];
  }, [selected]);

  const grid = useMemo(() => monthGrid(year, month), [year, month]);
  const selectedEvents = byDate.get(selected) ?? [];

  const shift = (by: number) => {
    const next = new Date(Date.UTC(year, month - 1 + by, 1));
    setSelected(next.toISOString().slice(0, 10));
  };

  return (
    <div className="pb-8">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          aria-label="Previous month"
          className="btn-quiet !px-3"
          onClick={() => shift(-1)}
        >
          <BackIcon className="w-5 h-5" />
        </button>
        <h2 className="text-headline-sm text-primary">
          {MONTHS[month - 1]} {year}
        </h2>
        <button
          type="button"
          aria-label="Next month"
          className="btn-quiet !px-3"
          onClick={() => shift(1)}
        >
          <BackIcon className="w-5 h-5 rotate-180" />
        </button>
      </div>

      <div className="mt-3 flex gap-2">
        {(["month", "list"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={view === option}
            onClick={() => setView(option)}
            className={`flex-1 min-h-touch md:min-h-touch-desktop rounded-lg border text-body-md font-medium ${
              view === option
                ? "bg-primary-container text-white border-primary-container"
                : "bg-card text-text border-border"
            }`}
          >
            {option === "month" ? "Month" : "List"}
          </button>
        ))}
      </div>

      <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
        {(Object.keys(KIND_LABEL) as CalendarKind[]).map((kind) => (
          <li key={kind} className="flex items-center gap-2">
            <Dot kind={kind} />
            <span className="data-label">{KIND_LABEL[kind]}</span>
          </li>
        ))}
      </ul>

      {view === "month" ? (
        <>
          <div className="card mt-4 p-2">
            <div className="grid grid-cols-7">
              {WEEKDAYS.map((day) => (
                <span key={day} className="data-label text-center py-2">
                  {day}
                </span>
              ))}
              {grid.map((date) => (
                <Day
                  key={date}
                  date={date}
                  month={month}
                  today={today}
                  selected={selected === date}
                  events={byDate.get(date) ?? []}
                  onSelect={() => setSelected(date)}
                />
              ))}
            </div>
          </div>

          <h2 className="text-headline-sm text-primary mt-6">
            {selected === today ? "Today" : formatDate(selected)}
            {selectedEvents.length > 0 && (
              <span className="text-text-muted font-normal"> · {selectedEvents.length}</span>
            )}
          </h2>
          <EventList events={selectedEvents} empty="Nothing on this day." />
        </>
      ) : (
        <>
          <h2 className="text-headline-sm text-primary mt-6">
            {MONTHS[month - 1]} {year}
          </h2>
          <EventList
            events={events.filter((e) => e.date.startsWith(`${year}-${String(month).padStart(2, "0")}`))}
            empty="Nothing recorded this month."
            showDates
          />
        </>
      )}
    </div>
  );
}

const DOT: Record<CalendarKind, string> = {
  treatment: "bg-alert",
  purchase: "bg-action",
  sale: "bg-primary",
  move: "bg-text-muted",
  death: "bg-text",
};

function Dot({ kind }: { kind: CalendarKind }) {
  return <span aria-hidden className={`inline-block w-2.5 h-2.5 rounded-full ${DOT[kind]}`} />;
}

function Day({
  date,
  month,
  today,
  selected,
  events,
  onSelect,
}: {
  date: string;
  month: number;
  today: string;
  selected: boolean;
  events: CalendarEvent[];
  onSelect: () => void;
}) {
  const dayOfMonth = Number(date.slice(8, 10));
  const inMonth = Number(date.slice(5, 7)) === month;
  const kinds = [...new Set(events.map((e) => e.kind))];

  // The dots are decoration; the label says what they mean.
  const label =
    events.length === 0
      ? formatDate(date)
      : `${formatDate(date)}, ${kinds.map((k) => KIND_LABEL[k].toLowerCase()).join(", ")}`;

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      onClick={onSelect}
      className={`min-h-touch flex flex-col items-center justify-center gap-1 rounded-lg border ${
        selected ? "border-primary" : "border-transparent"
      } ${inMonth ? "" : "opacity-40"} ${date === today ? "bg-success" : ""}`}
    >
      <span className={`data-value ${date === today ? "font-bold text-success-text" : ""}`}>
        {dayOfMonth}
      </span>
      <span className="flex gap-0.5 h-2.5">
        {kinds.slice(0, 4).map((kind) => (
          <Dot key={kind} kind={kind} />
        ))}
      </span>
    </button>
  );
}

function EventList({
  events,
  empty,
  showDates,
}: {
  events: CalendarEvent[];
  empty: string;
  showDates?: boolean;
}) {
  if (events.length === 0) {
    return <p className="card p-6 mt-3 text-body-md text-text-muted text-center">{empty}</p>;
  }

  return (
    <ul className="mt-3 grid gap-2 md:grid-cols-2">
      {events.map((event) => (
        <li key={event.id}>
          <div className="card p-4 flex items-start gap-3 h-full">
            <span className="mt-1.5">
              <Dot kind={event.kind} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center justify-between gap-2">
                <span className="text-body-lg font-semibold">{event.title}</span>
                {showDates && <span className="data-label shrink-0">{formatDate(event.date)}</span>}
              </p>
              <p className="text-body-md text-text-muted">{event.detail}</p>
              {/* "Scheduled" is a fact about the date, not a status someone set
                  — SPEC 4.7 calls future entries next_due dates. */}
              {event.scheduled && <span className="chip bg-success text-success-text mt-2">Scheduled</span>}
            </div>
            {event.recordId && (
              <Link
                to={`/records/${event.recordId}`}
                className="text-body-md font-semibold text-primary underline shrink-0"
              >
                View
              </Link>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
