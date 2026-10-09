"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Copy, MessageSquare, UserPlus, UserMinus, HandCoins, Scale, Receipt, Bell, X, Search, UserRound } from "lucide-react";
import { api, ApiClientError, fmtTime, useApiData, useFormState, useMe } from "@/lib/client";
import { AppShell } from "@/components/shell";
import {
  Card, CardHeader, EmptyState, Button, Avatar, Modal, Field, Input, ErrorNote, Menu, MenuItem, IconButton,
  RowMeta, SectionLabel, toast, confirmAction,
} from "@/components/ui";
import { DirectPaymentsModal } from "@/components/direct-payments-modal";
import { DirectSettleModal } from "@/components/direct-settle-modal";
import { FriendBalanceRow, sortByUrgency, useRemind, type FriendWithBalances } from "@/components/friend-balances";
import type { FriendObligation } from "@/lib/balances";

interface Friend {
  id: number;
  displayName: string;
  username: string;
  obligations: FriendObligation[];
  netByCurrency: Record<string, number>;
  canRemoveFriend: boolean;
}

interface FriendRequest {
  id: number;
  userId: number;
  displayName: string;
  username: string;
  createdAt: string;
}

interface Nudge {
  id: number;
  fromId: number;
  fromName: string;
  groupName: string | null;
  note: string;
  seen: boolean;
  createdAt: string;
}

