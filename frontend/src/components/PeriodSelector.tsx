import { PERIOD_OPTIONS, periodOptionLabel } from "../domain/period";

/**
 * The three-month / twelve-month / five-year selector.
 *
 * Lifted out of the Money summary when Analytics arrived (SPEC 19). Both tabs
 * read the same period, so both must offer the same choices — a selector
 * duplicated per tab is one that eventually offers different ones, and the
 * figures underneath stop being comparable without anything on screen saying so.
 */
export function PeriodSelector({
  months,
  onChange,
}: {
  months: number;
  onChange: (months: number) => void;
}) {
  return (
    <div className="flex gap-2" role="group" aria-label="Period">
      {PERIOD_OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={months === option}
          onClick={() => onChange(option)}
          className={`flex-1 min-h-touch md:min-h-touch-desktop rounded-lg border text-body-md font-medium ${
            months === option
              ? "bg-primary-container text-white border-primary-container"
              : "bg-card text-text border-border"
          }`}
        >
          {periodOptionLabel(option)}
        </button>
      ))}
    </div>
  );
}
