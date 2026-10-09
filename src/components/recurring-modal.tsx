"use client";

import { useEffect, useState } from "react";
import { api, useFormState, amountInputToCents, localDateStr } from "@/lib/client";
import { Button, Field, Input, Select, Modal, ErrorNote, toast } from "./ui";
import { Member } from "./expense-form";

export interface ExistingRecurring {
  id: number;
  title: string;
  amountCents: number;
  currency: string;
  payerId: number;
  categoryId: number | null;
  participantIds: number[];
  notes: string;
  cadence: "weekly" | "monthly";
  nextDate: string;
  anchorDay: number | null;
  active: boolean;
  updatedAt: string;
}

export function RecurringModal({
  open, onClose, onSaved, groupId, members, meId, defaultCurrency, existing,
}: {
  open: boolean; onClose: () => void; onSaved: () => void;
  groupId: number; members: Member[]; meId: number; defaultCurrency: string;
  existing?: ExistingRecurring | null;
}) {
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [payerId, setPayerId] = useState(meId);
  const [cadence, setCadence] = useState<"weekly" | "monthly">("monthly");
  const [startDate, setStartDate] = useState("");
  const { error, setError, busy, run } = useFormState();

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (existing) {
      // Reset the recurring rule form when opening or switching the edited rule.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTitle(existing.title);
      setAmount((existing.amountCents / 100).toFixed(2));
      setPayerId(existing.payerId);
      setCadence(existing.cadence);
      setStartDate(String(existing.nextDate).slice(0, 10));
    } else {
      setTitle(""); setAmount(""); setPayerId(meId); setCadence("monthly");
      const d = new Date(); d.setDate(d.getDate() + 1);
      setStartDate(localDateStr(d));
    }
    // Reset only when the modal opens or the edited rule changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing?.id]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const amountCents = amountInputToCents(amount) ?? 0;
    if (amountCents <= 0) return setError("Enter a positive amount");
    const participantIds = members.map((m) => m.id);
    run(async () => {
      if (existing) {
        await api(`/api/recurring/${existing.id}`, {
          method: "PATCH",
          body: {
            title: title.trim(), amountCents, currency: existing.currency, payerId,
            categoryId: existing.categoryId, participantIds: existing.participantIds,
            cadence, nextDate: startDate, notes: existing.notes, active: existing.active,
            expectedUpdatedAt: existing.updatedAt,
          },
        });
      } else {
        await api(`/api/groups/${groupId}/recurring`, {
          body: {
            title: title.trim(), amountCents, currency: defaultCurrency, payerId,
            participantIds, cadence, startDate, notes: "",
          },
        });
      }
      onSaved(); toast(existing ? "Recurring expense updated" : "Recurring expense added"); onClose();
    }, existing ? "Could not update recurring expense" : "Could not create recurring expense");
  }

  return (
    <Modal open={open} onClose={onClose} title={existing ? "Edit recurring expense" : "Add recurring expense"}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} placeholder="Rent" data-autofocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Amount (${defaultCurrency})`}>
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required placeholder="0.00" />
          </Field>
          <Field label="Paid by">
            <Select value={payerId} onChange={(e) => setPayerId(Number(e.target.value))}>
              {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </Select>
          </Field>
          <Field label="Repeats">
            <Select value={cadence} onChange={(e) => setCadence(e.target.value as "weekly" | "monthly")}>
              <option value="monthly">Monthly</option>
              <option value="weekly">Weekly</option>
            </Select>
          </Field>
          <Field label={existing ? "Next date" : "First date"}>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </Field>
        </div>
        <p className="text-meta text-ink-faint">
          Splits equally among all current group members each time it runs.
        </p>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" busy={busy}>{existing ? "Save changes" : "Add recurring"}</Button>
        </div>
      </form>
    </Modal>
  );
}
