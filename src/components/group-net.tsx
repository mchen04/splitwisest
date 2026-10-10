"use client";

import { fmtMoney } from "@/lib/client";

/** A group's balance for the viewer: word + color + amount, never color alone. */
export function GroupNet({ cents, currency }: { cents: number; currency: string }) {
  if (cents === 0) return <span className="shrink-0 text-body text-ink-faint">settled</span>;
  return (
    <span className={`shrink-0 text-right ${cents > 0 ? "text-owed" : "text-owe"}`}>
      <span className="block text-meta">{cents > 0 ? "you're owed" : "you owe"}</span>
      <span className="tnum block text-body font-semibold">{fmtMoney(Math.abs(cents), currency)}</span>
    </span>
  );
}
