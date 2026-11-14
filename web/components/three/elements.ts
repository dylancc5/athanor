/**
 * Element colour and radius tables shared by every 3D component.
 *
 * Three radius tables, used for three different jobs — don't mix them up:
 *
 *  - `ELEMENT_RADII`  display sphere radius, in angstroms, already scaled for
 *                     ball-and-stick. Use it directly as a sphere radius.
 *  - `COVALENT_RADII` Cordero (2008) covalent radii. Used only for bond
 *                     inference (`r_i + r_j` scaled by a tolerance).
 *  - `VDW_RADII`      Bondi/Jmol van der Waals radii. Used for space-filling
 *                     views and void/pore geometry.
 *
 * Colours are Jmol/CPK hex strings.
 */

export const ELEMENT_COLORS: Record<string, string> = {
  H: "#ffffff",
  He: "#d9ffff",
  Li: "#cc80ff",
  Be: "#c2ff00",
  B: "#ffb5b5",
  C: "#909090",
  N: "#3050f8",
  O: "#ff0d0d",
  F: "#90e050",
  Ne: "#b3e3f5",
  Na: "#ab5cf2",
  Mg: "#8aff00",
  Al: "#bfa6a6",
  Si: "#f0c8a0",
  P: "#ff8000",
  S: "#ffe135",
  Cl: "#1ff01f",
  Ar: "#80d1e3",
  K: "#8f40d4",
  Ca: "#3dff00",
  Sc: "#e6e6e6",
  Ti: "#bfc2c7",
  V: "#a6a6ab",
  Cr: "#8a99c7",
  Mn: "#9c7ac7",
  Fe: "#e06633",
  Co: "#f090a0",
  Ni: "#50d050",
  Cu: "#c88033",
  Zn: "#7d80b0",
  Ga: "#c28f8f",
  Ge: "#668f8f",
  As: "#bd80e3",
  Se: "#ffa100",
  Br: "#a62929",
  Kr: "#5cb8d1",
  Rb: "#702eb0",
  Sr: "#00ff00",
  Y: "#94ffff",
  Zr: "#94e0e0",
  Nb: "#73c2c9",
  Mo: "#54b5b5",
  Tc: "#3b9e9e",
  Ru: "#248f8f",
  Rh: "#0a7d8c",
  Pd: "#006985",
  Ag: "#c0c0c0",
  Cd: "#ffd98f",
  In: "#a67573",
  Sn: "#668080",
  Sb: "#9e63b5",
  Te: "#d47a00",
  I: "#940094",
  Xe: "#429eb0",
  Cs: "#57178f",
  Ba: "#00c900",
  La: "#70d4ff",
  Ce: "#ffffc7",
  Pr: "#d9ffc7",
  Nd: "#c7ffc7",
  Pm: "#a3ffc7",
  Sm: "#8fffc7",
  Eu: "#61ffc7",
  Gd: "#45ffc7",
  Tb: "#30ffc7",
  Dy: "#1fffc7",
  Ho: "#00ff9c",
  Er: "#00e675",
  Tm: "#00d452",
  Yb: "#00bf38",
  Lu: "#00ab24",
  Hf: "#4dc2ff",
  Ta: "#4da6ff",
  W: "#2194d6",
  Re: "#267dab",
  Os: "#266696",
  Ir: "#175487",
  Pt: "#d0d0e0",
  Au: "#ffd123",
  Hg: "#b8b8d0",
  Tl: "#a6544d",
  Pb: "#575961",
  Bi: "#9e4fb5",
  Po: "#ab5c00",
  At: "#754f45",
  Rn: "#428296",
  Fr: "#420066",
  Ra: "#007d00",
  Ac: "#70abfa",
  Th: "#00baff",
  Pa: "#00a1ff",
  U: "#008fff",
  Np: "#0080ff",
  Pu: "#006bff",
  Am: "#545cf2",
  Cm: "#785ce3",
};

