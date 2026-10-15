"use client";

import { useState } from "react";
import { useApiData, useMe } from "@/lib/client";
import type { GroupDetail } from "@/app/groups/[id]/use-group-page-data";
import { ExpenseForm } from "./expense-form";
import { Button, Modal, toast } from "./ui";

export interface QuickAddGroup {
  id: number;
  name: string;
  currency: string;
  memberCount: number;
}

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
      <Modal open={step === "pick"} onClose={onClose} title="Add expense" wide>
        {groupsError && groups === null ? (
          <div role="alert" className="space-y-3 rounded-xl bg-danger-soft p-3 text-body text-danger">
            <p>{groupsError}</p>
            <Button type="button" variant="secondary" onClick={onRetryGroups}>Try again</Button>
          </div>
        ) : (
          <p role="status" className="py-5 text-center text-body text-ink-faint">Loading your groups…</p>
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
