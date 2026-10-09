"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, Bell, HandCoins, MessageSquare, Receipt, Search, UserMinus, UserPlus, Users, X,
} from "lucide-react";
import { api, ApiClientError, fmtDate, fmtMoney, useApiData, useMe } from "@/lib/client";
import { AppShell } from "@/components/shell";
import { Avatar, Button, Card, CardHeader, EmptyState, IconButton, Input, Menu, MenuItem, RowMeta, RowTitle, confirmAction, toast } from "@/components/ui";
import { DirectPaymentsModal } from "@/components/direct-payments-modal";
import { DirectSettleModal, obligationKey } from "@/components/direct-settle-modal";
import type { PersonProfile } from "@/lib/people";

const relationshipLabel: Record<PersonProfile["relationship"], string> = {
  self: "You",
  friend: "Friend",
  "shared-group": "Shared group member",
  pending: "Pending request",
  none: "Not available",
};

export default function PersonPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = use(params);
  const me = useMe();
  const { data, error: profileError, status: profileStatus, reload } = useApiData<{ profile: PersonProfile }>(`/api/people/${userId}`);
  const [settleSign, setSettleSign] = useState<-1 | 1 | null>(null);
  const [settleKey, setSettleKey] = useState<string | undefined>(undefined);
  const [paymentsOpen, setPaymentsOpen] = useState(false);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");

  const profile = data?.profile ?? null;

  async function sendFriendRequest() {
    if (!profile) return;
    setActionNote(null);
    try {
      await api("/api/friends", { body: { userId: profile.person.id } });
      toast(`Friend request sent to ${profile.person.displayName}`);
      reload();
    } catch {
      setActionNote("Could not send friend request.");
    }
  }

  async function respondRequest(action: "accept" | "decline" | "cancel") {
    if (!profile?.request) return;
    try {
      await api("/api/friends/requests", { body: { requestId: profile.request.id, action } });
      reload();
    } catch (err) {
      setActionNote(err instanceof ApiClientError ? err.message : "Could not update request");
    }
  }

  async function nudge() {
    if (!profile) return;
    try {
      await api("/api/nudges", { body: { toId: profile.person.id, groupId: profile.canChat ? null : profile.sharedGroups[0]?.id ?? null } });
      toast(`Reminder sent to ${profile.person.displayName.split(" ")[0]}`);
    } catch (err) {
      setActionNote(err instanceof ApiClientError ? err.message : "Could not send nudge");
    }
  }

  async function removeFriend() {
    if (!profile || !(await confirmAction({
      title: `Remove ${profile.person.displayName}?`,
      message: "You will need an invite code to reconnect.",
      confirmLabel: "Remove friend",
      danger: true,
    }))) return;
    try {
      await api("/api/friends", { method: "DELETE", body: { friendId: profile.person.id } });
      reload();
    } catch (err) {
      setActionNote(err instanceof ApiClientError ? err.message : "Could not remove friend");
    }
  }

  if (profileStatus === 404) {
    return (
      <AppShell>
        <Card>
          <EmptyState
            title="Profile not available"
            hint="You can only view yourself, friends, pending requests, and people who share a group with you."
            action={<Link href="/balances"><Button variant="secondary"><ArrowLeft className="h-4 w-4" /> Balances</Button></Link>}
          />
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell>
      {profile ? (
        <>
          <div className="mb-3 flex min-h-11 items-center gap-3 md:shrink-0">
            <Avatar name={profile.person.displayName} size="lg" />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-title font-semibold tracking-tight">{profile.person.displayName}</h1>
              <p className="truncate text-meta text-ink-faint">@{profile.person.username} · {relationshipLabel[profile.relationship]}</p>
            </div>
            <ProfileActions profile={profile} onSettle={(sign) => { setSettleKey(undefined); setSettleSign(sign); }} onPayments={() => setPaymentsOpen(true)} onNudge={nudge} onRemove={removeFriend} onRequest={sendFriendRequest} />
          </div>

          {actionNote && <div role="status" className="mb-3 rounded-lg bg-subtle px-3 py-2 text-body text-ink-soft">{actionNote}</div>}

          {profile.request && (
            <Card className="mb-3 px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-3">
                <UserPlus className="h-4 w-4 text-accent" />
                <p className="min-w-0 flex-1 text-body">
                  {profile.request.direction === "incoming"
                    ? `${profile.person.displayName} sent you a friend request.`
                    : `Your friend request is pending.`}
                </p>
                {profile.request.direction === "incoming" ? (
                  <>
                    <Button size="sm" onClick={() => respondRequest("accept")}>Accept</Button>
                    <Button size="sm" variant="secondary" onClick={() => respondRequest("decline")}>Decline</Button>
                  </>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => respondRequest("cancel")}>Cancel</Button>
                )}
              </div>
            </Card>
          )}

          <div className="grid grid-cols-1 gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
            {/* On a phone the balance comes first: it is why most people open a profile. */}
            <aside className="order-first space-y-3 lg:order-none lg:col-start-2 lg:row-start-1">
              <Card>
                <CardHeader title="Balance" />
                {profile.obligations.length === 0 ? (
                  <p className="px-4 py-3 text-body text-ink-faint">You&rsquo;re all settled up.</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {profile.obligations.map((item) => {
                      const owe = item.netCents < 0;
                      const canSettleThis = profile.canSettleDirectly || item.groupId !== null;
                      return (
                        <li key={obligationKey(item)} className="flex min-h-[var(--row-h)] items-center gap-3 px-4 py-2">
                          <span className="min-w-0 flex-1">
                            <RowMeta>{item.groupName ?? "Direct balance"} · {owe ? "You owe" : "Owes you"}</RowMeta>
                            <span className={`tnum block text-amount font-semibold tracking-tight ${owe ? "text-owe" : "text-owed"}`}>
                              {fmtMoney(Math.abs(item.netCents), item.currency)}
                            </span>
                          </span>
                          {owe && canSettleThis && (
                            <Button size="sm" variant="secondary" onClick={() => { setSettleKey(obligationKey(item)); setSettleSign(-1); }}>
                              <HandCoins className="h-4 w-4" /> Settle up
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
              <Card>
                <CardHeader title="Shared groups" meta={profile.sharedGroups.length} />
                {profile.sharedGroups.length === 0 ? (
                  <p className="px-4 py-3 text-body text-ink-faint">No shared groups.</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {profile.sharedGroups.map((g) => (
                      <li key={g.id}>
                        <Link href={`/groups/${g.id}`} className={`group-hue-${g.id % 6} flex min-h-[var(--control-h)] items-center gap-3 px-4 py-1.5 hover:bg-subtle`}>
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--group-soft)] text-[var(--group-ink)]">
                            <Users className="h-3.5 w-3.5" />
                          </span>
                          <RowTitle className="min-w-0 flex-1">{g.name}</RowTitle>
                          <span className="text-meta text-ink-faint">{g.currency}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </aside>
            <div className="space-y-3 lg:col-start-1 lg:row-start-1 lg:min-h-0 lg:overflow-y-auto">
              <Card>
                <CardHeader title="Shared history" />
                <div className="border-b border-line p-3">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                    <Input
                      value={historyQuery}
                      onChange={(e) => setHistoryQuery(e.target.value)}
                      placeholder="Search expenses and payments"
                      aria-label="Search shared history"
                      className="pl-8 pr-11"
                    />
                    {historyQuery && (
                      <IconButton
                        size="sm"
                        onClick={() => setHistoryQuery("")}
                        label="Clear shared history search"
                        className="absolute right-0.5 top-1/2 -translate-y-1/2"
                      >
                        <X className="h-4 w-4" />
                      </IconButton>
                    )}
                  </div>
                </div>
                <HistoryList profile={profile} meId={me?.id ?? 0} query={historyQuery} />
              </Card>
            </div>
          </div>

          <DirectSettleModal
            initialKey={settleKey}
            friend={settleSign ? {
              id: profile.person.id,
              displayName: profile.person.displayName,
              obligations: profile.obligations,
              netByCurrency: profile.netByCurrency,
            } : null}
            preferredSign={settleSign ?? undefined}
            onClose={() => setSettleSign(null)}
            onSaved={reload}
          />
          {me && (
            <DirectPaymentsModal
              friend={paymentsOpen ? { id: profile.person.id, displayName: profile.person.displayName } : null}
              meId={me.id}
              onClose={() => setPaymentsOpen(false)}
              onChanged={reload}
            />
          )}
        </>
      ) : (
        <div className="space-y-4">
          {profileError ? (
            <Card>
              <EmptyState
                title="Could not load profile"
                hint={profileError}
                action={<Button variant="secondary" onClick={reload}>Retry</Button>}
              />
            </Card>
          ) : (
            <>
              <div className="skeleton h-16 w-full" />
              <div className="skeleton h-64 w-full" />
            </>
          )}
        </div>
      )}
    </AppShell>
  );
}

function ProfileActions({
  profile, onSettle, onPayments, onNudge, onRemove, onRequest,
}: {
  profile: PersonProfile;
  onSettle: (preferredSign: -1 | 1) => void;
  onPayments: () => void;
  onNudge: () => void;
  onRemove: () => void;
  onRequest: () => void;
}) {
  const router = useRouter();
  if (profile.relationship === "self") return null;
  const theyOweMe = profile.obligations.some((item) => item.netCents > 0);
  const iOweThem = profile.obligations.some((item) => item.netCents < 0);
  const canSettle = profile.canSettleDirectly || profile.obligations.some((item) => item.groupId !== null);
  const dmHref = `/chat?dm=${profile.person.id}`;

  // One contextual primary tied to the relationship; everything else overflows.
  let primary: React.ReactNode = null;
  let used = "";
  if (theyOweMe && profile.canNudge) {
    primary = <Button onClick={onNudge}><Bell className="h-4 w-4" /> Remind</Button>; used = "nudge";
  } else if (iOweThem && canSettle) {
    primary = <Button onClick={() => onSettle(-1)}><HandCoins className="h-4 w-4" /> Settle up</Button>; used = "settle";
  } else if (profile.canChat) {
    primary = <Link href={dmHref}><Button><MessageSquare className="h-4 w-4" /> Chat</Button></Link>; used = "chat";
  } else if (profile.canRequestFriend) {
    primary = <Button onClick={onRequest}><UserPlus className="h-4 w-4" /> Add friend</Button>; used = "request";
  }

  const items: React.ReactNode[] = [];
  if (profile.canChat && used !== "chat") items.push(<MenuItem key="chat" icon={<MessageSquare className="h-4 w-4" />} onClick={() => router.push(dmHref)}>Chat</MenuItem>);
  if (canSettle && iOweThem && used !== "settle") items.push(<MenuItem key="settle" icon={<HandCoins className="h-4 w-4" />} onClick={() => onSettle(-1)}>Settle up</MenuItem>);
  if (canSettle && theyOweMe) items.push(<MenuItem key="received" icon={<HandCoins className="h-4 w-4" />} onClick={() => onSettle(1)}>Record payment received</MenuItem>);
  if (profile.canSettleDirectly) items.push(<MenuItem key="pay" icon={<Receipt className="h-4 w-4" />} onClick={onPayments}>Payment history</MenuItem>);
  if (profile.canNudge && used !== "nudge") items.push(<MenuItem key="nudge" icon={<Bell className="h-4 w-4" />} onClick={onNudge}>Remind</MenuItem>);
  if (profile.canRequestFriend && used !== "request") items.push(<MenuItem key="req" icon={<UserPlus className="h-4 w-4" />} onClick={onRequest}>Add friend</MenuItem>);
  if (profile.canRemoveFriend) items.push(<MenuItem key="rm" icon={<UserMinus className="h-4 w-4" />} danger onClick={onRemove}>Remove friend</MenuItem>);

  return (
    <div className="flex items-center gap-2">
      {primary}
      {items.length > 0 && <Menu label={`More actions for ${profile.person.displayName}`}>{items}</Menu>}
    </div>
  );
}

function HistoryList({ profile, meId, query }: { profile: PersonProfile; meId: number; query: string }) {
  const normalizedQuery = query.trim().toLowerCase();
  const rows = [
    ...profile.recentExpenses.map((e) => ({ type: "expense" as const, key: `e-${e.id}`, date: e.date, item: e })),
    ...profile.recentPayments.map((p) => ({ type: "payment" as const, key: `p-${p.id}`, date: p.date, item: p })),
  ].filter((row) => {
    if (!normalizedQuery) return true;
    const text = row.type === "expense"
      ? `${row.item.title} ${row.item.groupName} ${row.item.payerName} ${row.item.currency}`
      : `${row.item.payerName} ${row.item.recipientName} ${row.item.groupName ?? "direct"} ${row.item.note} ${row.item.currency}`;
    return text.toLowerCase().includes(normalizedQuery);
  }).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 30);

  if (rows.length === 0 && !normalizedQuery) {
    return <EmptyState title="No shared history yet" hint="Shared expenses and recorded payments will appear here." />;
  }
  if (rows.length === 0) {
    return <EmptyState icon={<Search className="h-6 w-6" />} title="No matching history" hint="Try a different expense, group, person, note, or currency." />;
  }

  return (
    <ul className="divide-y divide-line">
      {rows.map((row) => row.type === "expense" ? (
        <li key={row.key}>
          <Link href={`/groups/${row.item.groupId}?expense=${row.item.id}`} className="flex min-h-[var(--row-h)] items-center gap-3 px-4 py-2 hover:bg-subtle">
            <Receipt className="h-4 w-4 shrink-0 text-accent" />
            <span className="min-w-0 flex-1">
              <RowTitle>{row.item.title}</RowTitle>
              <RowMeta>
                {row.item.groupName} · paid by {row.item.payerId === meId ? "you" : row.item.payerName} · {fmtDate(row.item.date)}
              </RowMeta>
            </span>
            <span className="tnum text-body font-semibold">{fmtMoney(row.item.amountCents, row.item.currency)}</span>
          </Link>
        </li>
      ) : (
        <li key={row.key} className="flex min-h-[var(--row-h)] items-center gap-3 px-4 py-2">
          <HandCoins className="h-4 w-4 shrink-0 text-owed" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-row">
              <strong className="font-medium">{row.item.payerId === meId ? "You" : row.item.payerName}</strong> paid{" "}
              <strong className="font-medium">{row.item.recipientId === meId ? "you" : row.item.recipientName}</strong>
            </span>
            <RowMeta>
              {row.item.groupName ?? "Direct"} · {fmtDate(row.item.date)}{row.item.note ? ` · ${row.item.note}` : ""}
            </RowMeta>
          </span>
          <span className="tnum text-body font-semibold">{fmtMoney(row.item.amountCents, row.item.currency)}</span>
        </li>
      ))}
    </ul>
  );
}
