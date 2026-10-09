"use client";

import { Dispatch, SetStateAction } from "react";
import { Plus, Trash2 } from "lucide-react";
import { fmtMoney } from "@/lib/client";
import { currencySymbol } from "@/lib/currencies";
import { Button, IconButton, Input, radioGroupKeyDown, radioTabIndex } from "./ui";
import { Member } from "./expense-form";

export type Method = "solo" | "equal" | "exact" | "percentage" | "shares" | "itemized";

export const METHOD_LABELS: Record<Method, string> = {
  solo: "One person",
  equal: "Equal",
  exact: "Exact amounts",
  percentage: "Percentages",
  shares: "Shares",
  itemized: "Itemized bill",
};

export interface ItemRow {
  name: string;
  amount: string;
  participantIds: number[];
}

const LEGEND = "mb-1.5 block text-body font-medium text-ink-soft";

// Participant picker for equal/exact/percentage/shares: a checkbox per member
// plus, for weighted methods, the per-member value input.
export function ParticipantSplit({
  members, selected, method, values, amountCents, currency, participantCount, onToggle, onValue, idPrefix = "p",
}: {
  members: Member[];
  selected: Set<number>;
  method: Exclude<Method, "itemized">;
  values: Record<number, string>;
  amountCents: number;
  currency: string;
  participantCount: number;
  onToggle: (id: number) => void;
  onValue: (id: number, value: string) => void;
  idPrefix?: string;
}) {
  if (method === "solo") {
    return (
      <fieldset>
        <legend className={LEGEND}>Who owes the full amount?</legend>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Who owes the full amount?" onKeyDown={radioGroupKeyDown}>
          {members.map((member, index) => {
            const checked = selected.has(member.id);
            return (
              <button
                key={member.id}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={radioTabIndex(checked, index, members.some((m) => selected.has(m.id)))}
                onClick={() => onToggle(member.id)}
                className={`min-h-[var(--control-h)] min-w-0 rounded-lg border px-2.5 py-1.5 text-left ${checked ? "border-accent bg-accent-soft" : "border-line bg-card hover:border-line-strong"}`}
              >
                <span className="block truncate text-body font-medium">{member.displayName}</span>
                {checked && amountCents > 0 && (
                  <span className="tnum block truncate text-meta text-ink-faint">{fmtMoney(amountCents, currency)}</span>
                )}
              </button>
            );
          })}
        </div>
      </fieldset>
    );
  }

  if (method === "equal") {
    return (
      <fieldset>
        <legend className={LEGEND}>Participants</legend>
        <div className="grid grid-cols-2 gap-2">
          {members.map((member) => {
            const checked = selected.has(member.id);
            return (
              <label
                key={member.id}
                className={`flex min-h-[var(--control-h)] min-w-0 cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 ${checked ? "border-accent bg-accent-soft" : "border-line bg-card hover:border-line-strong"}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(member.id)}
                  className="h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium">{member.displayName}</span>
                  {checked && amountCents > 0 && (
                    <span className="tnum block truncate text-meta text-ink-faint">
                      ≈ {fmtMoney(Math.floor(amountCents / Math.max(participantCount, 1)), currency)}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
    );
  }

  return (
    <fieldset>
      <legend className={LEGEND}>Participants</legend>
      <div className="divide-y divide-line rounded-lg border border-line">
        {members.map((m) => {
          const checked = selected.has(m.id);
          return (
            <div key={m.id} className="flex min-h-[var(--row-h)] items-center gap-3 px-3 py-1.5">
              <input
                id={`${idPrefix}-${m.id}`}
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(m.id)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              <label htmlFor={`${idPrefix}-${m.id}`} className="min-w-0 flex-1 truncate text-body font-medium">
                {m.displayName}
              </label>
              {checked && (
                <div className="flex items-center gap-1.5">
                  <Input
                    inputMode="decimal"
                    value={values[m.id] ?? ""}
                    onChange={(e) => onValue(m.id, e.target.value)}
                    className="!w-24 text-right"
                    aria-label={`${METHOD_LABELS[method]} for ${m.displayName}`}
                    placeholder={method === "exact" ? "0.00" : method === "percentage" ? "%" : "1"}
                  />
                  <span className="min-w-4 text-meta text-ink-faint">
                    {method === "percentage" ? "%" : method === "exact" ? currencySymbol(currency) : "×"}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

// Itemized bill: a row per item with its own amount and per-item participants.
export function ItemizedSplit({
  members,
  items,
  setItems,
  currency,
  subtotalCents,
  taxEnabled,
  taxRate,
  taxCents,
  tipEnabled,
  tipRate,
  tipCents,
  totalCents,
  onTaxEnabled,
  onTaxRate,
  onTipEnabled,
  onTipRate,
}: {
  members: Member[];
  items: ItemRow[];
  setItems: Dispatch<SetStateAction<ItemRow[]>>;
  currency: string;
  subtotalCents: number;
  taxEnabled: boolean;
  taxRate: string;
  taxCents: number;
  tipEnabled: boolean;
  tipRate: string;
  tipCents: number;
  totalCents: number;
  onTaxEnabled: (enabled: boolean) => void;
  onTaxRate: (rate: string) => void;
  onTipEnabled: (enabled: boolean) => void;
  onTipRate: (rate: string) => void;
}) {
  const patch = (idx: number, next: Partial<ItemRow>) =>
    setItems((arr) => arr.map((x, i) => (i === idx ? { ...x, ...next } : x)));

  return (
    <fieldset>
      <legend className={LEGEND}>Items — pick who shared each one</legend>
      <div className="space-y-2">
        {items.map((item, idx) => (
          <div key={idx} className="rounded-lg border border-line p-3">
            <div className="grid grid-cols-[minmax(0,1fr)_6.5rem_auto] gap-2">
              <Input
                value={item.name}
                onChange={(e) => patch(idx, { name: e.target.value })}
                placeholder="Pad thai"
                aria-label={`Item ${idx + 1} name`}
              />
              <Input
                inputMode="decimal"
                value={item.amount}
                onChange={(e) => patch(idx, { amount: e.target.value })}
                className="text-right"
                placeholder="0.00"
                aria-label={`Item ${idx + 1} amount`}
              />
              <IconButton
                variant="danger"
                onClick={() => setItems((arr) => arr.filter((_, i) => i !== idx))}
                label={`Remove item ${idx + 1}`}
              >
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {members.map((m) => {
                const on = item.participantIds.includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      patch(idx, {
                        participantIds: on
                          ? item.participantIds.filter((p) => p !== m.id)
                          : [...item.participantIds, m.id],
                      })
                    }
                    className={`min-h-[var(--control-h-sm)] rounded-full border px-3 py-1 text-body font-medium ${
                      on ? "border-accent bg-accent-soft text-accent-dark" : "border-line text-ink-soft"
                    }`}
                  >
                    {m.displayName}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          onClick={() => setItems((arr) => [...arr, { name: "", amount: "", participantIds: [] }])}
        >
          <Plus className="h-4 w-4" /> Add item
        </Button>
        <div className="rounded-lg border border-line bg-subtle/60 p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex min-h-[var(--control-h-sm)] items-center gap-2 text-body font-medium">
              <input
                type="checkbox"
                checked={taxEnabled}
                onChange={(e) => onTaxEnabled(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              Tax
            </label>
            <div className="flex items-center justify-between gap-2">
              <Input
                inputMode="decimal"
                value={taxRate}
                onChange={(e) => onTaxRate(e.target.value)}
                disabled={!taxEnabled}
                className="!w-24 text-right"
                aria-label="Tax rate"
              />
              <span className="text-body text-ink-faint">% = {fmtMoney(taxCents, currency)}</span>
            </div>
            <label className="flex min-h-[var(--control-h-sm)] items-center gap-2 text-body font-medium">
              <input
                type="checkbox"
                checked={tipEnabled}
                onChange={(e) => onTipEnabled(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              Tip
            </label>
            <div className="flex items-center justify-between gap-2">
              <Input
                inputMode="decimal"
                value={tipRate}
                onChange={(e) => onTipRate(e.target.value)}
                disabled={!tipEnabled}
                className="!w-24 text-right"
                aria-label="Tip rate"
              />
              <span className="text-body text-ink-faint">% = {fmtMoney(tipCents, currency)}</span>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-body">
            <span className="text-ink-faint">Subtotal</span>
            <span className="text-ink-faint">Adjustments</span>
            <span className="text-right font-semibold">Total</span>
            <span className="tnum">{fmtMoney(subtotalCents, currency)}</span>
            <span className="tnum">{fmtMoney(taxCents + tipCents, currency)}</span>
            <span className="tnum text-right font-semibold">{fmtMoney(totalCents, currency)}</span>
          </div>
        </div>
      </div>
    </fieldset>
  );
}
