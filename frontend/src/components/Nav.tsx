import { NavLink } from "react-router-dom";

import { AnimalsIcon, CalendarIcon, MoneyIcon, MoreIcon, RoomsIcon, StoresIcon } from "./Icons";

/**
 * One navigation component, used everywhere: a bottom bar on mobile and a left
 * sidebar on desktop.
 *
 * SPEC 11 notes the mockups show three different bars because each screen was
 * generated separately, and calls that an artefact rather than a requirement.
 * The "Genetics" tab that appears in two of them is not part of this app.
 */

const DESTINATIONS = [
  { to: "/", label: "Rooms", Icon: RoomsIcon, end: true },
  { to: "/animals", label: "Animals", Icon: AnimalsIcon, end: false },
  // SPEC 20.15 — a sixth destination, between Animals and Calendar.
  //
  // SPEC 11 says "five is the number", and that was written when the app held
  // only livestock. During harvest this is a daily screen, and burying a daily
  // screen under More costs more than a sixth tab does. Measured at 390px
  // before it went in, because the species chips looked fine by estimate and
  // were 100px too wide when checked.
  { to: "/stores", label: "Stores", Icon: StoresIcon, end: false },
  { to: "/calendar", label: "Calendar", Icon: CalendarIcon, end: false },
  { to: "/money", label: "Money", Icon: MoneyIcon, end: false },
  { to: "/more", label: "More", Icon: MoreIcon, end: false },
];

export function BottomNav() {
  return (
    <nav
      aria-label="Main"
      className="fixed bottom-0 inset-x-0 z-40 flex md:hidden bg-card shadow-card-up
                 pb-[env(safe-area-inset-bottom)]"
    >
      {DESTINATIONS.map(({ to, label, Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            `flex-1 min-h-touch flex flex-col items-center justify-center gap-0.5 py-2 ${
              isActive ? "text-primary" : "text-text-muted"
            }`
          }
        >
          {({ isActive }) => (
            <>
              <span
                className={`px-3 py-0.5 rounded-full ${isActive ? "bg-success" : ""}`}
              >
                <Icon className="w-6 h-6" />
              </span>
              <span className="font-mono text-data-label">{label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

export function SideNav() {
  return (
    <nav
      aria-label="Main"
      className="hidden md:flex flex-col gap-1 w-56 shrink-0 border-r border-border
                 bg-card px-3 py-6 min-h-screen sticky top-0"
    >
      {DESTINATIONS.map(({ to, label, Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-lg px-3 min-h-touch-desktop ${
              isActive ? "bg-success text-success-text font-semibold" : "text-text-muted"
            }`
          }
        >
          <Icon className="w-5 h-5" />
          <span className="text-body-md">{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
