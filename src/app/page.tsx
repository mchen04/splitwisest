"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Users, ScrollText, Bell, Search, Scale } from "lucide-react";
import { fmtMoney, fmtTime, useApiData, useMe, useSync, useUnread } from "@/lib/client";
import { ActivitySummary } from "@/components/activity-summary";
import { AppShell } from "@/components/shell";
import { Card, CardHeader, Money, EmptyState, Avatar, HeaderLink, RowMeta, RowTitle } from "@/components/ui";
import { DirectSettleModal } from "@/components/direct-settle-modal";
import { FriendBalanceRow, sortByUrgency, useRemind, type FriendWithBalances } from "@/components/friend-balances";
import { GroupNet } from "@/components/group-net";
import type { FriendObligation } from "@/lib/balances";

interface Group {
  id: number;
  name: string;
  currency: string;
  memberCount: number;
  expenseCount: number;
  myNetCents: number;
}

interface Friend {
  id: number;
  displayName: string;
  username: string;
  obligations: FriendObligation[];
  netByCurrency: Record<string, number>;
}

interface Activity {
  id: number;
  groupId: number | null;
  groupName: string | null;
  actorId: number;
  actorName: string;
  actionText: string;
  summary: string;
  createdAt: string;
}

const SETTLE_PREVIEW = 6;

