"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * A failed 3D frame must never blank the page. WebGL is unavailable or
 * software-rendered in plenty of environments (headless CI, remote desktops),
 * and a campaign is a live stream, so components get mounted with partial data.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode; label?: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label ?? "boundary"}]`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div className="flex h-full items-center justify-center p-6 text-center">
            <div className="flex flex-col gap-1.5">
              <span className="label text-inconclusive">Render failed</span>
              <p className="max-w-xs text-[0.8125rem] leading-relaxed text-ink-faint">
                {this.state.error.message || "This view could not be drawn."} The rest
                of the campaign is unaffected.
              </p>
            </div>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
