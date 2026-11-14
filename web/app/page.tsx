import { Suspense } from "react";
import { AppShell } from "@/components/panels/AppShell";

// `useSearchParams` (deep links) must sit inside a Suspense boundary or the
// static build fails on prerender.
export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh items-center justify-center bg-ground">
          <span className="font-mono text-[0.625rem] uppercase tracking-[0.24em] text-ink-faint">
            ATHANOR
          </span>
        </div>
      }
    >
      <AppShell />
    </Suspense>
  );
}