export default function Dashboard() {
  const me = useMe();
  const unread = useUnread();
  const { data: groupsData, reload: reloadGroups } = useApiData<{ groups: Group[] }>("/api/groups", 0, { sync: false });
  const { data: friendsData, reload: reloadFriends } = useApiData<{ friends: Friend[] }>("/api/friends", 0, { sync: false });
  const { data: activityData, reload: reloadActivity } = useApiData<{ activity: Activity[] }>("/api/activity", 0, { sync: false });
  const groups = groupsData?.groups ?? null;
  const friends = friendsData?.friends ?? null;
  const activity = activityData?.activity ?? null;
  const [settle, setSettle] = useState<{ friend: FriendWithBalances; key: string } | null>(null);
  const { remind, sentTo } = useRemind();

  const load = useCallback(() => {
    reloadGroups();
    reloadFriends();
    reloadActivity();
  }, [reloadGroups, reloadFriends, reloadActivity]);
  useSync((c, prev) => {
    if (
      c.activityCursor !== prev.activityCursor ||
      c.nudgeCursor !== prev.nudgeCursor ||
      c.requestCursor !== prev.requestCursor
    ) {
      load();
    }
  });
  // An expense added from this page (in place) refreshes the summary at once.
  useEffect(() => {
    window.addEventListener("splitwisest:expense-saved", load);
    return () => window.removeEventListener("splitwisest:expense-saved", load);
  }, [load]);

  // Net position per currency. Currencies never sum together.
  const netByCur: Record<string, number> = {};
  let owedTotal = 0;
  let oweTotal = 0;
  const obligationCurrencies = new Set<string>();
  for (const f of friends ?? []) {
    for (const [cur, amt] of Object.entries(f.netByCurrency)) {
      netByCur[cur] = (netByCur[cur] ?? 0) + amt;
    }
    for (const obligation of f.obligations) {
      obligationCurrencies.add(obligation.currency);
      if (obligation.netCents > 0) owedTotal += obligation.netCents;
      else oweTotal -= obligation.netCents;
    }
  }
  const currencies = Object.entries(netByCur).filter(([, v]) => v !== 0);
  const singleCur = obligationCurrencies.size === 1 ? [...obligationCurrencies][0] : null;
  const withBalances = sortByUrgency((friends ?? []).filter((f) => f.obligations.some((o) => o.netCents !== 0)));
  const activityPeek = (activity ?? []).filter((a) => !/joined the group|are now friends|created the group|joined SplitWisest/i.test(a.summary));

  return (
    <AppShell title="Home">
      {/* Hero: the answer to "where do I stand?" in one number per currency. */}
      <Card className="mb-3 px-4 pb-4 pt-3 md:shrink-0">
        <div className="flex min-h-11 items-center justify-between gap-3">
          <h1 className="text-body font-medium text-ink-soft">{currencies.length > 1 ? "Your balances" : "Your balance"}</h1>
          {/* The mobile shell has no top bar, so the hero carries search, the inbox, and the account entry point. */}
          {me && (
            <div className="-mr-2 flex items-center md:hidden">
              <Link href="/expenses" aria-label="Search expenses"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-subtle">
                <Search className="h-5 w-5" />
              </Link>
              <Link href="/notifications" aria-label={`Notifications${unread.notifications ? `, ${unread.notifications} unread` : ""}`}
                className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-subtle">
                <Bell className="h-5 w-5" />
                {unread.notifications > 0 && <span className="absolute right-0.5 top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-meta font-semibold text-on-accent">{unread.notifications > 9 ? "9+" : unread.notifications}</span>}
              </Link>
              <Link href="/settings" aria-label="Account settings" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full md:hidden">
                <Avatar name={me.displayName} size="sm" />
              </Link>
            </div>
          )}
        </div>
        {friends === null ? (
          // Reserve the loaded hero's footprint so data arriving does not shift the page.
          <div className="mt-1 space-y-2">
            <div className="skeleton h-10 w-44" />
            <div className="skeleton h-4 w-56" />
          </div>
        ) : currencies.length === 0 && withBalances.length === 0 ? (
          <p className="text-amount font-semibold tracking-tight text-ink">You&rsquo;re all settled up</p>
        ) : (
          <>
            {currencies.length === 0 && (
              <p className="text-amount font-semibold tracking-tight text-ink">Your balances offset overall</p>
            )}
            {/* Each currency nets separately, and each carries an explicit
                owed/owe word so direction never relies on color alone. */}
            <div className={currencies.length > 1 ? "grid grid-cols-2 gap-x-5 gap-y-2 sm:flex sm:flex-wrap sm:gap-x-8" : "flex"}>
              {currencies.map(([cur, amt]) => (
                <div key={cur} className="min-w-0">
                  <p className={`${currencies.length > 1 ? "text-amount sm:text-amount-lg" : "text-hero"} font-semibold tracking-tight tnum ${amt > 0 ? "text-owed" : "text-owe"}`}>
                    <Money cents={amt} currency={cur} signed />
                  </p>
                  <p className={`text-meta font-medium ${amt > 0 ? "text-owed" : "text-owe"}`}>
                    {amt > 0 ? "owed to you" : "you owe"}{currencies.length > 1 ? ` · ${cur}` : ""}
                  </p>
                </div>
              ))}
            </div>
            {singleCur && owedTotal > 0 && oweTotal > 0 && (
              <p className="mt-1.5 text-body text-ink-faint">
                <span className="text-owed">{fmtMoney(owedTotal, singleCur)} owed to you</span>
                {" · "}
                <span className="text-owe">{fmtMoney(oweTotal, singleCur)} you owe</span>
              </p>
            )}
          </>
        )}
      </Card>

      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        {/* What to do next: every open balance, with its action right on the row. */}
        <Card>
          <CardHeader
            title="Settle up"
            meta={withBalances.length > 0 ? `${withBalances.length} ${withBalances.length === 1 ? "friend" : "friends"}` : undefined}
            action={<HeaderLink href="/balances">All balances</HeaderLink>}
          />
          {friends === null ? (
            <SkeletonRows n={3} />
          ) : friends.length === 0 ? (
            <EmptyState
              icon={<Users className="h-6 w-6" />}
              title="No friends yet"
              hint="Invite friends from Balances, or join a group to start splitting."
            />
          ) : withBalances.length === 0 ? (
            <p className="flex items-center gap-2 px-4 py-3 text-body text-ink-faint"><Scale className="h-4 w-4" /> Nobody owes anything right now.</p>
          ) : (
            <>
              <ul className="divide-y divide-line">
                {withBalances.slice(0, SETTLE_PREVIEW).map((f) => (
                  <FriendBalanceRow
                    key={f.id}
                    friend={f}
                    onSettle={(friend, key) => setSettle({ friend, key })}
                    onRemind={remind}
                    reminded={sentTo === f.id}
                  />
                ))}
              </ul>
              {withBalances.length > SETTLE_PREVIEW && (
                <Link href="/balances" className="flex min-h-[var(--control-h)] items-center justify-center border-t border-line text-body font-medium text-accent hover:bg-subtle">
                  {withBalances.length - SETTLE_PREVIEW} more on Balances
                </Link>
              )}
            </>
          )}
        </Card>

        <div className="grid grid-cols-1 gap-3">
          <Card>
            <CardHeader title="Your groups" action={<HeaderLink href="/groups">All groups</HeaderLink>} />
            {groups === null ? (
              <SkeletonRows n={3} />
            ) : groups.length === 0 ? (
              <EmptyState
                icon={<Users className="h-6 w-6" />}
                title="No groups yet"
                hint="Create a group for a trip, an apartment, or a dinner crew."
                action={<Link href="/groups" className="inline-flex min-h-[var(--control-h)] items-center rounded-lg border border-line px-3.5 text-body font-semibold hover:bg-subtle">Create a group</Link>}
              />
            ) : (
              <ul className="divide-y divide-line">
                {groups.map((g) => (
                  <li key={g.id}>
                    <Link href={`/groups/${g.id}`} className={`group-hue-${g.id % 6} flex min-h-[var(--row-h)] items-center gap-3 px-4 py-2 hover:bg-subtle`}>
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--group-soft)] text-[var(--group-ink)]">
                        <Users className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <RowTitle title={g.name}>{g.name}</RowTitle>
                        <RowMeta>
                          {g.memberCount} {g.memberCount === 1 ? "member" : "members"} · {g.expenseCount} {g.expenseCount === 1 ? "expense" : "expenses"}
                        </RowMeta>
                      </span>
                      <GroupNet cents={g.myNetCents} currency={g.currency} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Recent activity" action={<HeaderLink href="/activity">View all</HeaderLink>} />
            {activity === null ? (
              <SkeletonRows n={4} />
            ) : activityPeek.length === 0 ? (
              <EmptyState
                icon={<ScrollText className="h-6 w-6" />}
                title="Nothing yet"
                hint="Expenses and payments will show up here."
              />
            ) : (
              <ul className="divide-y divide-line">
                {activityPeek.slice(0, 5).map((a) => (
                  <li key={a.id} className="px-4 py-2">
                    <ActivitySummary activity={a} />
                    <RowMeta>
                      {a.groupName ? `${a.groupName} · ` : ""}
                      {fmtTime(a.createdAt)}
                    </RowMeta>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <DirectSettleModal
        friend={settle?.friend ?? null}
        initialKey={settle?.key}
        preferredSign={-1}
        onClose={() => setSettle(null)}
        onSaved={load}
      />
    </AppShell>
  );
}

function SkeletonRows({ n }: { n: number }) {
  return (
    <div className="space-y-2 px-4 py-3">
      {[...Array(n)].map((_, i) => (
        <div key={i} className="skeleton h-10 w-full" />
      ))}
    </div>
  );
}
