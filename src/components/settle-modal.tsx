"use client";

import { useEffect, useState } from "react";
import { api, todayStr, fmtMoney, useFormState, amountInputToCents } from "@/lib/client";
import { Button, Field, Select, Modal, ErrorNote, toast } from "./ui";
import { SettleFields } from "./settle-fields";
import { Member } from "./expense-form";

// Records an offline payment — purely a ledger entry, no money moves here.
export function SettleModal({
  open,
  onClose,
  onSaved,
  groupId,
  members,
  meId,
  defaultCurrency,
  prefill,
  start,
  existing,
  onCustom,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  groupId: number;
  members: Member[];
  meId: number;
  defaultCurrency: string;
  prefill?: { payerId: number; recipientId: number; amountCents: number } | null;
  /** Who pays whom, with the amount left editable (a partial payment opened from another page). */
  start?: { payerId: number; recipientId: number } | null;
  existing?: { id: number; payerId: number; recipientId: number; amountCents: number; currency: string; date: string; note: string; updatedAt: string } | null;
  /** Unlocks a suggested payment so the user can change who or how much. */
  onCustom?: () => void;
}) {
  const [payerId, setPayerId] = useState(meId);
  const [recipientId, setRecipientId] = useState(0);
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [date, setDate] = useState(todayStr());
  const [note, setNote] = useState("");
  const { error, setError, busy, run } = useFormState();
  const nameOf = (id: number) => members.find((m) => m.id === id)?.displayName ?? "Someone";

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (existing) {
      // Reset the settlement form when opening or switching the edited payment.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPayerId(existing.payerId);
      setRecipientId(existing.recipientId);
      setAmount((existing.amountCents / 100).toFixed(2));
      setCurrency(existing.currency);
      setDate(String(existing.date).slice(0, 10));
      setNote(existing.note);
    } else {
      setDate(todayStr());
      setNote("");
      setCurrency(defaultCurrency);
      const startOk = start && members.some((m) => m.id === start.payerId) && members.some((m) => m.id === start.recipientId);
      if (prefill) {
        setPayerId(prefill.payerId);
        setRecipientId(prefill.recipientId);
        setAmount((prefill.amountCents / 100).toFixed(2));
      } else if (start && startOk) {
        setPayerId(start.payerId);
        setRecipientId(start.recipientId);
        setAmount("");
      } else {
        setPayerId(meId);
        setRecipientId(members.find((m) => m.id !== meId)?.id ?? 0);
        setAmount("");
      }
    }
    // Only reset when the modal opens — background sync refreshes replace the
    // members array reference and must not wipe in-progress input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing?.id]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const amountCents = amountInputToCents(amount) ?? 0;
    if (amountCents <= 0) return setError("Enter a positive amount");
    if (payerId === recipientId) return setError("Payer and recipient must be different");
    run(async () => {
      if (existing) {
        await api(`/api/settlements/${existing.id}`, {
          method: "PATCH",
          body: { amountCents, currency, date, note, expectedUpdatedAt: existing.updatedAt },
        });
      } else {
        await api(`/api/groups/${groupId}/settlements`, {
          body: { payerId, recipientId, amountCents, currency, date, note, settleFullBalance: Boolean(prefill) },
        });
      }
      onSaved();
      toast(existing ? "Payment updated" : `Payment of ${fmtMoney(amountCents, currency)} recorded`);
      onClose();
    }, existing ? "Could not update settlement" : "Could not record settlement");
  }

  return (
    <Modal open={open} onClose={onClose} title={existing ? "Edit recorded payment" : "Settle up"}>
      <form onSubmit={submit} className="space-y-3">
        {prefill && !existing ? (
          <div className="rounded-xl bg-subtle px-3 py-2.5">
            {/* Read from the suggestion itself: the form fields fill in an effect,
                so they would show the previous payment for one frame. */}
            <p className="text-body text-ink-soft">
              <strong className="text-ink">{prefill.payerId === meId ? "You" : nameOf(prefill.payerId)}</strong>
              {prefill.payerId === meId ? " pay " : " pays "}
              <strong className="text-ink">{prefill.recipientId === meId ? "you" : nameOf(prefill.recipientId)}</strong>
            </p>
            <p className={`tnum text-amount font-semibold tracking-tight ${prefill.payerId === meId ? "text-owe" : prefill.recipientId === meId ? "text-owed" : "text-ink"}`}>
              {fmtMoney(prefill.amountCents, defaultCurrency)}
            </p>
            {onCustom && (
              <button type="button" onClick={onCustom} className="-ml-1 mt-0.5 inline-flex min-h-[var(--control-h-sm)] items-center rounded-lg px-1 text-body font-medium text-accent hover:bg-accent-soft">
                Change amount or people
              </button>
            )}
          </div>
        ) : (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Who paid">
            <Select value={payerId} disabled={!!existing || !!prefill} onChange={(e) => setPayerId(Number(e.target.value))}>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Who received">
            <Select value={recipientId} disabled={!!existing || !!prefill} onChange={(e) => setRecipientId(Number(e.target.value))}>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        )}
        <SettleFields
          amount={amount} setAmount={setAmount}
          currency={currency} setCurrency={setCurrency}
          date={date} setDate={setDate}
          note={note} setNote={setNote}
          notePlaceholder="Paid in cash"
          lockAmount={Boolean(prefill && !existing)}
          lockCurrency={Boolean(prefill && !existing)}
          showAmount={!(prefill && !existing)}
        />
        <p className="text-meta text-ink-faint">Records a payment made outside SplitWisest, such as cash or a bank transfer. No money moves.</p>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} data-autofocus>
            {existing ? "Save changes" : `Record ${amount ? fmtMoney(amountInputToCents(amount) ?? 0, currency) : ""}`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
