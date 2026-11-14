"use client";

import { useState } from "react";
import { Panel } from "@/components/ui/Panel";
import { Button, Chip } from "@/components/ui/Bits";
import { fmtConstraint } from "@/lib/format";
import { useCampaign } from "@/lib/store";

const DIRECTION_MARK: Record<string, string> = {
  min: "minimize",
  max: "maximize",
  target: "hit target",
};

function SpecView() {
  const state = useCampaign((s) => s.state);
  const spec = state.spec;
  if (!spec) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <span className="label">Awaiting intake</span>
        <p className="text-[0.8125rem] leading-relaxed text-ink-faint">
          The goal is parsed into objectives with units and directions, plus hard
          constraints, before any compute is spent.
        </p>
      </div>
    );
  }

  return (
    <div className="rise-in flex flex-col gap-3 p-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[0.875rem] font-medium tracking-tight text-ink">
            {spec.title}
          </h3>
          <Chip tone="ghost" color="#38bdf8">
            {spec.domain.replace(/_/g, " ")}
          </Chip>
        </div>
        <p className="text-[0.75rem] leading-relaxed text-ink-faint">{spec.goal}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="label">Objectives</span>
        <ul className="flex flex-col divide-y divide-rule/70 border border-rule">
          {spec.objectives.map((o) => (
            <li
              key={o.property}
              className="flex items-center justify-between gap-3 px-2 py-1.5"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[0.75rem] text-ink">{o.label}</span>
                <span className="num text-[0.625rem] text-ink-faint">
                  {o.property} · {o.unit}
                  {o.target !== null && o.target !== undefined
                    ? ` · target ${o.target}`
                    : ""}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {o.weight !== undefined && o.weight !== 1 ? (
                  <span className="num text-[0.625rem] text-ink-faint">
                    w{o.weight}
                  </span>
                ) : null}
                <Chip color={o.direction === "min" ? "#7dd3fc" : "#34d399"}>
                  {DIRECTION_MARK[o.direction] ?? o.direction}
                </Chip>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {spec.constraints && spec.constraints.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="label">Constraints</span>
          <ul className="flex flex-col gap-1">
            {spec.constraints.map((c, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="num shrink-0 rounded border border-rule bg-panel-2 px-1 py-0.5 text-[0.625rem] text-ink-dim">
                  {fmtConstraint(c.property, c.op, c.value)}
                </span>
                <span className="text-[0.6875rem] leading-relaxed text-ink-faint">
                  {c.description}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <span className="label">Seed strategy</span>
        <p className="text-[0.6875rem] leading-relaxed text-ink-faint">
          {spec.seed_strategy}
        </p>
      </div>
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
        <p className="text-[0.8125rem] leading-relaxed text-ink">
          {"Sorry, I don't wanna use API costs :) — but here are three campaigns I already ran."}
        </p>
        <p className="text-[0.75rem] leading-relaxed text-ink-faint">
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

export function GoalPanel() {
  const [goal, setGoal] = useState("");
  const requestCampaign = useCampaign((s) => s.requestCampaign);
  const notice = useCampaign((s) => s.publicDemoNotice);
  const state = useCampaign((s) => s.state);

  const submit = () => {
    if (goal.trim().length === 0) return;
    void requestCampaign(goal.trim());
  };

  return (
    <Panel
      id="panel-goal"
      title="Research goal"
      eyebrow={state.spec ? "spec locked" : "intake"}
      bodyClassName=""
    >
      {notice ? <PublicDemoNotice /> : null}
      <div className="no-print flex flex-col gap-2 border-b border-rule p-3">
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          rows={2}
          placeholder="Describe what you want found, in a sentence. e.g. a solid electrolyte with a low Li migration barrier that survives a lithium metal anode."
          className="w-full resize-none rounded border border-rule bg-ground px-2.5 py-2 text-[0.8125rem] leading-relaxed text-ink placeholder:text-ink-faint/70 focus:border-accent/50 focus:outline-none"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="label">Cmd+Enter to run</span>
          <Button tone="accent" onClick={submit} disabled={goal.trim().length === 0}>
            Run campaign
          </Button>
        </div>
      </div>
      <SpecView />
    </Panel>
  );
}
