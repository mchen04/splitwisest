"use client";

import { fmtMoney } from "@/lib/client";

// Dependency-free SVG bar charts with fixed heights so layout never shifts.

export function BarChart({
  data,
  currency,
  title,
}: {
  data: { label: string; value: number }[];
  currency: string;
  title: string;
}) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <figure aria-label={title}>
      <div className="h-44 space-y-2 overflow-y-auto pr-1">
        {data.length === 0 ? (
          <p className="pt-14 text-center text-body text-ink-faint">Nothing to chart yet.</p>
        ) : (
          data.map((d) => (
            <div key={d.label} className="grid grid-cols-[7rem_1fr_5rem] items-center gap-2 text-body">
              <span className="truncate text-ink-soft" title={d.label}>
                {d.label}
              </span>
              <div className="h-4 rounded-full bg-subtle">
                <div
                  className="h-4 rounded-full bg-accent/80 transition-[width] duration-300"
                  style={{ width: `${Math.max((d.value / max) * 100, 2)}%` }}
                />
              </div>
              <span className="tnum text-right text-ink-soft">{fmtMoney(d.value, currency)}</span>
            </div>
          ))
        )}
      </div>
    </figure>
  );
}

export function TimeChart({
  data,
  currency,
}: {
  data: { label: string; value: number }[];
  currency: string;
}) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <figure aria-label="Spending over time" className="h-44">
      {data.length === 0 ? (
        <p className="pt-14 text-center text-body text-ink-faint">Nothing to chart yet.</p>
      ) : (
        <div className="flex h-36 items-end gap-1.5">
          {data.map((d) => (
            <div key={d.label} className="group relative flex h-full flex-1 flex-col justify-end">
              <div
                className="rounded-t bg-accent/70 transition-colors group-hover:bg-accent"
                style={{ height: `${Math.max((d.value / max) * 100, 2)}%` }}
                title={`${d.label}: ${fmtMoney(d.value, currency)}`}
              />
              <span className="mt-1 block truncate text-center text-meta text-ink-faint">{d.label}</span>
            </div>
          ))}
        </div>
      )}
    </figure>
  );
}
