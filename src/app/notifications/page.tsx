"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Bell, Check, CheckCheck, CircleDot, Settings } from "lucide-react";
import { AppShell } from "@/components/shell";
import { Button, Card, EmptyState, ErrorNote, IconButton, Segmented } from "@/components/ui";
import { api, fmtTime, useSync } from "@/lib/client";
import type { NotificationItem } from "@/lib/notification-types";

interface Inbox { notifications: NotificationItem[]; unreadCount: number; nextBefore: number | null }

// Inbox reads stay out of the persistent financial read cache and die on account/navigation changes.
function useInbox(path: string) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ path: string; data: Inbox | null; error: string | null }>({ path, data: null, error: null });
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  useSync((c, previous) => {
    if (c.notificationCursor !== previous.notificationCursor || c.unread?.notifications !== previous.unread?.notifications) reload();
  });
  useEffect(() => {
    let active = true;
    void api<Inbox>(path).then((data) => { if (active) setState({ path, data, error: null }); })
      .catch(() => { if (active) setState({ path, data: null, error: "Could not load notifications. Check your connection and try again." }); });
    return () => { active = false; };
  }, [path, revision]);
  return { data: state.path === path ? state.data : null, error: state.path === path ? state.error : null, reload };
}

export default function NotificationsPage() { return <Suspense><InboxPage /></Suspense>; }
function InboxPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [before, setBefore] = useState<number | null>(null);
  const path = `/api/notifications?unread=${unreadOnly ? 1 : 0}${before ? `&before=${before}` : ""}`;
  const { data, error, reload } = useInbox(path);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const params = useSearchParams();
  const mark = useCallback(async (body: { id?: number; throughId?: number; read: boolean }) => {
    setBusy(true); setActionError(null);
    try { await api("/api/notifications", { method: "PATCH", body }); reload(); }
    catch { setActionError("Could not save read status. Try again."); }
    finally { setBusy(false); }
  }, [reload]);

  return <AppShell title="Notifications">
    <div className="mb-3 flex items-center gap-2">
      <Segmented
        label="Notification filter"
        value={unreadOnly ? "unread" : "all"}
        onChange={(value) => { setUnreadOnly(value === "unread"); setBefore(null); }}
        options={[{ value: "all", label: "All" }, { value: "unread", label: `Unread${data ? ` (${data.unreadCount})` : ""}` }]}
      />
      <div className="ml-auto flex items-center gap-1">
        {data && data.unreadCount > 0 && !before && data.notifications[0] && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void mark({ throughId: data.notifications[0].id, read: true })}>
            <CheckCheck className="h-4 w-4" /> Mark all read
          </Button>
        )}
        <Link href="/settings#notifications" aria-label="Notification settings" title="Notification settings"
          className="inline-flex h-[var(--control-h)] w-[var(--control-h)] items-center justify-center rounded-lg text-ink-soft hover:bg-subtle hover:text-ink">
          <Settings className="h-4.5 w-4.5" />
        </Link>
      </div>
    </div>
    {params.get("test") === "opened" && <p role="status" className="mb-3 rounded-xl bg-accent-soft p-3 text-body text-accent-dark">Test notification opened.</p>}
    <ErrorNote message={actionError ?? error} />
    {!data && !error && <div role="status" className="space-y-2"><span className="sr-only">Loading notifications…</span>{[...Array(4)].map((_, i) => <div key={i} className="skeleton h-16 w-full" />)}</div>}
    {error && <Button className="mt-2" variant="secondary" onClick={reload}>Try again</Button>}
    {data && <>
      {data.notifications.length === 0 ? <Card><EmptyState icon={<Bell className="h-6 w-6" />} title={unreadOnly ? "You’re all caught up" : "No notifications yet"}
        hint={unreadOnly ? "New activity appears here." : "Messages, expenses, and other activity from your friends appear here."} /></Card>
        : <Card className="shrink-0 divide-y divide-line overflow-hidden">
          {data.notifications.map((n) => <div key={n.id} className="flex items-start gap-2 py-2 pl-3 pr-1.5 sm:pl-4">
            <span className={`mt-2 h-2 w-2 shrink-0 rounded-full ${n.readAt ? "bg-transparent" : "bg-accent"}`} aria-hidden="true" />
            <Link href={`/notifications/${n.id}`} className="min-w-0 flex-1 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <span className="sr-only">{n.readAt ? "Read" : "Unread"}</span>
              <p className={`text-row ${n.readAt ? "font-medium text-ink-soft" : "font-semibold text-ink"}`}>{n.title}</p>
              <p className="break-words text-body text-ink-soft">{n.body}</p>
              <p className="mt-0.5 text-meta text-ink-faint">{fmtTime(n.createdAt)}</p>
            </Link>
            <IconButton variant={n.readAt ? "ghost" : "accent"} disabled={busy} label={`Mark ${n.title.toLowerCase()} ${n.readAt ? "unread" : "read"}`}
              onClick={() => void mark({ id: n.id, read: !n.readAt })}>
              {n.readAt ? <CircleDot className="h-4 w-4" /> : <Check className="h-4 w-4" />}
            </IconButton>
          </div>)}
        </Card>}
      <div className="mt-3 flex gap-2">
        {before && <Button variant="secondary" onClick={() => setBefore(null)}>Newest</Button>}
        {data.nextBefore && <Button variant="secondary" onClick={() => setBefore(data.nextBefore)}>Older notifications</Button>}
      </div>
    </>}
  </AppShell>;
}
