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

/**
 * One friend and every open balance with them. Each balance you owe carries
 * its own Settle up, which opens the payment for exactly that balance; a friend
 * who owes you gets one Remind. Settled friends collapse to a single line.
 */
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
  return (
    <li className="px-4 py-2">
      <div className="flex min-h-[var(--control-h-sm)] items-center gap-3">
        <Link href={`/people/${friend.id}`} className="flex min-h-[var(--control-h-sm)] min-w-0 flex-1 items-center gap-3 rounded-lg hover:text-accent-dark" aria-label={`Open ${friend.displayName}'s profile`}>
          <Avatar name={friend.displayName} />
          <span className="min-w-0">
            <RowTitle title={friend.displayName}>{friend.displayName}</RowTitle>
            {showUsername && friend.username && <RowMeta>@{friend.username}</RowMeta>}
            {open.length === 0 && !showUsername && <RowMeta>Settled up</RowMeta>}
          </span>
        </Link>
        {open.length === 0 && showUsername && <span className="shrink-0 text-body text-ink-faint">Settled up</span>}
        {theyOweMe && (
          <Button size="sm" variant="secondary" onClick={() => onRemind(friend)} aria-label={`Remind ${friend.displayName} to settle up`}>
            {reminded ? <><Check className="h-4 w-4 text-owed" /> Reminded</> : <><Bell className="h-4 w-4" /> Remind</>}
          </Button>
        )}
        {menu}
      </div>
      {open.length > 0 && (
        <ul className="mt-0.5 space-y-0.5 sm:pl-11">
          {open.map((o) => {
            const owe = o.netCents < 0;
            const amount = fmtMoney(Math.abs(o.netCents), o.currency);
            return (
              <li key={obligationKey(o)} className="flex min-h-[var(--control-h-sm)] items-center gap-2">
                <span className="min-w-0 flex-1 text-body">
                  <span className="text-ink-faint">{o.groupName ?? "Direct"} · </span>
                  <span className={owe ? "text-owe" : "text-owed"}>
                    {owe ? "you owe " : "owes you "}
                    <span className="tnum font-semibold">{amount}</span>
                  </span>
                </span>
                {owe && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onSettle(friend, obligationKey(o))}
                    aria-label={`Settle up ${amount} with ${friend.displayName}${o.groupName ? ` in ${o.groupName}` : ""}`}
                  >
                    <HandCoins className="h-4 w-4" /> Settle up
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
