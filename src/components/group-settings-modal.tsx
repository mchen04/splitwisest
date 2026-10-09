"use client";

import { useEffect, useState } from "react";
import { LogOut, Trash2, UserMinus } from "lucide-react";
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
}: {
  open: boolean;
  onClose: () => void;
  group: { id: number; name: string; createdBy: number };
  members: (Member & { username: string })[];
  meId: number;
  onChanged: () => void;
  onGone: () => void;
}) {
  const [name, setName] = useState(group.name);
  const { error, setError, busy, run } = useFormState();
  const [actionError, setActionError] = useState<string | null>(null);
  const isCreator = group.createdBy === meId;

  useEffect(() => {
    if (!open) return;
    // Seed the settings form from the selected group when the modal opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(group.name);
    setError(null);
    setActionError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, group.id]);

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
