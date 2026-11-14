"use client";

import type { CSSProperties, ReactNode } from "react";

export function Panel({
  title,
  eyebrow,
  right,
  children,
  className = "",
  bodyClassName = "",
  scroll = true,
  id,
  order = 0,
}: {
  title: string;
  eyebrow?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  scroll?: boolean;
  id?: string;
  /** position in the first-paint stagger; purely presentational */
  order?: number;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      style={{ "--i": order } as CSSProperties}
      // scroll-mt keeps a panel the tour scrolls to clear of the sticky timeline
      className={`panel-surface panel-enter flex min-h-0 scroll-mt-32 flex-col border border-rule bg-panel ${className}`}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-rule px-3 py-2">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h2
            id={headingId}
            className="shrink-0 text-[0.875rem] font-medium tracking-tight text-ink"
          >
            {title}
          </h2>
          {eyebrow ? <span className="label min-w-0 truncate">{eyebrow}</span> : null}
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
      <p className="max-w-sm text-[0.8125rem] leading-relaxed text-ink-faint">{children}</p>
    </div>
  );
}
