import type { Species } from "../db/types";
import { speciesLabel } from "../domain/rules";

/**
 * Species are named in words, not drawn.
 *
 * TOKENS.md is unambiguous about this: Material Symbols has no livestock, and
 * every attempt in the mockups produced something wrong — a tractor for cattle,
 * a rat for pigs, a bug for poultry, a bee for sheep. Until the five custom
 * icons exist, the instruction is to use the species name as text rather than a
 * misleading icon.
 *
 * When those icons are drawn, this is the one place that changes.
 */
export function SpeciesLabel({ species, count }: { species: Species; count?: number }) {
  return (
    <span className="chip bg-success text-success-text">
      {speciesLabel(species)}
      {count !== undefined && <span className="font-mono">({count})</span>}
    </span>
  );
}