export default function BalancesPage() {
  const router = useRouter();
  const { data, error: friendsError, reload } = useApiData<{
    friends: Friend[];
    incomingRequests: FriendRequest[];
    outgoingRequests: FriendRequest[];
    myInviteCode: string;
  }>("/api/friends");
  const friends = data?.friends ?? null;
  const incomingRequests = data?.incomingRequests ?? [];
  const outgoingRequests = data?.outgoingRequests ?? [];
  const inviteCode = data?.myInviteCode ?? "";
  const [addOpen, setAddOpen] = useState(false);
  const [code, setCode] = useState("");
  const [settle, setSettle] = useState<{ friendId: number; key?: string; sign: -1 | 1 } | null>(null);
  const [historyFriend, setHistoryFriend] = useState<Friend | null>(null);
  const [query, setQuery] = useState("");
  const me = useMe();
  const { error, setError, busy, run } = useFormState();
  const { remind, sentTo } = useRemind();

  const { data: nudgeData, reload: reloadNudges } =
    useApiData<{ nudges: Nudge[] }>("/api/nudges");
  const reminders = (nudgeData?.nudges ?? []).filter((n) => !n.seen);
  const filteredFriends = (friends ?? []).filter((f) => {
    const q = query.trim().toLowerCase();
    return !q || f.displayName.toLowerCase().includes(q) || f.username.toLowerCase().includes(q);
  });
  const activeFriends = sortByUrgency(filteredFriends.filter((f) => f.obligations.length > 0));
  const settledFriends = filteredFriends.filter((f) => f.obligations.length === 0);
  const settleFriend = friends?.find((friend) => friend.id === settle?.friendId) ?? null;
  const attention = incomingRequests.length + outgoingRequests.length + reminders.length;

  async function dismissReminder(id: number) {
    try {
      await api(`/api/nudges/${id}`, { method: "DELETE" });
      reloadNudges();
    } catch {
      // The reminder stays; the next refresh shows it again.
    }
  }

  function addFriend(e: React.FormEvent) {
    e.preventDefault();
    run(async () => {
      const r = await api<{ status: string; displayName: string }>("/api/friends", { body: { code } });
      setCode(""); setAddOpen(false);
      toast(r.status === "accepted" ? `You and ${r.displayName} are now friends` : `Friend request sent to ${r.displayName}`);
      reload();
    }, "Could not add friend");
  }

  async function respondRequest(request: FriendRequest, action: "accept" | "decline" | "cancel") {
    try {
      await api("/api/friends/requests", { body: { requestId: request.id, action } });
      if (action === "accept") toast(`You and ${request.displayName} are now friends`);
      reload();
    } catch (err) {
      toast(err instanceof ApiClientError ? err.message : "Could not update request", { tone: "error" });
    }
  }

  function copyInviteLink() {
    const link = `${window.location.origin}/signup?invite=${inviteCode}`;
    navigator.clipboard.writeText(link)
      .then(() => toast("Invite link copied. Anyone who signs up with it becomes your friend."))
      .catch(() => toast("Could not copy the invite link. Try again.", { tone: "error" }));
  }

  async function removeFriend(f: Friend) {
    if (!(await confirmAction({
      title: `Remove ${f.displayName}?`,
      message: "You will need an invite code to reconnect.",
      confirmLabel: "Remove friend",
      danger: true,
    }))) return;
    try {
      await api("/api/friends", { method: "DELETE", body: { friendId: f.id } });
      toast(`${f.displayName} removed from friends`);
      reload();
    } catch (err) {
      toast(err instanceof ApiClientError ? err.message : "Could not remove friend", { tone: "error" });
    }
  }

  const friendMenu = (f: Friend) => {
    const theyOweMe = f.obligations.some((item) => item.netCents > 0);
    return (
      <Menu label={`More actions for ${f.displayName}`} size="sm">
        {theyOweMe && (
          <MenuItem icon={<HandCoins className="h-4 w-4" />} onClick={() => setSettle({ friendId: f.id, sign: 1 })}>Record payment received</MenuItem>
        )}
        <MenuItem icon={<Receipt className="h-4 w-4" />} onClick={() => setHistoryFriend(f)}>Payment history</MenuItem>
        <MenuItem icon={<MessageSquare className="h-4 w-4" />} onClick={() => router.push(`/chat?dm=${f.id}`)}>Chat</MenuItem>
        <MenuItem icon={<UserRound className="h-4 w-4" />} onClick={() => router.push(`/people/${f.id}`)}>View profile</MenuItem>
        {f.canRemoveFriend && (
          <MenuItem icon={<UserMinus className="h-4 w-4" />} danger onClick={() => removeFriend(f)}>Remove friend</MenuItem>
        )}
      </Menu>
    );
  };

  const renderRows = (list: Friend[]) => list.map((f) => (
    <FriendBalanceRow
      key={f.id}
      friend={f}
      showUsername
      onSettle={(friend: FriendWithBalances, key) => setSettle({ friendId: friend.id, key, sign: -1 })}
      onRemind={remind}
      reminded={sentTo === f.id}
      menu={friendMenu(f)}
    />
  ));

  return (
    <AppShell title="Balances">
      <div className="mb-3 flex flex-wrap items-center gap-2 md:shrink-0">
        <div className="relative min-w-0 basis-full sm:basis-0 sm:flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search friends"
            aria-label="Search friends"
            className="pl-8"
          />
        </div>
        <Button className="flex-1 sm:flex-none" onClick={() => { setAddOpen(true); setError(null); }}>
          <UserPlus className="h-4 w-4" /> Add friend
        </Button>
        <Button variant="secondary" className="flex-1 sm:flex-none" onClick={copyInviteLink} disabled={!inviteCode}>
          <Copy className="h-4 w-4" /> Copy invite link
        </Button>
      </div>

      {attention > 0 && (
        <Card className="mb-3 md:shrink-0">
          <CardHeader title="Requests and reminders" meta={attention} />
          <ul className="divide-y divide-line">
            {incomingRequests.map((r) => (
              <li key={`in-${r.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
                <Avatar name={r.displayName} />
                <span className="min-w-0 flex-1 basis-48">
                  <span className="block text-body">
                    <Link href={`/people/${r.userId}`} className="font-semibold hover:text-accent-dark hover:underline">{r.displayName}</Link> wants to be friends
                  </span>
                  <RowMeta>@{r.username}</RowMeta>
                </span>
                <div className="ml-auto flex gap-2">
                  <Button size="sm" onClick={() => respondRequest(r, "accept")}>Accept</Button>
                  <Button size="sm" variant="secondary" onClick={() => respondRequest(r, "decline")}>Decline</Button>
                </div>
              </li>
            ))}
            {reminders.map((n) => {
              const from = friends?.find((f) => f.id === n.fromId);
              const iOwe = from?.obligations.some((o) => o.netCents < 0);
              return (
                <li key={`n-${n.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-dark"><Bell className="h-4 w-4" /></span>
                  <span className="min-w-0 flex-1 basis-48">
                    <span className="block text-body">
                      <strong>{n.fromName}</strong> reminded you to settle up{n.groupName ? <span className="text-ink-faint"> in {n.groupName}</span> : ""}
                    </span>
                    {n.note && <span className="block text-body text-ink-soft">“{n.note}”</span>}
                    <RowMeta>{fmtTime(n.createdAt)}</RowMeta>
                  </span>
                  <span className="ml-auto flex items-center gap-1">
                    {iOwe && from && (
                      <Button size="sm" variant="secondary" onClick={() => setSettle({ friendId: from.id, sign: -1 })}>
                        <HandCoins className="h-4 w-4" /> Settle up
                      </Button>
                    )}
                    <IconButton size="sm" label="Dismiss reminder" onClick={() => dismissReminder(n.id)}>
                      <X className="h-4 w-4" />
                    </IconButton>
                  </span>
                </li>
              );
            })}
            {outgoingRequests.map((r) => (
              <li key={`out-${r.id}`} className="flex items-center gap-3 px-4 py-2">
                <Avatar name={r.displayName} />
                <span className="min-w-0 flex-1">
                  <span className="block text-body">
                    Request sent to <Link href={`/people/${r.userId}`} className="font-semibold hover:text-accent-dark hover:underline">{r.displayName}</Link>
                  </span>
                  <RowMeta>@{r.username} · waiting for them to accept</RowMeta>
                </span>
                <Button size="sm" variant="secondary" onClick={() => respondRequest(r, "cancel")}>Cancel</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="flex flex-col md:min-h-0 md:flex-1">
        <CardHeader title="Friends" meta={friends ? friends.length : undefined} />
        <div className="md:min-h-0 md:flex-1 md:overflow-y-auto">
        {friendsError && friends === null ? (
          <EmptyState
            icon={<Scale className="h-6 w-6" />}
            title="Could not load friends"
            hint={friendsError}
            action={<Button variant="secondary" onClick={reload}>Try again</Button>}
          />
        ) : friends === null ? (
          <div className="space-y-2 p-3">{[...Array(3)].map((_, i) => <div key={i} className="skeleton h-12 w-full" />)}</div>
        ) : friends.length === 0 ? (
          <EmptyState
            icon={<Scale className="h-6 w-6" />}
            title="No friends yet"
            hint="Copy your invite link, or add a friend with their code."
            action={<Button variant="secondary" onClick={() => setAddOpen(true)}><UserPlus className="h-4 w-4" /> Add friend</Button>}
          />
        ) : filteredFriends.length === 0 ? (
          <EmptyState
            icon={<Search className="h-6 w-6" />}
            title="No matching friends"
            hint="Try a different name or username."
          />
        ) : (
          <div>
            {activeFriends.length > 0 && (
              <section aria-label="Active balances">
                <SectionLabel className="border-b border-line bg-subtle px-4 py-1.5">Active balances</SectionLabel>
                <ul className="divide-y divide-line">{renderRows(activeFriends)}</ul>
              </section>
            )}
            {settledFriends.length > 0 && (
              <section aria-label="Settled up">
                <SectionLabel className="border-y border-line bg-subtle px-4 py-1.5">Settled up</SectionLabel>
                <ul className="divide-y divide-line">{renderRows(settledFriends)}</ul>
              </section>
            )}
          </div>
        )}
        </div>
      </Card>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add a friend">
        <form onSubmit={addFriend} className="space-y-3">
          <Field label="Friend's invite code" hint="They can find it by tapping Copy invite link on their Balances page.">
            <Input value={code} onChange={(e) => setCode(e.target.value)} required data-autofocus autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </Field>
          <ErrorNote message={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button type="submit" busy={busy}>Send request</Button>
          </div>
        </form>
      </Modal>

      <DirectSettleModal
        friend={settleFriend}
        preferredSign={settle?.sign}
        initialKey={settle?.key}
        onClose={() => setSettle(null)}
        onSaved={() => { reload(); reloadNudges(); }}
      />

      {me && (
        <DirectPaymentsModal
          friend={historyFriend}
          meId={me.id}
          onClose={() => setHistoryFriend(null)}
          onChanged={reload}
        />
      )}
    </AppShell>
  );
}
