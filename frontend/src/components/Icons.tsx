/**
 * Icons are inlined SVG rather than an icon font.
 *
 * SPEC 9 requires icons to be bundled and available offline, and inlining a
 * dozen glyphs costs a few hundred bytes where the whole Material Symbols font
 * costs megabytes. Everything here is a navigation, action or status icon —
 * TOKENS.md is explicit that Material Symbols is fine for those.
 *
 * There are deliberately no species icons here. See SpeciesLabel.tsx.
 */

interface IconProps {
  className?: string;
}

const base = "w-6 h-6 shrink-0";

export function RoomsIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <path d="M4 20V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v15" strokeLinecap="round" />
      <path d="M15 9h4a1 1 0 0 1 1 1v10" strokeLinecap="round" />
      <path d="M2 20h20" strokeLinecap="round" />
      <circle cx="11.5" cy="12.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function AnimalsIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <path d="M4 13h3l2-5 3 8 2.5-6 1.5 3h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CalendarIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" strokeLinecap="round" />
    </svg>
  );
}

export function MoneyIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

export function MoreIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

export function MoveIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
      <path d="M4 8h13l-3-3M20 16H7l3 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function BackIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
      <path d="M19 12H5m0 0 6-6m-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Points into a row that opens something. Not a rotated plus: that draws an
 *  X, which reads as "delete this" on exactly the rows it sits beside. */
export function ChevronIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
      <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CloseIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}

export function WarningIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 3 1.8 20.5h20.4L12 3Zm0 6.2c.6 0 1 .5 1 1.1l-.2 4.3a.8.8 0 0 1-1.6 0l-.2-4.3c0-.6.4-1.1 1-1.1Zm0 8.9a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2Z" />
    </svg>
  );
}

export function CheckIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className={className} aria-hidden="true">
      <path d="m5 13 4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PlusIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

export function SearchIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" strokeLinecap="round" />
    </svg>
  );
}

export function CloudOffIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.5 8.2 4 4 0 0 0 7 18Z" strokeLinejoin="round" />
      <path d="M3 3l18 18" strokeLinecap="round" />
    </svg>
  );
}

export function SyncIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <path d="M20 12a8 8 0 0 1-13.7 5.6M4 12a8 8 0 0 1 13.7-5.6" strokeLinecap="round" />
      <path d="M17.7 3v3.4h-3.4M6.3 21v-3.4h3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * SPEC 20 — Stores.
 *
 * A stack of sacks, not a warehouse or a silo: the vocabulary bans those words
 * (SPEC 20.2) and the icon should not smuggle them back in. It also has to read
 * as clearly different from RoomsIcon at 24px, since the two sit side by side
 * in the bar and both mean "a place things are kept".
 */
export function StoresIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <path d="M6 13h12a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z" strokeLinejoin="round" />
      <path d="M9 13V9a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4" strokeLinejoin="round" />
      <path d="M10 8V6a2 2 0 0 1 4 0v2" strokeLinecap="round" />
    </svg>
  );
}
