"use client";

import { CURRENCIES } from "@/lib/client";
import { Field, Input, Select } from "./ui";

// The amount / currency / date / note block shared by every settlement form
// (group settle-up and direct friend settle-up).
export function SettleFields({
  amount,
  setAmount,
  currency,
  setCurrency,
  date,
  setDate,
  note,
  setNote,
  notePlaceholder,
  lockAmount = false,
  lockCurrency = false,
  showAmount = true,
}: {
  amount: string;
  setAmount: (v: string) => void;
  currency: string;
  setCurrency: (v: string) => void;
  date: string;
  setDate: (v: string) => void;
  note: string;
  setNote: (v: string) => void;
  notePlaceholder: string;
  lockAmount?: boolean;
  lockCurrency?: boolean;
  /** False when a summary above already states the (locked) amount. */
  showAmount?: boolean;
}) {
  return (
    <>
      {showAmount && <div className="grid grid-cols-[1fr_auto] gap-2">
        <Field label="Amount">
          <Input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            readOnly={lockAmount}
            required
            placeholder="0.00"
            data-autofocus={lockAmount ? undefined : true}
          />
        </Field>
        <Field label="Currency">
          <Select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            disabled={lockCurrency}
            className="w-24"
          >
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
      </div>}
      <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-2">
        <Field label="Date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={notePlaceholder} />
        </Field>
      </div>
    </>
  );
}
