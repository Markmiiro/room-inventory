import type { ReactNode } from "react";

/**
 * The form controls the two stock screens share.
 *
 * Add stock and Take out ask most of the same questions — which store, which
 * produce, when, how much — and a farmer moving between them should not meet
 * two different-looking versions of the same field. Kept here rather than
 * duplicated so they cannot drift apart.
 */

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-4">
      <label className="data-label block mb-1" htmlFor={htmlFor}>
        {label}
        {hint && <span className="text-text-muted normal-case"> · {hint}</span>}
      </label>
      {children}
    </div>
  );
}

export function NumberField({
  label,
  htmlFor,
  value,
  onChange,
  hint,
  step,
}: {
  label: string;
  htmlFor: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  step?: string;
}) {
  return (
    <div className="mt-4">
      <label className="data-label block mb-1" htmlFor={htmlFor}>
        {label}
        {hint && <span className="text-text-muted normal-case"> · {hint}</span>}
      </label>
      <input
        id={htmlFor}
        type="number"
        // A numeric keypad on the phone this app is used on, standing next to
        // the scale.
        inputMode="decimal"
        step={step ?? "1"}
        min="0"
        className="field"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function Picker({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const id = `pick-${label.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div className="mt-4">
      <label className="data-label block mb-1" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="field"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Chip({
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
      className={`chip min-h-touch md:min-h-touch-desktop px-4 border ${
        active
          ? "bg-primary text-white border-primary"
          : "bg-card text-text border-border"
      }`}
    >
      {children}
    </button>
  );
}
