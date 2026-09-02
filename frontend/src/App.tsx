import { useEffect } from "react";
import { Link, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { BackIcon, CloseIcon } from "./components/Icons";
import { BottomNav, SideNav } from "./components/Nav";
import { SyncIndicator } from "./components/SyncIndicator";
import { seedRoomsIfEmpty, seedSchedulesIfEmpty } from "./db/seed";
import { AddPurchaseScreen } from "./screens/AddPurchase";
import { AlertsScreen } from "./screens/Alerts";
import { AnimalsScreen } from "./screens/Animals";
import { CalendarScreen } from "./screens/Calendar";
import { CategoriesScreen, ExpensesScreen } from "./screens/Expenses";
import { ContactsScreen } from "./screens/Contacts";
import { HealthScreen } from "./screens/Health";
import { LogDeathScreen } from "./screens/LogDeath";
import { MoneyScreen } from "./screens/Money";
import { MoreScreen } from "./screens/More";
import { SellScreen } from "./screens/Sell";
import { MoveScreen } from "./screens/Move";
import { RecordDetailScreen } from "./screens/RecordDetail";
import { RoomDetailScreen } from "./screens/RoomDetail";
import { RoomsScreen } from "./screens/Rooms";
import { SchedulesScreen } from "./screens/Schedules";
import { VetVisitsScreen } from "./screens/VetVisits";
import { VisitDetailScreen } from "./screens/VisitDetail";
import { loadTokens } from "./sync/api";
import { syncEngine } from "./sync/engine";

/**
 * Routes that take over the screen for one task.
 *
 * These hide the bottom navigation and put their own action bar in its place.
 * Both are `fixed bottom-0`, so showing them together stacks two bars and the
 * nav covers the screen's primary button — on a 600px-tall phone that is most
 * of the space the task had. The mockups do the same thing, labelling the Move
 * screen's bar as replacing the nav shell.
 *
 * The task is still escapable: focused screens get a close button rather than a
 * back arrow, which is also what the mockup shows.
 */
const FOCUSED_ROUTES = [/^\/move/, /^\/add/, /^\/sell/, /^\/death/];

function isFocusedRoute(pathname: string): boolean {
  return FOCUSED_ROUTES.some((pattern) => pattern.test(pathname));
}

function AppShell() {
  useEffect(() => {
    // SPEC 6.10 — the ten rooms exist before anything else runs, with no
    // network involved.
    // SPEC 6.10 and 13.5 — both seeds run before sync starts, with no network
    // involved, so a first open offline has its ten rooms and its eight starter
    // schedules rather than an empty screen.
    void seedRoomsIfEmpty()
      .then(seedSchedulesIfEmpty)
      .then(() => {
        loadTokens();
        syncEngine.start();
      });
    return () => syncEngine.stop();
  }, []);

  const { pathname } = useLocation();
  const focused = isFocusedRoute(pathname);

  return (
    <div className="min-h-screen md:flex">
      <SideNav />
      <div className="flex-1 min-w-0">
        <TopBar />
        <main className="px-4 py-4 max-w-6xl mx-auto">
          <Routes>
            <Route path="/" element={<RoomsScreen />} />
            <Route path="/rooms/:roomId" element={<RoomDetailScreen />} />
            <Route path="/animals" element={<AnimalsScreen />} />
            <Route path="/records/:recordId" element={<RecordDetailScreen />} />
            <Route path="/add" element={<AddPurchaseScreen />} />
            <Route path="/alerts" element={<AlertsScreen />} />
            <Route path="/calendar" element={<CalendarScreen />} />
            <Route path="/health" element={<HealthScreen />} />
            <Route path="/sell" element={<SellScreen />} />
            <Route path="/death" element={<LogDeathScreen />} />
            <Route path="/expenses" element={<ExpensesScreen />} />
            <Route path="/categories" element={<CategoriesScreen />} />
            <Route path="/money" element={<MoneyScreen />} />
            <Route path="/more" element={<MoreScreen />} />
            <Route path="/customers" element={<ContactsScreen kind="customer" />} />
            <Route path="/vets" element={<ContactsScreen kind="vet" />} />
            <Route path="/schedules" element={<SchedulesScreen />} />
            <Route path="/visits" element={<VetVisitsScreen />} />
            <Route path="/visits/:visitId" element={<VisitDetailScreen />} />
            <Route path="/move" element={<MoveScreen />} />
            <Route path="*" element={<NotBuiltYet />} />
          </Routes>
        </main>
      </div>
      {!focused && <BottomNav />}
    </div>
  );
}

export function App() {
  return <AppShell />;
}

const TITLES: Array<[RegExp, string]> = [
  [/^\/$/, "Room Inventory"],
  [/^\/rooms\//, "Room"],
  [/^\/records\//, "Record"],
  [/^\/animals/, "Animals"],
  [/^\/add/, "Add or purchase"],
  [/^\/alerts/, "Alerts"],
  [/^\/calendar/, "Calendar"],
  [/^\/health/, "Health"],
  [/^\/sell/, "Sell"],
  [/^\/death/, "Log death"],
  [/^\/expenses/, "Expenses"],
  [/^\/categories/, "Manage categories"],
  [/^\/money/, "Money"],
  [/^\/more/, "More"],
  [/^\/customers/, "Customers"],
  [/^\/vets/, "Vets"],
  [/^\/schedules/, "Manage schedules"],
  // The detail pattern comes first: "/visits/abc" matches both.
  [/^\/visits\/.+/, "Visit"],
  [/^\/visits/, "Vet visits"],
  [/^\/move/, "Move"],
];

function TopBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const title = TITLES.find(([pattern]) => pattern.test(pathname))?.[1] ?? "Room Inventory";
  const canGoBack = pathname !== "/";
  const focused = isFocusedRoute(pathname);

  return (
    <header className="sticky top-0 z-40 h-input bg-primary text-white flex items-center gap-2 px-4">
      {canGoBack && (
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label={focused ? "Cancel" : "Back"}
          className="-ml-2 min-w-touch min-h-touch flex items-center justify-center"
        >
          {focused ? <CloseIcon className="w-6 h-6" /> : <BackIcon className="w-6 h-6" />}
        </button>
      )}
      <h1 className="text-headline-sm truncate flex-1">{title}</h1>
      {/* No account icon: there is one user and no profile screen (SPEC 12). */}
      <SyncIndicator />
    </header>
  );
}

function NotBuiltYet() {
  return (
    <div className="card p-6 text-center">
      <p className="text-headline-sm text-primary">Not built yet</p>
      <p className="text-body-md text-text-muted mt-2">
        Nine of the fourteen screens are built. Sell, Log death, Expenses, Money
        summary and More come next.
      </p>
      <Link to="/" className="btn-secondary mt-4 inline-flex">
        Back to Rooms
      </Link>
    </div>
  );
}
