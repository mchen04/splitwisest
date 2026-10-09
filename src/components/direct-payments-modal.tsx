"use client";

import { useState } from "react";
import { HandCoins, Pencil, Trash2 } from "lucide-react";
import { api, ApiClientError, fmtMoney, fmtDate, useApiData } from "@/lib/client";
import { Modal, Button, IconButton, LoadError, RowMeta, confirmAction, toast } from "./ui";
import { DirectSettleModal } from "./direct-settle-modal";

interface DirectSettlement {
  id: number;
  groupId: number | null;
  groupName: string | null;
  payerId: number;
  recipientId: number;
  payerName: string;
  recipientName: string;
  amountCents: number;
  currency: string;
  date: string;
  note: string;
  updatedAt: string;
}

// History of offline payments between you and one friend, with edit and delete.
export function DirectPaymentsModal({
  friend,
  meId,
  onClose,
  onChanged,
}: {
  friend: { id: number; displayName: string } | null;
  meId: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<DirectSettlement | null>(null);
  const [errorState, setErrorState] = useState<{ friendId: number; message: string } | null>(null);
  // An edited payment keeps its old version until the list is read again; its Delete waits for that.
  const [edited, setEdited] = useState<{ id: number; list: DirectSettlement[] | null } | null>(null);
  const { data, error: loadError, reload } = useApiData<{ settlements: DirectSettlement[] }>(
    `/api/settlements?friendId=${friend?.id ?? 0}`, 0, { sync: false, enabled: friend !== null }
  );
  // A failed first load is not an empty history: it says so and offers Try again.
  const list = data?.settlements ?? null;

  if (!friend) return null;
  const selectedFriend = friend;
  const error = errorState?.friendId === selectedFriend.id ? errorState.message : null;

  async function remove(s: DirectSettlement) {
    if (!(await confirmAction({
      title: "Delete payment?",
      message: `Delete this recorded payment of ${fmtMoney(s.amountCents, s.currency)}? Balances will update.`,
      confirmLabel: "Delete payment",
      danger: true,
    }))) return;
    const friendId = selectedFriend.id;
    setErrorState(null);
    try {
      await api(`/api/settlements/${s.id}?expectedUpdatedAt=${encodeURIComponent(s.updatedAt)}`, { method: "DELETE" });
      reload();
      onChanged();
      toast("Payment deleted");
    } catch (err) {
      setErrorState({
        friendId,
        message: err instanceof ApiClientError ? err.message : "Could not delete the payment",
      });
    }
  }

  return (
    <>
      <Modal open onClose={onClose} title={`Payments with ${friend.displayName}`} footer={<Button variant="secondary" onClick={onClose}>Done</Button>}>
        <p className="mb-3 text-body text-ink-soft">
          Payments recorded between the two of you, in groups and directly.
        </p>
        {error && <p role="alert" className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-body text-danger">{error}</p>}
        {list === null ? (
          loadError ? (
            <LoadError what="payment history" message={loadError} onRetry={reload} />
          ) : (
            <div role="status" className="space-y-3">
              <span className="sr-only">Loading payments…</span>
              {[...Array(3)].map((_, i) => <div key={i} className="skeleton h-12 w-full" />)}
            </div>
          )
        ) : list.length === 0 ? (
          <p className="py-8 text-center text-body text-ink-faint">
            No payments recorded yet. Use Settle up to record one.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {list.map((s) => {
              const updating = edited?.id === s.id && edited.list === data?.settlements;
              return (
              <li key={s.id} aria-busy={updating} className="flex items-center gap-2 py-2">
                <HandCoins className="h-4 w-4 shrink-0 text-owed" />
                <span className="min-w-0 flex-1">
                  <span className="block text-body">
                    <strong>{s.payerId === meId ? "You" : s.payerName}</strong> paid{" "}
                    <strong>{s.recipientId === meId ? "you" : s.recipientName}</strong>
                  </span>
                  <RowMeta>
                    {s.groupName ? `${s.groupName} · ` : "Direct · "}{fmtDate(s.date)}{s.note ? ` · ${s.note}` : ""}
                  </RowMeta>
                </span>
                {updating
                  ? <span role="status" className="text-meta text-ink-faint">Updating…</span>
                  : <span className="tnum text-body font-semibold">{fmtMoney(s.amountCents, s.currency)}</span>}
                <IconButton size="sm" variant="accent" label="Edit payment" onClick={() => setEditing(s)}>
                  <Pencil className="h-4 w-4" />
                </IconButton>
                <IconButton size="sm" variant="danger" label="Delete payment" disabled={updating} onClick={() => remove(s)}>
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </li>
              );
            })}
          </ul>
        )}
      </Modal>

      <DirectSettleModal
        friend={editing ? { id: friend.id, displayName: friend.displayName, obligations: [], netByCurrency: {} } : null}
        onClose={() => setEditing(null)}
        onSaved={() => {
          if (editing) setEdited({ id: editing.id, list: data?.settlements ?? null });
          reload();
          onChanged();
        }}
        existing={editing}
      />
    </>
  );
}
