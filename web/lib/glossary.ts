/**
 * Plain-English meanings for the properties a campaign optimizes, for readers
 * who are not materials scientists. Keyed on the spec's property name.
 */
export const GLOSSARY: Record<string, string> = {
  migration_barrier:
    "How hard it is for a lithium ion to hop through the crystal. Lower means ions move faster, which means faster charging.",
  energy_above_hull:
    "How far the material sits above its most stable form. Zero means it is as stable as it gets and can actually be made.",
  band_gap:
    "How strongly the material resists conducting electrons. A wide gap keeps the electrolyte from short-circuiting the battery.",
  energy_per_atom:
    "The total energy of the structure, per atom, as the physics model computed it. More negative is more tightly bound.",
};

/**
 * Rule-of-thumb bands for a lithium migration barrier, in eV. Superionic
 * conductors sit well under 0.3 eV; above about 0.5 eV ions barely move at
 * room temperature.
 */
// Conventional reading for Li-ion conductors: below ~0.3 eV is fast enough for
// a practical solid electrolyte, 0.3-0.5 eV is workable but temperature-limited,
// above ~0.5 eV is too sluggish at room temperature. Bands for orientation only —
// the measured value and its flags are what the campaign actually reports.
export const BARRIER_BANDS = [
  { upTo: 0.3, label: "fast", color: "#34d399" },
  { upTo: 0.5, label: "moderate", color: "#fbbf24" },
  { upTo: 0.8, label: "sluggish", color: "#f87171" },
] as const;
