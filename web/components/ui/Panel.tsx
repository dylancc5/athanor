"use client";

import type { ReactNode } from "react";

export function Panel({
  title,
  eyebrow,
  right,
  children,
  className = "",
  bodyClassName = "",
  scroll = true,
  id,
}: {
  title: string;
  eyebrow?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  scroll?: boolean;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={`flex min-h-0 flex-col border border-rule bg-panel ${className}`}
    >
      <header className="flex shrink-0 items-baseline justify-between gap-3 border-b border-rule px-3 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="truncate text-[0.8125rem] font-medium tracking-tight text-ink">
            {title}
          </h2>
          {eyebrow ? <span className="label shrink-0">{eyebrow}</span> : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </header>
      <div
        className={`min-h-0 flex-1 ${scroll ? "overflow-y-auto" : ""} ${bodyClassName}`}
      >
        {children}
      </div>
    </section>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-20 items-center justify-center p-6 text-center">
      <p className="max-w-xs text-xs leading-relaxed text-ink-faint">{children}</p>
    </div>
  );
}
