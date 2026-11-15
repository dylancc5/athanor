"use client";

import { useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { Button, Chip, CountUp, Term } from "@/components/ui/Bits";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { stateAt, hypothesisList } from "@/lib/campaign-state";
import { VERDICT_COLOR, VERDICT_LABEL } from "@/lib/design";
import { BARRIER_BANDS } from "@/lib/glossary";
import { fmtDuration, fmtNumber } from "@/lib/format";
import { useCampaign } from "@/lib/store";

const Viewer = dynamic(
  () => import("@/components/panels/viewer/Viewer").then((m) => m.Viewer),
  { ssr: false, loading: () => <div className="h-full border border-rule bg-panel" /> },
);

const VERB: Record<string, string> = {
  REFUTED: "proposed a hypothesis, tested it with real physics, and proved itself wrong",
  SUPPORTED: "proposed a hypothesis, tested it with real physics, and confirmed it",
  INCONCLUSIVE: "proposed a hypothesis and put it to a real physics test",
  OPEN: "proposed a hypothesis and put it to a real physics test",
};

/** Where a barrier falls on the fast / moderate / sluggish scale. */
function BarrierScale({ value }: { value: number }) {
  const max = BARRIER_BANDS[BARRIER_BANDS.length - 1].upTo;
  const at = Math.min(1, Math.max(0, value / max));
  let lo = 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative flex h-2 overflow-hidden rounded-full">
        {BARRIER_BANDS.map((b) => {
          const w = ((b.upTo - lo) / max) * 100;
          lo = b.upTo;
          return (
            <div key={b.label} style={{ width: `${w}%`, background: `${b.color}55` }} />
          );
        })}
      </div>
      <div className="relative h-4">
        <span
          className="absolute -top-[1.375rem] h-4 w-[3px] -translate-x-1/2 rounded-full bg-ink shadow-[0_0_10px_rgba(255,255,255,0.7)]"
          style={{ left: `${at * 100}%` }}
        />
        <div className="flex justify-between text-[0.6875rem] text-ink-faint">
          {BARRIER_BANDS.map((b) => (
            <span key={b.label} style={{ color: b.color }}>
              {b.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({
  value,
  label,
  property,
  accent,
}: {
  value: React.ReactNode;
  label: string;
  property?: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 border-l border-rule-bright pl-4">
      <span
        className={`num text-[2rem] font-medium leading-none tracking-tight sm:text-[2.5rem] ${
          accent ? "text-accent" : "text-ink"
        }`}
      >
        {value}
      </span>
      <span className="text-[0.8125rem] leading-snug text-ink-dim">
        {property ? <Term property={property}>{label}</Term> : label}
      </span>
    </div>
  );
}

/**
 * The first thing a visitor sees: what the campaign found, in one sentence and
 * four numbers, with the structure turning beside it. The dashboard waits
 * underneath, already at the end of the log.
 */
export function Hero() {
  const intro = useCampaign((s) => s.intro);
  const events = useCampaign((s) => s.events);
  const setIntro = useCampaign((s) => s.setIntro);
  const setTour = useCampaign((s) => s.setTour);
  const restart = useCampaign((s) => s.restart);

  const final = useMemo(() => stateAt(events, events.length), [events]);

  useEffect(() => {
    if (!intro) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIntro(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [intro, setIntro]);

  if (!intro || events.length === 0 || !final.spec) return null;

  const ledger = final.ledger;
  const wall = ledger?.wall_seconds ?? final.lastT;
  const screened = ledger?.candidates_generated ?? final.candidateIds.length;
  const dft = ledger?.est_dft_cpu_hours ?? 0;
  const hypothesis = hypothesisList(final)[0];
  const verdict = hypothesis?.status ?? "OPEN";

  const barriers = final.measurementLog.filter((m) => m.property === "migration_barrier");
  const best = barriers.reduce<(typeof barriers)[number] | null>(
    (b, m) => (b === null || m.value < b.value ? m : b),
    null,
  );
  const bestName = best ? (final.candidates[best.candidate_id]?.name ?? best.candidate_id) : null;
  // The headline number must carry the same caveats as the table it comes
  // from. Surfacing a flagged value bare on the landing card would undercut
  // the one thing this product claims over every other screening tool.
  const bestCaveat = best
    ? [best.ood_flag ? "out of distribution" : null, best.is_proxy ? "proxy" : null]
        .filter(Boolean)
        .join(" · ")
    : null;
  const domain = final.spec.domain.replace(/_/g, " ");

  const watch = () => {
    setIntro(false);
    setTour(true);
    restart();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Campaign result"
      className="no-print fixed inset-0 z-50 overflow-y-auto bg-ground/[0.97] backdrop-blur-sm"
    >
      <div className="hero-glow pointer-events-none absolute inset-0" />
      <div className="relative mx-auto flex min-h-full max-w-[1400px] flex-col justify-center gap-10 px-5 py-10 sm:px-10">
        <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="rise-in flex min-w-0 flex-col gap-7">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-[0.875rem] tracking-[0.3em] text-ink">
                ATHANOR
              </span>
              <span className="text-[0.8125rem] text-ink-faint">
                an autonomous AI scientist
              </span>
            </div>

            <h1 className="text-[2rem] font-medium leading-[1.12] tracking-tight text-ink sm:text-[2.75rem]">
              In <span className="text-accent">{fmtDuration(wall)}</span> on one machine, it{" "}
              {VERB[verdict]}.
            </h1>

            <div className="flex flex-wrap items-center gap-2.5">
              <Chip tone="solid" color={VERDICT_COLOR[verdict]}>
                Hypothesis {VERDICT_LABEL[verdict].toLowerCase()}
              </Chip>
              <span className="text-[0.9375rem] leading-relaxed text-ink-dim">
                {final.spec.goal}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-x-6 gap-y-7 sm:grid-cols-3">
              <Stat value={<CountUp value={screened} />} label={`${domain} candidates screened`} />
              {best ? (
                <Stat
                  accent
                  value={
                    <>
                      <CountUp value={best.value} format={(v) => v.toFixed(2)} />
                      <span className="ml-1.5 text-[1rem] text-ink-faint">eV</span>
                    </>
                  }
                  label={`best Li migration barrier · ${bestName}${bestCaveat ? ` · ${bestCaveat}` : ""}`}
                  property="migration_barrier"
                />
              ) : null}
              {dft > 0 ? (
                <Stat
                  value={
                    <>
                      ~<CountUp value={dft} format={(v) => fmtNumber(v)} />
                    </>
                  }
                  label="CPU-hours of DFT avoided · estimated"
                />
              ) : null}
            </div>

            {best ? (
              <div className="max-w-md">
                <BarrierScale value={best.value} />
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button tone="accent" onClick={watch} className="px-5 py-3 text-[0.875rem]">
                ▶ Watch it think
              </Button>
              <Button onClick={() => setIntro(false)} className="px-5 py-3 text-[0.875rem]">
                Explore the data
              </Button>
              <span className="text-[0.75rem] text-ink-faint">guided replay, narrated step by step</span>
            </div>
          </div>

          <div className="rise-in h-[22rem] min-w-0 sm:h-[30rem] lg:h-[34rem]">
            <ErrorBoundary label="hero-viewer">
              <Viewer />
            </ErrorBoundary>
          </div>
        </div>

        {dft > 0 ? (
          <p className="max-w-3xl border-t border-rule pt-5 text-[0.9375rem] leading-relaxed text-ink-dim">
            <span className="text-ink">Why it matters:</span> screening these candidates
            with DFT, the standard method, would take an estimated{" "}
            <span className="num text-accent">{fmtNumber(dft)} CPU-hours</span> on a
            cluster. ATHANOR did it in{" "}
            <span className="num text-accent">{fmtDuration(wall)}</span> with machine-learned
            physics, and a skeptic agent checking its work.
          </p>
        ) : null}
      </div>
    </div>
  );
}
