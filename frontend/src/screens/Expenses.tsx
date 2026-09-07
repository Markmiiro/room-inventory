import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { CheckIcon, PlusIcon } from "../components/Icons";
import { todayInEAT } from "../db/ids";
import {
  createExpenseCategory,
  recordExpense,
  updateExpenseCategory,
} from "../db/mutations";
import { allExpenses, liveCategories, liveRooms } from "../db/queries";
import type { Expense, ExpenseCategory, ExpenseScope, Room, Species } from "../db/types";
import { formatDate, formatUGX } from "../domain/format";
import { ALL_SPECIES, speciesLabel } from "../domain/rules";
import { useLiveQuery } from "../sync/useSync";


const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Expenses — what was spent, newest month first.
 *
 * The mockup shows four categories already in place. They are sample data, not
 * a seed: SPEC 3.11 says the app ships with none and the first expense creates
 * the first one. So the empty state is the normal first state here, and it has
 * to explain itself rather than look broken.
 */
export function ExpensesScreen() {
  const expenses = useLiveQuery(allExpenses, [], [] as Expense[]);
  const categories = useLiveQuery(liveCategories, [], [] as ExpenseCategory[]);
  const [filter, setFilter] = useState<string>("all");
  const [adding, setAdding] = useState(false);

  const categoryById = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories],
  );

  const shown = useMemo(
    () => (filter === "all" ? expenses : expenses.filter((e) => e.category_id === filter)),
    [expenses, filter],
  );

  // Grouped by month, with each month's total, as the mockup has it.
  const months = useMemo(() => {
    const byMonth = new Map<string, Expense[]>();
    for (const expense of shown) {
      const key = expense.date.slice(0, 7);
      const list = byMonth.get(key) ?? [];
      list.push(expense);
      byMonth.set(key, list);
    }
    return [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [shown]);

  return (
    <div className="pb-40 md:pb-24">
      {categories.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Filter by category">
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
            All
          </FilterChip>
          {categories
            .filter((c) => !c.is_archived)
            .map((category) => (
              <FilterChip
                key={category.id}
                active={filter === category.id}
                onClick={() => setFilter(category.id)}
              >
                {category.name}
              </FilterChip>
            ))}
        </div>
      )}

      {expenses.length === 0 ? (
        <div className="card p-6 mt-4 text-center">
          <p className="text-headline-sm text-primary">Nothing spent yet</p>
          <p className="text-body-md text-text-muted mt-2 max-w-md mx-auto">
            There are no categories either — this app ships with none, and the first
            expense creates the first one. Add what you spent and name the category
            as you go.
          </p>
          <button type="button" className="btn-action mt-4" onClick={() => setAdding(true)}>
            <PlusIcon className="w-6 h-6" />
            Add the first expense
          </button>
        </div>
      ) : (
        months.map(([month, list]) => {
          const total = list.reduce((sum, e) => sum + e.amount, 0);
          const [year, m] = month.split("-").map(Number);
          return (
            <section key={month} className="mt-6">
              <div className="flex items-baseline justify-between gap-3 border-b border-border pb-2">
                <h2 className="text-headline-sm text-primary">
                  {MONTHS[(m ?? 1) - 1]} {year}
                </h2>
                <p className="data-value font-bold">{formatUGX(total)}</p>
              </div>
              <ul className="mt-3 grid gap-2 md:grid-cols-2">
                {list.map((expense) => (
                  <li key={expense.id}>
                    <ExpenseRow expense={expense} category={categoryById.get(expense.category_id)} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}

      <Link to="/categories" className="btn-quiet w-full mt-6">
        Manage categories
      </Link>

      {/* TOKENS.md: the action yellow appears once per screen. The empty state
          already carries it, and a floating button beside its own call to
          action is the second one. */}
      {expenses.length > 0 && (
        <button
          type="button"
          aria-label="Add expense"
          className="btn-action fixed right-4 bottom-24 md:bottom-8 z-30 h-14 w-14 !px-0 rounded-xl"
          onClick={() => setAdding(true)}
        >
          <PlusIcon className="w-7 h-7" />
        </button>
      )}

      {adding && <AddExpenseDialog categories={categories} onClose={() => setAdding(false)} />}
    </div>
  );
}

function ExpenseRow({
  expense,
  category,
}: {
  expense: Expense;
  category: ExpenseCategory | undefined;
}) {
  const rooms = useLiveQuery(liveRooms, [], [] as Room[]);
  const scope =
    expense.applies_to === "farm"
      ? "Whole farm"
      : expense.applies_to === "species"
        ? speciesLabel(expense.applies_to_id as Species)
        : rooms.find((r) => r.id === expense.applies_to_id)?.code ?? "A room";

  return (
    <div className="card p-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-body-lg font-semibold truncate">
          {expense.note || category?.name || "Expense"}
        </p>
        <p className="text-body-md text-text-muted truncate">
          {/* An archived category still names the expenses that used it (SPEC 4.8). */}
          {category?.name ?? "Uncategorised"} · {scope}
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className="data-value font-bold">{formatUGX(expense.amount)}</p>
        <p className="data-label">{formatDate(expense.date)}</p>
      </div>
    </div>
  );
}

/**
 * Add expense.
 *
 * SPEC 6.12 is the rule that shapes this: creating a category inline must not
 * clear the amount already typed. So the new-category field is part of this
 * form's own state rather than a separate screen or a dialog that unmounts it —
 * nothing here is remounted when a category is created.
 */
function AddExpenseDialog({
  categories,
  onClose,
}: {
  categories: ExpenseCategory[];
  onClose: () => void;
}) {
  const rooms = useLiveQuery(liveRooms, [], [] as Room[]);

  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState<string>(categories[0]?.id ?? "");
  const [namingCategory, setNamingCategory] = useState(categories.length === 0);
  const [newCategory, setNewCategory] = useState("");
  const [appliesTo, setAppliesTo] = useState<ExpenseScope>("farm");
  const [appliesToId, setAppliesToId] = useState("");
  const [date, setDate] = useState(todayInEAT());
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const live = categories.filter((c) => !c.is_archived);
  const shillings = amount.trim() === "" ? null : Number(amount.replace(/[,\s]/g, ""));

  /** Returns the id to file the expense under, creating the category if the
   *  name has been typed but not yet added. */
  async function resolveCategory(): Promise<string | null> {
    const name = newCategory.trim();
    if (!name) return categoryId || null;

    const existing = live.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing.id;

    // The amount, date, scope and note are untouched by this — SPEC 6.12.
    const created = await createExpenseCategory(name);
    return created.id;
  }

  async function addCategory() {
    const name = newCategory.trim();
    if (!name) return setError("A category needs a name.");
    if (live.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      return setError("There is already a category with that name.");
    }
    const created = await createExpenseCategory(name);
    setCategoryId(created.id);
    setNewCategory("");
    setNamingCategory(false);
    setError(null);
  }

  async function submit() {
    if (shillings === null || !Number.isFinite(shillings) || shillings <= 0) {
      return setError("An expense needs an amount greater than zero.");
    }
    if (appliesTo !== "farm" && !appliesToId) {
      return setError(appliesTo === "species" ? "Choose a species." : "Choose a room.");
    }
    if (date > todayInEAT()) return setError("An expense cannot be dated in the future.");

    setSaving(true);
    setError(null);
    try {
      // A name typed into the new-category field and not yet added is still
      // what the user meant. Refusing to save it would lose a filled-in form
      // over one unpressed button.
      const category = await resolveCategory();
      if (!category) {
        setSaving(false);
        return setError("Name a category for this expense.");
      }

      await recordExpense({
        amount: shillings,
        category_id: category,
        date,
        applies_to: appliesTo,
        applies_to_id: appliesTo === "farm" ? null : appliesToId,
        note: note.trim() || null,
      });
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4 overflow-y-auto">
      <div
        className="card w-full max-w-lg p-4 sm:p-6 max-h-[92vh] overflow-y-auto"
        role="dialog"
        aria-label="Add expense"
      >
        <h2 className="text-headline-sm text-primary">Add expense</h2>

        <div className="mt-4">
          <label className="data-label block mb-1" htmlFor="exp-amount">Amount (UGX)</label>
          <input
            id="exp-amount" className="field font-mono" value={amount} inputMode="numeric" autoFocus
            placeholder="150000" onChange={(e) => setAmount(e.target.value)}
          />
          {shillings !== null && Number.isFinite(shillings) && shillings > 0 && (
            <p className="text-body-md text-text-muted mt-1">{formatUGX(shillings)}</p>
          )}
        </div>

        <fieldset className="mt-4">
          <legend className="data-label mb-2">Category</legend>
          {live.length === 0 && !namingCategory && (
            <p className="text-body-md text-text-muted mb-2">
              No categories yet. Name the first one.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {live.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => setCategoryId(category.id)}
                className={`chip min-h-touch md:min-h-touch-desktop px-4 border ${
                  categoryId === category.id
                    ? "bg-primary-container text-white border-primary-container"
                    : "bg-card text-text border-border"
                }`}
              >
                {categoryId === category.id && <CheckIcon className="w-4 h-4" />}
                {category.name}
              </button>
            ))}
            {!namingCategory && (
              <button
                type="button"
                onClick={() => setNamingCategory(true)}
                className="chip min-h-touch md:min-h-touch-desktop px-4 border border-dashed border-border text-text-muted"
              >
                + New category
              </button>
            )}
          </div>

          {namingCategory && (
            <div className="mt-3 flex gap-2">
              <input
                className="field flex-1"
                value={newCategory}
                autoFocus
                placeholder="Feed"
                aria-label="New category name"
                onChange={(e) => setNewCategory(e.target.value)}
              />
              <button type="button" className="btn-secondary" onClick={() => void addCategory()}>
                Add
              </button>
              {live.length > 0 && (
                <button
                  type="button"
                  className="btn-quiet"
                  onClick={() => {
                    setNamingCategory(false);
                    setNewCategory("");
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          )}
        </fieldset>

        <fieldset className="mt-4">
          <legend className="data-label mb-2">Applies to</legend>
          <div className="flex flex-wrap gap-2">
            {(
              [
                { value: "farm", label: "Whole farm" },
                { value: "species", label: "A species" },
                { value: "room", label: "A room" },
              ] as Array<{ value: ExpenseScope; label: string }>
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  setAppliesTo(option.value);
                  setAppliesToId("");
                }}
                className={`flex-1 min-w-[110px] min-h-touch md:min-h-touch-desktop rounded-lg border text-body-md font-medium ${
                  appliesTo === option.value
                    ? "bg-primary-container text-white border-primary-container"
                    : "bg-card text-text border-border"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          {appliesTo === "species" && (
            <select
              className="field mt-3"
              value={appliesToId}
              aria-label="Species"
              onChange={(e) => setAppliesToId(e.target.value)}
            >
              <option value="">Choose a species</option>
              {ALL_SPECIES.map((s) => (
                <option key={s} value={s}>{speciesLabel(s)}</option>
              ))}
            </select>
          )}
          {appliesTo === "room" && (
            <select
              className="field mt-3"
              value={appliesToId}
              aria-label="Room"
              onChange={(e) => setAppliesToId(e.target.value)}
            >
              <option value="">Choose a room</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>{room.code} · {room.name}</option>
              ))}
            </select>
          )}

          {appliesTo !== "farm" && (
            <p className="text-body-md text-text-muted mt-2">
              Costs tagged to a species or a room are shared across the animals in
              them, weighted by how long each was there. That share is an estimate.
            </p>
          )}
        </fieldset>

        <div className="mt-4">
          <label className="data-label block mb-1" htmlFor="exp-date">Date</label>
          <input
            id="exp-date" type="date" className="field font-mono" value={date}
            max={todayInEAT()} onChange={(e) => setDate(e.target.value)}
          />
        </div>

        <div className="mt-4">
          <label className="data-label block mb-1" htmlFor="exp-note">Note</label>
          <input
            id="exp-note" className="field" value={note} placeholder="Broiler feed, 10 bags"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {error && (
          <p className="mt-3 rounded-lg bg-alert-bg text-alert-text text-body-md p-3">{error}</p>
        )}

        <div className="mt-6 flex gap-3">
          <button type="button" className="btn-quiet flex-1" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn-secondary flex-1"
            disabled={saving}
            onClick={() => void submit()}
          >
            {saving ? "Saving…" : "Save expense"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Manage categories — SPEC 4.8: one in use is archived, never deleted, so the
 *  expenses that already carry its name keep it. */
export function CategoriesScreen() {
  const categories = useLiveQuery(liveCategories, [], [] as ExpenseCategory[]);
  const expenses = useLiveQuery(allExpenses, [], [] as Expense[]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const counts = useMemo(() => {
    const byCategory = new Map<string, number>();
    for (const expense of expenses) {
      byCategory.set(expense.category_id, (byCategory.get(expense.category_id) ?? 0) + 1);
    }
    return byCategory;
  }, [expenses]);

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) return setError("A category needs a name.");
    if (categories.some((c) => c.name.toLowerCase() === trimmed.toLowerCase())) {
      return setError("There is already a category with that name.");
    }
    await createExpenseCategory(trimmed);
    setName("");
    setError(null);
  }

  return (
    <div className="pb-8 max-w-3xl">
      <div className="card p-4">
        <label className="data-label block mb-1" htmlFor="cat-name">New category</label>
        <div className="flex gap-2">
          <input
            id="cat-name" className="field flex-1" value={name} placeholder="Feed"
            onChange={(e) => setName(e.target.value)}
          />
          <button type="button" className="btn-secondary" onClick={() => void add()}>
            <PlusIcon className="w-5 h-5" />
            Add
          </button>
        </div>
        {error && (
          <p className="mt-3 rounded-lg bg-alert-bg text-alert-text text-body-md p-3">{error}</p>
        )}
      </div>

      {categories.length === 0 ? (
        <p className="card p-6 mt-4 text-body-md text-text-muted text-center">
          No categories yet. This app ships with none — the first expense creates
          the first one.
        </p>
      ) : (
        <ul className="mt-4 grid gap-2 md:grid-cols-2">
          {categories.map((category) => {
            const used = counts.get(category.id) ?? 0;
            return (
              <li key={category.id}>
                <div className="card p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-body-lg font-semibold truncate">
                      {category.name}
                      {category.is_archived && (
                        <span className="chip bg-background text-text-muted ml-2">Archived</span>
                      )}
                    </p>
                    <p className="data-label mt-1">
                      {used} {used === 1 ? "expense" : "expenses"}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn-quiet shrink-0"
                    onClick={() =>
                      void updateExpenseCategory(category.id, { is_archived: !category.is_archived })
                    }
                  >
                    {category.is_archived ? "Restore" : "Archive"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="card p-4 mt-6 text-body-md text-text-muted">
        A category in use is archived rather than deleted. It stops being offered
        as a choice, and the expenses already filed under it keep its name.
      </p>
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
        active ? "bg-primary text-white border-primary" : "bg-card text-text border-border"
      }`}
    >
      {children}
    </button>
  );
}
