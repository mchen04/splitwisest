"use client";

import { useEffect, useState } from "react";
import { LogOut, Pencil, Plus, Trash2, UserMinus } from "lucide-react";
import { api, ApiClientError, useFormState } from "@/lib/client";
import { Button, Field, Input, Modal, ErrorNote, Avatar, IconButton, SectionLabel, confirmAction, toast } from "./ui";
import { Member } from "./expense-form";

// Group admin surface: rename, manage members (remove / leave), and delete.
export function GroupSettingsModal({
  open,
  onClose,
  group,
  members,
  meId,
  onChanged,
  onGone,
  units,
  autoReconcileUnits,
}: {
  open: boolean;
  onClose: () => void;
  group: { id: number; name: string; createdBy: number };
  members: (Member & { username: string })[];
  meId: number;
  onChanged: () => void;
  onGone: () => void;
  units: { id: number; name: string }[];
  autoReconcileUnits: boolean;
}) {
  const [name, setName] = useState(group.name);
  const { error, setError, busy, run } = useFormState();
  const [actionError, setActionError] = useState<string | null>(null);
  const [unitName, setUnitName] = useState("");
  const [editingUnitId, setEditingUnitId] = useState<number | null>(null);
  const [unitBusy, setUnitBusy] = useState(false);
  const [reconcile, setReconcile] = useState(autoReconcileUnits);
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const isCreator = group.createdBy === meId;

  useEffect(() => {
    if (!open) return;
    // Seed the settings form from the selected group when the modal opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(group.name);
    setError(null);
    setActionError(null);
    setUnitName("");
    setEditingUnitId(null);
    setReconcile(autoReconcileUnits);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, group.id]);

  async function saveUnit(e: React.FormEvent) {
    e.preventDefault();
    if (!unitName.trim() || unitBusy) return;
    setUnitBusy(true);
    setActionError(null);
    try {
      if (editingUnitId === null) {
        await api(`/api/groups/${group.id}/units`, { body: { name: unitName.trim() } });
        toast(`Unit ${unitName.trim()} added`);
      } else {
        await api(`/api/groups/${group.id}/units/${editingUnitId}`, { method: "PATCH", body: { name: unitName.trim() } });
        toast(`Unit renamed to ${unitName.trim()}`);
      }
      setUnitName("");
      setEditingUnitId(null);
      onChanged();
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : "Could not save the unit");
    } finally {
      setUnitBusy(false);
    }
  }

  async function deleteUnit(unit: { id: number; name: string }) {
    if (!(await confirmAction({
      title: `Delete ${unit.name}?`,
      message: "Units can only be deleted when no expense, payment, or recurring expense uses them.",
      confirmLabel: "Delete unit",
      danger: true,
    }))) return;
    setActionError(null);
    try {
      await api(`/api/groups/${group.id}/units/${unit.id}`, { method: "DELETE" });
      toast(`${unit.name} deleted`);
      onChanged();
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : "Could not delete the unit");
    }
  }

  async function toggleReconcile(next: boolean) {
    setReconcile(next);
    setReconcileBusy(true);
    setActionError(null);
    try {
      await api(`/api/groups/${group.id}`, { method: "PATCH", body: { autoReconcileUnits: next } });
      toast(next ? "Unit balances now simplify automatically" : "Unit balances now keep direct debts");
      onChanged();
    } catch (err) {
      setReconcile(!next);
      setActionError(err instanceof ApiClientError ? err.message : "Could not change unit reconciliation");
    } finally {
      setReconcileBusy(false);
    }
  }

  function rename(e: React.FormEvent) {
    e.preventDefault();
    run(async () => {
      await api(`/api/groups/${group.id}`, { method: "PATCH", body: { name: name.trim() } });
      toast(`Group renamed to ${name.trim()}`);
      onChanged();
    }, "Could not rename the group");
  }

  async function removeMember(userId: number, displayName: string) {
    const self = userId === meId;
    if (!(await confirmAction(self
      ? { title: "Leave this group?", message: "You can rejoin later with the invite code.", confirmLabel: "Leave group", danger: true }
      : { title: `Remove ${displayName}?`, message: `${displayName} will leave this group.`, confirmLabel: "Remove member", danger: true }))) return;
    setActionError(null);
    try {
      await api(`/api/groups/${group.id}/members/${userId}`, { method: "DELETE" });
      if (self) onGone();
      else {
        toast(`${displayName} removed from the group`);
        onChanged();
      }
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : "Could not remove that member");
    }
  }

  async function deleteGroup() {
    if (!(await confirmAction({
      title: `Delete ${group.name}?`,
      message: "This permanently removes all its expenses, payments, and chat for everyone. This can't be undone.",
      confirmLabel: "Delete group",
      danger: true,
    }))) return;
    setActionError(null);
    try {
      await api(`/api/groups/${group.id}`, { method: "DELETE" });
      onGone();
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : "Could not delete the group");
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Group settings">
      <div className="space-y-4">
        <form onSubmit={rename} className="space-y-2">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Field label="Group name">
                <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} data-autofocus />
              </Field>
            </div>
            <Button type="submit" busy={busy} disabled={!name.trim() || name.trim() === group.name}>
              Save name
            </Button>
          </div>
          <ErrorNote message={error} />
        </form>

        <div>
          <SectionLabel className="mb-1.5">Custom units</SectionLabel>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {units.length === 0 ? (
              <li className="px-3 py-2 text-body text-ink-faint">No custom units yet. Add one to track drinks, chores, or points.</li>
            ) : units.map((unit) => (
              <li key={unit.id} className="flex min-h-[var(--row-h)] items-center gap-2 px-3 py-1">
                <span className="min-w-0 flex-1 truncate text-body font-medium">{unit.name}</span>
                <IconButton
                  size="sm"
                  variant="accent"
                  label={`Rename ${unit.name}`}
                  onClick={() => { setEditingUnitId(unit.id); setUnitName(unit.name); }}
                >
                  <Pencil className="h-4 w-4" />
                </IconButton>
                <IconButton size="sm" variant="danger" label={`Delete ${unit.name}`} onClick={() => deleteUnit(unit)}>
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </li>
            ))}
          </ul>
          <form onSubmit={saveUnit} className="mt-2 flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Field label={editingUnitId === null ? "New unit" : "Rename unit"}>
                <Input
                  value={unitName}
                  onChange={(e) => setUnitName(e.target.value)}
                  maxLength={40}
                  placeholder="drinks, chores, points…"
                  aria-label={editingUnitId === null ? "New unit name" : "Unit name"}
                />
              </Field>
            </div>
            <Button type="submit" busy={unitBusy} disabled={!unitName.trim()}>
              {editingUnitId === null ? <><Plus className="h-4 w-4" /> Add</> : "Save"}
            </Button>
            {editingUnitId !== null && (
              <Button type="button" variant="ghost" onClick={() => { setEditingUnitId(null); setUnitName(""); }}>
                Cancel
              </Button>
            )}
          </form>
          <label className="mt-3 flex items-start gap-2 rounded-lg border border-line p-3 text-body">
            <input
              type="checkbox"
              checked={reconcile}
              disabled={reconcileBusy}
              onChange={(e) => void toggleReconcile(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
            />
            <span>
              <span className="block font-medium">Simplify unit balances</span>
              <span className="block text-meta text-ink-faint">
                On, unit debts cancel and simplify like money. Off, each person keeps their direct debt to whoever paid.
              </span>
            </span>
          </label>
        </div>

        <div>
          <SectionLabel className="mb-1.5">Members · {members.length}</SectionLabel>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {members.map((m) => {
              const self = m.id === meId;
              const memberIsCreator = m.id === group.createdBy;
              const canRemove = self ? !isCreator : isCreator;
              return (
                <li key={m.id} className="flex min-h-[var(--row-h)] items-center gap-2.5 px-3 py-1">
                  <Avatar name={m.displayName} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium">
                      {m.displayName}
                      {self && <span className="text-ink-faint"> (you)</span>}
                      {memberIsCreator && <span className="text-ink-faint"> · creator</span>}
                    </span>
                    <span className="block truncate text-meta text-ink-faint">@{m.username}</span>
                  </span>
                  {canRemove && (
                    <IconButton
                      variant="danger"
                      onClick={() => removeMember(m.id, m.displayName)}
                      label={self ? "Leave group" : `Remove ${m.displayName}`}
                    >
                      {self ? <LogOut className="h-4 w-4" /> : <UserMinus className="h-4 w-4" />}
                    </IconButton>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-meta text-ink-faint">
            Members must be settled up (net zero) before they can be removed or leave.
          </p>
        </div>

        <ErrorNote message={actionError} />

        <div className="border-t border-line pt-4">
          {isCreator ? (
            <Button variant="danger" className="w-full" onClick={deleteGroup}>
              <Trash2 className="h-4 w-4" /> Delete group
            </Button>
          ) : (
            <Button variant="danger" className="w-full" onClick={() => removeMember(meId, "you")}>
              <LogOut className="h-4 w-4" /> Leave group
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
