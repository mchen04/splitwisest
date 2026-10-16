"use client";

import { ReactNode, useState } from "react";
import Link from "next/link";
import { Bell, Check, HandCoins } from "lucide-react";
import { api, ApiClientError, fmtMoney } from "@/lib/client";
import type { FriendObligation } from "@/lib/balances";
import { obligationKey } from "./direct-settle-modal";
import { Avatar, Button, RowMeta, RowTitle, toast } from "./ui";

export interface FriendWithBalances {
  id: number;
  displayName: string;
  username?: string;
  obligations: FriendObligation[];
  netByCurrency: Record<string, number>;
}

/** Friends you owe come first (the action is yours), then by largest balance. */
export function sortByUrgency<T extends FriendWithBalances>(friends: T[]): T[] {
  const weight = (f: T) => ({
    owes: f.obligations.some((o) => o.netCents < 0) ? 1 : 0,
    size: Math.max(0, ...f.obligations.map((o) => Math.abs(o.netCents))),
  });
  return [...friends].sort((a, b) => weight(b).owes - weight(a).owes || weight(b).size - weight(a).size);
}

/** Sends a settle-up reminder and confirms it; returns a per-friend "sent" flag. */
export function useRemind() {
  const [sent, setSent] = useState<number | null>(null);
  async function remind(friend: { id: number; displayName: string }) {
    try {
      await api("/api/nudges", { body: { toId: friend.id } });
      setSent(friend.id);
      toast(`Reminder sent to ${friend.displayName.split(" ")[0]}`);
      window.setTimeout(() => setSent((current) => (current === friend.id ? null : current)), 2500);
    } catch (err) {
      toast(err instanceof ApiClientError ? err.message : "Could not send the reminder", { tone: "error" });
    }
  }
  return { remind, sentTo: sent };
}

function ObligationText({ obligation, amount, stacked = false }: { obligation: FriendObligation; amount: string; stacked?: boolean }) {
  const owe = obligation.netCents < 0;
  const direction = (
    <span className={`whitespace-nowrap ${owe ? "text-owe" : "text-owed"}`}>
      {owe ? "you owe " : "owes you "}
      <span className="tnum font-semibold">{amount}</span>
    </span>
  );
  if (stacked) {
    return (
      <span className="block min-w-0 text-body">
        <span className="block truncate text-meta text-ink-faint">{obligation.groupName ?? "Direct"}</span>
        {direction}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-baseline gap-1 text-body">
      <span className="min-w-0 truncate text-ink-faint">{obligation.groupName ?? "Direct"}</span>
      <span className="shrink-0 text-ink-faint">·</span>
      {direction}
    </span>
  );
}

export function FriendBalanceRow({
  friend,
  onSettle,
  onRemind,
  reminded,
  menu,
  showUsername = false,
}: {
  friend: FriendWithBalances;
  onSettle: (friend: FriendWithBalances, key: string) => void;
  onRemind: (friend: FriendWithBalances) => void;
  reminded: boolean;
  menu?: ReactNode;
  showUsername?: boolean;
}) {
  const open = friend.obligations.filter((o) => o.netCents !== 0);
  const theyOweMe = open.some((o) => o.netCents > 0);
  const single = open.length === 1 ? open[0] : null;
  const settleButton = (o: FriendObligation) => {
    const amount = fmtMoney(Math.abs(o.netCents), o.currency);
    return (
      <Button
        size="sm"
        variant="secondary"
        onClick={() => onSettle(friend, obligationKey(o))}
        aria-label={`Settle up ${amount} with ${friend.displayName}${o.groupName ? ` in ${o.groupName}` : ""}`}
      >
        <HandCoins className="h-4 w-4" /> Settle up
      </Button>
    );
  };
  return (
    <li className="px-4 py-1.5">
      <div className="flex min-h-[var(--control-h)] items-center gap-3">
        <Link href={`/people/${friend.id}`} className="flex min-h-[var(--control-h-sm)] min-w-0 flex-1 items-center gap-3 rounded-lg hover:text-accent-dark" aria-label={`Open ${friend.displayName}'s profile`}>
          <Avatar name={friend.displayName} />
          <span className="min-w-0">
            <RowTitle title={friend.displayName}>{friend.displayName}</RowTitle>
            {showUsername && friend.username && <RowMeta>@{friend.username}</RowMeta>}
            {open.length === 0 && !showUsername && <RowMeta>Settled up</RowMeta>}
          </span>
        </Link>
        {open.length === 0 && showUsername && <span className="shrink-0 text-body text-ink-faint">Settled up</span>}
        {single && single.netCents < 0 && settleButton(single)}
        {theyOweMe && (
          <Button size="sm" variant="secondary" onClick={() => onRemind(friend)} aria-label={`Remind ${friend.displayName} to settle up`}>
            {reminded ? <><Check className="h-4 w-4 text-owed" /> Reminded</> : <><Bell className="h-4 w-4" /> Remind</>}
          </Button>
        )}
        {menu}
      </div>
      {open.length > 0 && (
        <ul className="pl-11">
          {open.map((o) => {
            const ownButton = !single && o.netCents < 0;
            return (
              <li key={obligationKey(o)} className={`flex items-center gap-2 ${ownButton ? "min-h-[var(--control-h-sm)]" : "py-0.5"}`}>
                <span className="min-w-0 flex-1">
                  <ObligationText obligation={o} amount={fmtMoney(Math.abs(o.netCents), o.currency)} stacked={ownButton} />
                </span>
                {ownButton && settleButton(o)}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
