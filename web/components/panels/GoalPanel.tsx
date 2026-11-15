"use client";

import { useEffect, useRef, useState } from "react";
import { Panel } from "@/components/ui/Panel";
import { Button, Chip } from "@/components/ui/Bits";
import { fmtConstraint } from "@/lib/format";
import { useCampaign } from "@/lib/store";

// Direction is not a verdict, so it gets an arrow rather than a color that
// reads as good or bad.
const DIRECTION_MARK: Record<string, string> = {
  min: "↓ minimize",
  max: "↑ maximize",
  target: "◎ hit target",
};

function SpecView() {
  const state = useCampaign((s) => s.state);
  const spec = state.spec;
  // Weights only mean something relative to each other, so show all or none.
  const weighted = spec?.objectives.some((o) => (o.weight ?? 1) !== 1) ?? false;
  if (!spec) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <span className="label">Awaiting intake</span>
        <p className="text-[0.875rem] leading-relaxed text-ink-faint">
          The goal is parsed into objectives with units and directions, plus hard
          constraints, before any compute is spent.
        </p>
      </div>
    );
  }

  return (
    <div className="rise-in flex flex-col gap-3 p-3">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 className="text-[0.9375rem] font-medium tracking-tight text-ink">
            {spec.title}
          </h3>
          <Chip tone="ghost" color="#38bdf8">
            {spec.domain.replace(/_/g, " ")}
          </Chip>
        </div>
        <p className="text-[0.8125rem] leading-relaxed text-ink-dim">{spec.goal}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="label">Objectives</span>
        <ul className="flex flex-col divide-y divide-rule/70 border border-rule">
          {spec.objectives.map((o) => (
            <li
              key={o.property}
              className="flex items-center justify-between gap-3 px-2.5 py-2"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[0.8125rem] leading-snug text-ink">{o.label}</span>
                <span className="num break-all text-[0.6875rem] text-ink-faint">
                  {o.property} · {o.unit}
                  {o.target !== null && o.target !== undefined
                    ? ` · target ${o.target}`
                    : ""}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {weighted ? (
                  <span
                    className="num text-[0.6875rem] text-ink-faint"
                    title={`objective weight ${o.weight ?? 1}`}
                  >
                    ×{o.weight ?? 1}
                  </span>
                ) : null}
                <Chip color="#9aa8b8">
                  {DIRECTION_MARK[o.direction] ?? o.direction}
                </Chip>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Remounts on completion so the detail folds away once results matter more. */}
      <details key={String(state.completed)} open={!state.completed} className="group">
        <summary className="label cursor-pointer select-none list-none hover:text-ink-dim">
          <span className="inline-block transition-transform group-open:rotate-90">▸</span>{" "}
          {spec.constraints?.length ?? 0} constraint
          {(spec.constraints?.length ?? 0) === 1 ? "" : "s"} · seed strategy
        </summary>

      {spec.constraints && spec.constraints.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1.5">
          <span className="label">Constraints</span>
          <ul className="flex flex-col gap-2">
            {spec.constraints.map((c, i) => (
              <li key={i} className="flex flex-col items-start gap-1">
                <span className="num max-w-full break-all rounded border border-rule bg-panel-2 px-1.5 py-0.5 text-[0.6875rem] text-ink-dim">
                  {fmtConstraint(c.property, c.op, c.value)}
                </span>
                <span className="text-[0.8125rem] leading-relaxed text-ink-faint">
                  {c.description}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-3 flex flex-col gap-1">
        <span className="label">Seed strategy</span>
        <p className="text-[0.8125rem] leading-relaxed text-ink-faint">
          {spec.seed_strategy}
        </p>
      </div>
      </details>
    </div>
  );
}

/** Not an error state. A deliberate product decision, said plainly. */
function PublicDemoNotice() {
  const campaigns = useCampaign((s) => s.campaigns);
  const loadCampaign = useCampaign((s) => s.loadCampaign);
  const dismiss = useCampaign((s) => s.dismissNotice);
  const current = useCampaign((s) => s.campaignId);

  return (
    <div className="rise-in flex flex-col gap-3 border-b border-accent/25 bg-accent/5 p-3">
      <div className="flex flex-col gap-1.5">
        <span className="label text-accent">On running new campaigns</span>
        <p className="text-[0.875rem] leading-relaxed text-ink">
          {"Sorry, I don't wanna use API costs :) — but here are three campaigns I already ran."}
        </p>
        <p className="text-[0.8125rem] leading-relaxed text-ink-faint">
          Each one is a complete recorded event log, replayed here exactly as it
          happened. Nothing is re-simulated, so what you scrub through is what the
          system actually did.
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {campaigns.map((c) => (
          <Button
            key={c.id}
            tone="accent"
            active={c.id === current}
            onClick={() => {
              dismiss();
              void loadCampaign(c.id, { play: true });
            }}
            title={c.goal}
          >
            {c.title}
          </Button>
        ))}
        <Button onClick={dismiss}>Dismiss</Button>
      </div>
    </div>
  );
}

/** ⌘ on Apple keyboards, Ctrl everywhere else. Resolved after mount (SSR-safe). */
function useModKey() {
  const [mod, setMod] = useState("Ctrl");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setMod("⌘");
  }, []);
  return mod;
}

export function GoalPanel() {
  const [goal, setGoal] = useState("");
  // Once a spec is loaded the panel is showing a campaign, not asking for one.
  // The input comes back only when the user explicitly starts a new one.
  const [composing, setComposing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mod = useModKey();
  const requestCampaign = useCampaign((s) => s.requestCampaign);
  const notice = useCampaign((s) => s.publicDemoNotice);
  const state = useCampaign((s) => s.state);
  const source = useCampaign((s) => s.source);
  const sourceStatus = useCampaign((s) => s.sourceStatus);
  // Say up front that this build only replays, instead of letting someone
  // type a goal and find out afterwards.
  const replayOnly = sourceStatus === "ready" && source?.kind !== "api";

  const showInput = !state.spec || composing;

  useEffect(() => {
    if (composing) inputRef.current?.focus();
  }, [composing]);

  const submit = () => {
    if (goal.trim().length === 0) return;
    void requestCampaign(goal.trim());
    setComposing(false);
  };

  return (
    <Panel
      id="panel-goal"
      title="Research goal"
      eyebrow={state.spec ? "spec locked" : "intake"}
      right={
        state.spec && !composing ? (
          <Button size="sm" onClick={() => setComposing(true)} title="Start a new campaign">
            + New
          </Button>
        ) : null
      }
      bodyClassName=""
    >
      {notice ? <PublicDemoNotice /> : null}
      {showInput ? (
      <div className="no-print flex flex-col gap-2 border-b border-rule p-3">
        <label htmlFor="goal-input" className="label">
          Your goal, in one sentence
        </label>
        <textarea
          ref={inputRef}
          id="goal-input"
          name="goal"
          autoComplete="off"
          aria-describedby="goal-hint"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            if (e.key === "Escape" && state.spec) setComposing(false);
          }}
          rows={3}
          placeholder="e.g. a solid electrolyte with a low Li migration barrier that survives a lithium metal anode…"
          className="w-full resize-none rounded border border-rule bg-ground px-2.5 py-2 text-[0.875rem] leading-relaxed text-ink transition-colors duration-150 placeholder:text-ink-faint/80 hover:border-rule-bright focus-visible:border-accent/60"
        />
        <div className="flex items-end justify-between gap-3">
          <span id="goal-hint" className="text-[0.75rem] leading-snug text-ink-faint">
            {replayOnly ? (
              <>
                Replay-only demo. Pick a recorded campaign above; new runs are switched
                off here.
              </>
            ) : (
              <>
                <kbd className="num rounded border border-rule bg-panel-2 px-1 py-px text-[0.6875rem] text-ink-dim">
                  {mod} Enter
                </kbd>{" "}
                to run
              </>
            )}
          </span>
          <div className="flex shrink-0 gap-1.5">
            {state.spec ? <Button onClick={() => setComposing(false)}>Cancel</Button> : null}
            <Button tone="accent" onClick={submit} disabled={goal.trim().length === 0}>
              Run campaign
            </Button>
          </div>
        </div>
      </div>
      ) : null}
      <SpecView />
    </Panel>
  );
}
