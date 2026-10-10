"use client";

import { useState } from "react";
import { Users } from "lucide-react";
import { useApiData, useMe } from "@/lib/client";
import type { GroupDetail } from "@/app/groups/[id]/use-group-page-data";
import { ExpenseForm } from "./expense-form";
import { Button, Modal, RowMeta, RowTitle, toast } from "./ui";

export interface QuickAddGroup {
  id: number;
  name: string;
  currency: string;
  memberCount: number;
}

/**
 * Add expense from any page that is not a group. The form opens in place for
 * the remembered (or only) group, with the group switchable inside the form;
 * the user never leaves the page they were on. Without a known group, a one-tap
 * picker comes first.
 */
export function QuickAddExpense({
  step,
  groupId,
  groups,
  groupsError,
  onRetryGroups,
  onPick,
  onClose,
}: {
  step: "closed" | "pick" | "form";
  groupId: number | null;
  groups: QuickAddGroup[] | null;
  groupsError: string | null;
  onRetryGroups: () => void;
  onPick: (groupId: number) => void;
  onClose: () => void;
}) {
  const me = useMe();
  const formOpen = step === "form" && groupId !== null;
  const { data: detail, error: detailError, reload } = useApiData<GroupDetail>(
    `/api/groups/${groupId ?? 0}`, 0, { sync: false, enabled: formOpen });
  // Switching groups inside the form keeps the form (and what was typed) on
  // screen with the previous members until the new group's members arrive.
  // If they never arrive, the form says so and offers Try again or going back;
  // Save stays off, so nothing is written to either group by mistake.
  const [shown, setShown] = useState<GroupDetail | null>(null);
  if (formOpen && detail && detail.group.id === groupId && shown !== detail) setShown(detail);
  if (!formOpen && shown !== null) setShown(null);
  const switching = !detail || detail.group.id !== groupId;
  const ready = formOpen && shown && me;

  return (
    <>
      <Modal open={step === "pick"} onClose={onClose} title="Add expense to">
        {groups === null ? (
          groupsError ? (
            <div role="alert" className="space-y-3 rounded-xl bg-danger-soft p-3 text-body text-danger">
              <p>{groupsError}</p>
              <Button type="button" variant="secondary" onClick={onRetryGroups}>Try again</Button>
            </div>
          ) : (
            <p role="status" className="py-5 text-center text-body text-ink-faint">Loading your groups…</p>
          )
        ) : (
          <div className="space-y-1.5">
            {groups.map((group) => (
              <button
                key={group.id}
                type="button"
                onClick={() => onPick(group.id)}
                className={`group-choice group-hue-${group.id % 6} flex min-h-[var(--row-h)] w-full items-center gap-3 rounded-xl border border-line px-3 py-2 text-left hover:bg-subtle`}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--group-soft)] text-[var(--group-ink)]">
                  <Users className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <RowTitle>{group.name}</RowTitle>
                  <RowMeta>{group.memberCount} {group.memberCount === 1 ? "member" : "members"} · {group.currency}</RowMeta>
                </span>
              </button>
            ))}
          </div>
        )}
      </Modal>

      {formOpen && !ready && (
        <Modal open onClose={onClose} title="Add expense" wide>
          {detailError ? (
            <div role="alert" className="space-y-3 rounded-xl bg-danger-soft p-3 text-body text-danger">
              <p>{detailError}</p>
              <Button type="button" variant="secondary" onClick={reload}>Try again</Button>
            </div>
          ) : (
            <div role="status" className="space-y-3">
              <span className="sr-only">Loading the group…</span>
              {[...Array(4)].map((_, i) => <div key={i} className="skeleton h-11 w-full" />)}
            </div>
          )}
        </Modal>
      )}

      {ready && (
        <ExpenseForm
          groupId={shown.group.id}
          groupName={shown.group.name}
          groupCurrency={shown.group.currency}
          members={shown.members}
          meId={me.id}
          existing={null}
          open
          onClose={onClose}
          onSaved={() => window.dispatchEvent(new CustomEvent("splitwisest:expense-saved", { detail: { groupId: shown.group.id } }))}
          onCreated={({ title }) => toast(`Added “${title}” to ${shown.group.name}`, {
            action: { label: "View", href: `/groups/${shown.group.id}` },
          })}
          groupOptions={groups ?? undefined}
          selectedGroupId={groupId ?? shown.group.id}
          groupSwitching={switching}
          groupSwitchError={switching ? detailError : null}
          onRetryGroupSwitch={reload}
          onGroupChange={onPick}
        />
      )}
    </>
  );
}
