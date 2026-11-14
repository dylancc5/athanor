"use client";

import { useEffect, useRef } from "react";
import { Panel, EmptyNote } from "@/components/ui/Panel";
import { AUTHOR_COLOR, AUTHOR_LABEL } from "@/lib/design";
import { type NotebookEntry, notebookEntries } from "@/lib/campaign-state";
import { useCampaign } from "@/lib/store";

/**
 * Tracks how long each entry's text was on the previous render, so the chunk
 * that just arrived can be faded in. Purely presentational — the reducer
 * stores plain concatenated prose.
 */
function useArrivingChunk(entries: NotebookEntry[]) {
  const lengths = useRef<Record<string, number>>({});
  const previous: Record<string, number> = {};
  for (const e of entries) {
    previous[e.entryId] = lengths.current[e.entryId] ?? 0;
  }
  useEffect(() => {
    const next: Record<string, number> = {};
    for (const e of entries) next[e.entryId] = e.text.length;
    lengths.current = next;
  }, [entries]);
  return previous;
}

function Entry({
  entry,
  settledLength,
  live,
}: {
  entry: NotebookEntry;
  settledLength: number;
  live: boolean;
}) {
  const color = AUTHOR_COLOR[entry.author] ?? "#94a3b8";
  const settled = entry.text.slice(0, Math.min(settledLength, entry.text.length));
  const arriving = entry.text.slice(Math.min(settledLength, entry.text.length));

  return (
    <article className="rise-in border-l-2 pl-3" style={{ borderColor: `${color}66` }}>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span
          className="font-mono text-[0.625rem] uppercase tracking-[0.14em]"
          style={{ color }}
        >
          {AUTHOR_LABEL[entry.author] ?? entry.author}
        </span>
        {entry.heading ? (
          <h3 className="min-w-0 text-[0.8125rem] font-medium leading-snug text-ink">
            {entry.heading}
          </h3>
        ) : null}
      </div>
      <p
        className={`whitespace-pre-wrap text-[0.8125rem] leading-[1.65] text-ink-dim ${
          live && arriving.length > 0 ? "caret" : ""
        }`}
      >
        {settled}
        {arriving.length > 0 ? (
          <span key={settled.length} className="rise-in text-ink">
            {arriving}
          </span>
        ) : null}
      </p>
    </article>
  );
}

export function Notebook() {
  const state = useCampaign((s) => s.state);
  const playing = useCampaign((s) => s.playing);
  const entries = notebookEntries(state);
  const settled = useArrivingChunk(entries);
  const scroller = useRef<HTMLDivElement | null>(null);
  const lastId = entries.length > 0 ? entries[entries.length - 1].entryId : null;
  const lastLen = entries.length > 0 ? entries[entries.length - 1].text.length : 0;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [lastId, lastLen]);

  const words = entries.reduce((n, e) => n + e.text.split(/\s+/).filter(Boolean).length, 0);

  return (
    <Panel
      id="panel-notebook"
      title="Lab notebook"
      eyebrow={entries.length > 0 ? `${words} words` : undefined}
      right={
        playing && entries.length > 0 ? (
          <span className="label text-accent">writing</span>
        ) : null
      }
      scroll={false}
    >
      {entries.length === 0 ? (
        <EmptyNote>
          Every agent writes here as it reasons. The notebook is append-only, so the
          record of a wrong turn survives the turn.
        </EmptyNote>
      ) : (
        <div ref={scroller} className="flex h-full flex-col gap-5 overflow-y-auto p-3">
          {entries.map((e) => (
            <Entry
              key={e.entryId}
              entry={e}
              settledLength={settled[e.entryId] ?? 0}
              live={playing && e.entryId === lastId}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}
