/** Shared visual vocabulary. Colors that carry meaning live here, once. */

import type { HypothesisStatus } from "@/lib/campaign-state";

export const VERDICT_COLOR: Record<HypothesisStatus, string> = {
  SUPPORTED: "#34d399",
  REFUTED: "#f87171",
  INCONCLUSIVE: "#fbbf24",
  OPEN: "#94a3b8",
};

export const VERDICT_LABEL: Record<HypothesisStatus, string> = {
  SUPPORTED: "Supported",
  REFUTED: "Refuted",
  INCONCLUSIVE: "Inconclusive",
  OPEN: "Open",
};

export const AUTHOR_LABEL: Record<string, string> = {
  strategist: "Strategist",
  skeptic: "Skeptic",
  analyst: "Analyst",
  controller: "Controller",
  system: "System",
};

export const AUTHOR_COLOR: Record<string, string> = {
  strategist: "#7dd3fc",
  skeptic: "#fbbf24",
  analyst: "#f87171",
  controller: "#a78bfa",
  system: "#94a3b8",
};

export const VETO_LABEL: Record<string, string> = {
  ood: "Out of distribution",
  implausible: "Implausible",
  unsynthesizable: "Unsynthesizable",
  duplicate: "Duplicate",
  off_spec: "Off spec",
};