/** Cordero et al. (2008) covalent radii, angstroms. Bond inference only. */
export const COVALENT_RADII: Record<string, number> = {
  H: 0.31,
  He: 0.28,
  Li: 1.28,
  Be: 0.96,
  B: 0.84,
  C: 0.76,
  N: 0.71,
  O: 0.66,
  F: 0.57,
  Ne: 0.58,
  Na: 1.66,
  Mg: 1.41,
  Al: 1.21,
  Si: 1.11,
  P: 1.07,
  S: 1.05,
  Cl: 1.02,
  Ar: 1.06,
  K: 2.03,
  Ca: 1.76,
  Sc: 1.7,
  Ti: 1.6,
  V: 1.53,
  Cr: 1.39,
  Mn: 1.39,
  Fe: 1.32,
  Co: 1.26,
  Ni: 1.24,
  Cu: 1.32,
  Zn: 1.22,
  Ga: 1.22,
  Ge: 1.2,
  As: 1.19,
  Se: 1.2,
  Br: 1.2,
  Kr: 1.16,
  Rb: 2.2,
  Sr: 1.95,
  Y: 1.9,
  Zr: 1.75,
  Nb: 1.64,
  Mo: 1.54,
  Tc: 1.47,
  Ru: 1.46,
  Rh: 1.42,
  Pd: 1.39,
  Ag: 1.45,
  Cd: 1.44,
  In: 1.42,
  Sn: 1.39,
  Sb: 1.39,
  Te: 1.38,
  I: 1.39,
  Xe: 1.4,
  Cs: 2.44,
  Ba: 2.15,
  La: 2.07,
  Ce: 2.04,
  Pr: 2.03,
  Nd: 2.01,
  Pm: 1.99,
  Sm: 1.98,
  Eu: 1.98,
  Gd: 1.96,
  Tb: 1.94,
  Dy: 1.92,
  Ho: 1.92,
  Er: 1.89,
  Tm: 1.9,
  Yb: 1.87,
  Lu: 1.87,
  Hf: 1.75,
  Ta: 1.7,
  W: 1.62,
  Re: 1.51,
  Os: 1.44,
  Ir: 1.41,
  Pt: 1.36,
  Au: 1.36,
  Hg: 1.32,
  Tl: 1.45,
  Pb: 1.46,
  Bi: 1.48,
  Po: 1.4,
  At: 1.5,
  Rn: 1.5,
  Fr: 2.6,
  Ra: 2.21,
  Ac: 2.15,
  Th: 2.06,
  Pa: 2.0,
  U: 1.96,
  Np: 1.9,
  Pu: 1.87,
  Am: 1.8,
  Cm: 1.69,
};

/** Bondi / Jmol van der Waals radii, angstroms. Space-filling and voids. */
export const VDW_RADII: Record<string, number> = {
  H: 1.2,
  He: 1.4,
  Li: 1.82,
  Be: 1.53,
  B: 1.92,
  C: 1.7,
  N: 1.55,
  O: 1.52,
  F: 1.47,
  Ne: 1.54,
  Na: 2.27,
  Mg: 1.73,
  Al: 1.84,
  Si: 2.1,
  P: 1.8,
  S: 1.8,
  Cl: 1.75,
  Ar: 1.88,
  K: 2.75,
  Ca: 2.31,
  Sc: 2.11,
  Ti: 2.0,
  V: 2.0,
  Cr: 2.0,
  Mn: 2.0,
  Fe: 2.0,
  Co: 2.0,
  Ni: 1.63,
  Cu: 1.4,
  Zn: 1.39,
  Ga: 1.87,
  Ge: 2.11,
  As: 1.85,
  Se: 1.9,
  Br: 1.85,
  Kr: 2.02,
  Rb: 3.03,
  Sr: 2.49,
  Y: 2.32,
  Zr: 2.23,
  Nb: 2.18,
  Mo: 2.17,
  Tc: 2.16,
  Ru: 2.13,
  Rh: 2.1,
  Pd: 2.1,
  Ag: 1.72,
  Cd: 1.58,
  In: 1.93,
  Sn: 2.17,
  Sb: 2.06,
  Te: 2.06,
  I: 1.98,
  Xe: 2.16,
  Cs: 3.43,
  Ba: 2.68,
  La: 2.43,
  Ce: 2.42,
  Pr: 2.4,
  Nd: 2.39,
  Pm: 2.38,
  Sm: 2.36,
  Eu: 2.35,
  Gd: 2.34,
  Tb: 2.33,
  Dy: 2.31,
  Ho: 2.3,
  Er: 2.29,
  Tm: 2.27,
  Yb: 2.26,
  Lu: 2.24,
  Hf: 2.23,
  Ta: 2.22,
  W: 2.18,
  Re: 2.16,
  Os: 2.16,
  Ir: 2.13,
  Pt: 2.13,
  Au: 2.14,
  Hg: 2.23,
  Tl: 1.96,
  Pb: 2.02,
  Bi: 2.07,
  Po: 1.97,
  At: 2.02,
  Rn: 2.2,
  Fr: 3.48,
  Ra: 2.83,
  Ac: 2.47,
  Th: 2.45,
  Pa: 2.43,
  U: 2.41,
  Np: 2.39,
  Pu: 2.43,
  Am: 2.44,
  Cm: 2.45,
};

