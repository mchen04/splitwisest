"use client";

import { useCallback } from "react";
import Link from "next/link";
import { ArrowRight, Users, ScrollText, Bell, HandCoins } from "lucide-react";
import { fmtMoney, fmtTime, useApiData, useMe, useSync, useUnread } from "@/lib/client";
import { ActivitySummary } from "@/components/activity-summary";
import { AppShell } from "@/components/shell";
import { Card, CardHeader, Money, EmptyState, Button, Avatar } from "@/components/ui";
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

export default function Dashboard() {
  const me = useMe();
  const unread = useUnread();
  const { data: groupsData, reload: reloadGroups } = useApiData<{ groups: Group[] }>("/api/groups", 0, { sync: false });
  const { data: friendsData, reload: reloadFriends } = useApiData<{ friends: Friend[] }>("/api/friends", 0, { sync: false });
  const { data: activityData, reload: reloadActivity } = useApiData<{ activity: Activity[] }>("/api/activity", 0, { sync: false });
  const groups = groupsData?.groups ?? null;
  const friends = friendsData?.friends ?? null;
  const activity = activityData?.activity ?? null;

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

  // Net position per currency, plus the single most useful next step ("coach").
  const netByCur: Record<string, number> = {};
  let owedTotal = 0;
  let oweTotal = 0;
  const obligationCurrencies = new Set<string>();
  let topCreditor: { f: Friend; cur: string; amt: number } | null = null; // they owe me
  let topDebt: { f: Friend; cur: string; amt: number } | null = null; // I owe them
  for (const f of friends ?? []) {
    for (const [cur, amt] of Object.entries(f.netByCurrency)) {
      netByCur[cur] = (netByCur[cur] ?? 0) + amt;
    }
    for (const obligation of f.obligations) {
      obligationCurrencies.add(obligation.currency);
      if (obligation.netCents > 0) {
        owedTotal += obligation.netCents;
        if (!topCreditor || obligation.netCents > topCreditor.amt) {
          topCreditor = { f, cur: obligation.currency, amt: obligation.netCents };
        }
      } else {
        oweTotal -= obligation.netCents;
        if (!topDebt || obligation.netCents < topDebt.amt) {
          topDebt = { f, cur: obligation.currency, amt: obligation.netCents };
        }
      }
    }
  }
  const currencies = Object.entries(netByCur).filter(([, v]) => v !== 0);
  const singleCur = obligationCurrencies.size === 1 ? [...obligationCurrencies][0] : null;
  const activityPeek = (activity ?? []).filter((a) => !/joined the group|are now friends|created the group|joined SplitWisest/i.test(a.summary));

  return (
    <AppShell title="Home">
      {/* Hero: one net number + the single most useful next step. */}
      <Card className="mb-4 p-4 md:shrink-0">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-3">
              <h1 className="text-sm font-medium text-ink-soft">{currencies.length > 1 ? "Your balances" : "Your balance"}</h1>
              {/* The mobile shell has no top bar, so the hero carries the account entry point. */}
              {me && (
                <div className="flex items-center gap-1 md:hidden">
                <Link href="/notifications" aria-label={`Notifications${unread.notifications ? `, ${unread.notifications} unread` : ""}`}
                  className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-accent hover:bg-accent-soft">
                  <Bell className="h-5 w-5" />
                  {unread.notifications > 0 && <span className="absolute right-0 top-0 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-xs font-semibold text-on-accent">{unread.notifications > 9 ? "9+" : unread.notifications}</span>}
                </Link>
                <Link href="/settings" aria-label="Account settings" className="-my-2 -mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full md:hidden">
                  <Avatar name={me.displayName} size="sm" />
                </Link>
                </div>
              )}
            </div>
            {friends === null ? (
              // Reserve the loaded hero's typical footprint (balance line +
              // direction line); a thin bar here shifted the whole grid down
              // when data arrived (measured CLS 0.25 → the page's whole score).
              <div className="mt-2 space-y-2">
                <div className="skeleton h-9 w-44" />
                <div className="skeleton h-4 w-56" />
              </div>
            ) : currencies.length === 0 && !(friends ?? []).some((f) => f.obligations.length > 0) ? (
              <p className="mt-1 text-2xl font-semibold tracking-tight text-ink">You&rsquo;re all settled up</p>
            ) : (
              <>
                {currencies.length === 0 && (
                  <p className="mt-1 text-2xl font-semibold tracking-tight text-ink">Your balances offset overall</p>
                )}
                {/* Each currency nets separately (never summed across currencies),
                    and each carries an explicit owed/owe word so direction never
                    relies on color alone. */}
                <div className={`mt-1 ${currencies.length > 1 ? "grid grid-cols-2 gap-x-5 gap-y-3" : "flex"}`}>
                  {currencies.map(([cur, amt]) => (
                    <div key={cur} className="min-w-0">
                      <p className={`${currencies.length > 1 ? "text-2xl sm:text-3xl" : "text-4xl"} font-semibold tracking-tight tnum ${amt > 0 ? "text-owed" : "text-owe"}`}>
                        <Money cents={amt} currency={cur} signed />
                      </p>
                      <p className={`mt-0.5 text-xs font-medium ${amt > 0 ? "text-owed" : "text-owe"}`}>
                        {amt > 0 ? "owed to you" : "you owe"}{currencies.length > 1 ? ` · ${cur}` : ""}
                      </p>
                    </div>
                  ))}
                </div>
                {singleCur && owedTotal > 0 && oweTotal > 0 && (
                  <p className="mt-1.5 text-sm text-ink-faint">
                    <span className="text-owed">{fmtMoney(owedTotal, singleCur)} owed to you</span>
                    {" · "}
                    <span className="text-owe">{fmtMoney(oweTotal, singleCur)} you owe</span>
                  </p>
                )}
              </>
            )}
          </div>

          {/* One contextual next step. Adding an expense is always a tap away in the
              bottom nav, so the hero only surfaces a settle or remind action. When the
              friend's balance spans multiple currencies, drop the single amount so
              the CTA doesn't imply one payment clears a mixed-currency relationship. */}
          {friends === null && (
            // Placeholder for the settle/remind action so the button's arrival
            // does not push the content below it.
            <div className="flex shrink-0 sm:justify-end">
              <div className="skeleton h-11 w-full rounded-lg sm:w-48" />
            </div>
          )}
          {(topDebt || topCreditor) && (
          <div className="flex shrink-0 sm:justify-end">
            {topDebt ? (
              <Link href={`/people/${topDebt.f.id}`} className="w-full sm:w-auto">
                <Button variant="secondary" className="w-full sm:w-auto">
                  <HandCoins className="h-4 w-4" /> Settle up with {topDebt.f.displayName.split(" ")[0]}
                  {Object.values(topDebt.f.netByCurrency).filter((v) => v !== 0).length === 1 && <> · <Money cents={-topDebt.amt} currency={topDebt.cur} /></>}
                </Button>
              </Link>
            ) : topCreditor ? (
              <Link href={`/people/${topCreditor.f.id}`} className="w-full sm:w-auto">
                <Button variant="secondary" className="w-full sm:w-auto">
                  <Bell className="h-4 w-4" /> Remind {topCreditor.f.displayName.split(" ")[0]}
                  {Object.values(topCreditor.f.netByCurrency).filter((v) => v !== 0).length === 1 && <> · <Money cents={topCreditor.amt} currency={topCreditor.cur} /></>}
                </Button>
              </Link>
            ) : null}
          </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 md:items-start">
        <Card className="flex flex-col md:min-h-0">
          <CardHeader
            title="Your groups"
            action={
              <Link href="/groups" className="flex items-center gap-1 text-sm font-medium text-accent hover:underline">
                Manage <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            }
          />
          <div className="md:min-h-0 md:flex-1 md:overflow-y-auto">
            {groups === null ? (
              <SkeletonRows n={3} />
            ) : groups.length === 0 ? (
              <EmptyState
                icon={<Users className="h-7 w-7" />}
                title="No groups yet"
                hint="Create a group for a trip, an apartment, or a dinner crew."
                action={
                  <Link href="/groups">
                    <Button variant="secondary">Create a group</Button>
                  </Link>
                }
              />
            ) : (
              <ul className="divide-y divide-line">
                {groups.map((g) => (
                  <li key={g.id}>
                    <Link href={`/groups/${g.id}`} className={`group-hue-${g.id % 6} flex min-h-[var(--row-h)] items-center gap-3 px-4 py-2.5 hover:bg-subtle`}>
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--group-soft)] text-[var(--group-ink)]">
                        <Users className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium" title={g.name}>{g.name}</span>
                        <span className="block text-xs text-ink-faint">
                          {g.memberCount} {g.memberCount === 1 ? "member" : "members"} · {g.expenseCount}{" "}
                          {g.expenseCount === 1 ? "expense" : "expenses"}
                        </span>
                      </span>
                      <span className="text-right text-sm font-medium">
                        {g.myNetCents === 0 ? (
                          <span className="text-ink-faint">settled</span>
                        ) : (
                          // Word + color + amount so the per-group direction isn't
                          // carried by color alone (matches the Friends list).
                          <span className={g.myNetCents > 0 ? "text-owed" : "text-owe"}>
                            <span className="mr-1 text-xs font-normal opacity-90">{g.myNetCents > 0 ? "owed" : "you owe"}</span>
                            <span className="tnum">{fmtMoney(Math.abs(g.myNetCents), g.currency)}</span>
                          </span>
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card className="flex flex-col md:min-h-0">
          <CardHeader
            title="Friends"
            action={
              <Link href="/balances" className="flex items-center gap-1 text-sm font-medium text-accent hover:underline">
                View all <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            }
          />
          <div className="md:min-h-0 md:flex-1 md:overflow-y-auto">
            {friends === null ? (
              <SkeletonRows n={3} />
            ) : friends.length === 0 ? (
              <EmptyState
                icon={<Users className="h-7 w-7" />}
                title="No friends yet"
                hint="Add friends from the Balances page to start splitting."
              />
            ) : (
              <ul className="divide-y divide-line">
                {friends.map((f) => {
                  const obligations = f.obligations;
                  return (
                    <li key={f.id}>
                      <Link href={`/people/${f.id}`} className="flex min-h-[var(--row-h)] items-center gap-3 px-4 py-2.5 hover:bg-subtle">
                        <Avatar name={f.displayName} size="sm" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={f.displayName}>{f.displayName}</span>
                        <span className="text-right text-sm font-medium">
                          {obligations.length === 0 ? (
                            <span className="text-ink-faint">settled</span>
                          ) : (
                            obligations.map((item, index) => (
                              <span key={`${item.groupId ?? "direct"}:${item.currency}:${index}`} className={`block ${item.netCents > 0 ? "text-owed" : "text-owe"}`}>
                                <span className="text-xs font-normal opacity-90">{item.groupName ?? "Direct"} · {item.netCents > 0 ? "owes you " : "you owe "}</span>
                                <span className="tnum">{fmtMoney(Math.abs(item.netCents), item.currency)}</span>
                              </span>
                            ))
                          )}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Card>

        <Card className="flex flex-col md:min-h-0">
          <CardHeader
            title="Recent activity"
            action={
              <Link href="/activity" className="flex items-center gap-1 text-sm font-medium text-accent hover:underline">
                View all <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            }
          />
          <div className="md:min-h-0 md:flex-1 md:overflow-y-auto">
            {activity === null ? (
              <SkeletonRows n={4} />
            ) : activityPeek.length === 0 ? (
              <EmptyState
                icon={<ScrollText className="h-7 w-7" />}
                title="Nothing yet"
                hint="Expenses and settlements will show up here."
              />
            ) : (
              <ul className="divide-y divide-line">
                {activityPeek.slice(0, 7).map((a) => (
                  <li key={a.id} className="px-4 py-2.5">
                    <ActivitySummary activity={a} />
                    <p className="mt-0.5 text-xs text-ink-faint">
                      {a.groupName ? `${a.groupName} · ` : ""}
                      {fmtTime(a.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </AppShell>
  );
}

function SkeletonRows({ n }: { n: number }) {
  return (
    <div className="space-y-3 px-4 py-4">
      {[...Array(n)].map((_, i) => (
        <div key={i} className="skeleton h-10 w-full" />
      ))}
    </div>
  );
}