/** Fraction of the van der Waals radius used for a ball-and-stick sphere. */
const DISPLAY_SCALE = 0.3;
const DISPLAY_MIN = 0.26;
const DISPLAY_MAX = 0.78;

const FALLBACK_COLOR = "#e879f9";
const FALLBACK_COVALENT = 1.4;
const FALLBACK_VDW = 2.0;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Display sphere radii in angstroms — directly usable as a ball-and-stick
 * sphere radius, no extra scaling needed.
 */
export const ELEMENT_RADII: Record<string, number> = Object.fromEntries(
  Object.entries(VDW_RADII).map(([symbol, r]) => [
    symbol,
    Math.round(clamp(r * DISPLAY_SCALE, DISPLAY_MIN, DISPLAY_MAX) * 1000) / 1000,
  ]),
);

/**
 * Normalize an atom label or type symbol to an element symbol.
 * `Li1` -> `Li`, `  o  ` -> `O`, `CL2A` -> `Cl`, `S1-` -> `S`.
 */
export function normalizeElement(raw: string): string {
  const letters = String(raw ?? "")
    .trim()
    .replace(/[^A-Za-z]/g, "");
  if (!letters) return "";
  // Longest match wins so "Cl" beats "C" and "Nb" beats "N".
  const two = letters.slice(0, 2);
  const cased2 = two.charAt(0).toUpperCase() + two.charAt(1).toLowerCase();
  if (two.length === 2 && cased2 in COVALENT_RADII) return cased2;
  const one = letters.charAt(0).toUpperCase();
  if (one in COVALENT_RADII) return one;
  return cased2.length === 2 ? cased2 : one;
}

/** CPK colour for an element, with a visible fallback for unknown symbols. */
export function elementColor(symbol: string): string {
  return ELEMENT_COLORS[symbol] ?? ELEMENT_COLORS[normalizeElement(symbol)] ?? FALLBACK_COLOR;
}

/** Display sphere radius in angstroms. */
export function elementRadius(symbol: string): number {
  return (
    ELEMENT_RADII[symbol] ??
    ELEMENT_RADII[normalizeElement(symbol)] ??
    clamp(FALLBACK_VDW * DISPLAY_SCALE, DISPLAY_MIN, DISPLAY_MAX)
  );
}

/** Covalent radius in angstroms, for bond inference. */
export function covalentRadius(symbol: string): number {
  return (
    COVALENT_RADII[symbol] ?? COVALENT_RADII[normalizeElement(symbol)] ?? FALLBACK_COVALENT
  );
}

/** Van der Waals radius in angstroms. */
export function vdwRadius(symbol: string): number {
  return VDW_RADII[symbol] ?? VDW_RADII[normalizeElement(symbol)] ?? FALLBACK_VDW;
}

/** Alkali + alkaline-earth cations: ionic, not covalently bonded. */
export const IONIC_CATIONS: readonly string[] = [
  "Li",
  "Na",
  "K",
  "Rb",
  "Cs",
  "Mg",
  "Ca",
  "Sr",
  "Ba",
];

/** Shared verdict colours (kept here so every component agrees). */
export const VERDICT_COLORS = {
  SUPPORTED: "#34d399",
  REFUTED: "#f87171",
  INCONCLUSIVE: "#fbbf24",
  OPEN: "#94a3b8",
} as const;
