"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Bell, CheckCheck, Settings } from "lucide-react";
import { AppShell } from "@/components/shell";
import { Button, Card, EmptyState, ErrorNote } from "@/components/ui";
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
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="flex gap-1" role="group" aria-label="Notification filter">
        <Button variant={!unreadOnly ? "primary" : "secondary"} aria-pressed={!unreadOnly}
          onClick={() => { setUnreadOnly(false); setBefore(null); }}>All</Button>
        <Button variant={unreadOnly ? "primary" : "secondary"} aria-pressed={unreadOnly}
          onClick={() => { setUnreadOnly(true); setBefore(null); }}>Unread{data ? ` (${data.unreadCount})` : ""}</Button>
      </div>
      <Link href="/settings#notifications" className="flex min-h-11 items-center gap-2 text-sm font-medium text-accent"><Settings className="h-4 w-4" /> Settings</Link>
    </div>
    {params.get("test") === "opened" && <p role="status" className="mb-3 rounded-xl bg-accent-soft p-3 text-sm text-accent-dark">Test notification opened.</p>}
    <ErrorNote message={actionError ?? error} />
    {!data && !error && <p role="status" className="py-6 text-sm text-ink-faint">Loading notifications…</p>}
    {error && <Button variant="secondary" onClick={reload}>Try again</Button>}
    {data && <>
      {data.unreadCount > 0 && !before && data.notifications[0] && <div className="mb-3 flex justify-end">
        <Button variant="ghost" disabled={busy} onClick={() => void mark({ throughId: data.notifications[0].id, read: true })}><CheckCheck className="h-4 w-4" /> Mark all read</Button>
      </div>}
      {data.notifications.length === 0 ? <EmptyState icon={<Bell className="h-6 w-6" />} title={unreadOnly ? "You’re all caught up" : "No notifications yet"}
        hint={unreadOnly ? "New activity appears here." : "Messages, expenses, and other activity from your friends appear here."} />
        : <Card className="shrink-0 divide-y divide-line overflow-hidden">
          {data.notifications.map((n) => <div key={n.id} className={`flex items-start gap-2 px-3 py-3 sm:px-4 ${n.readAt ? "" : "bg-accent-soft"}`}>
            <span className={`mt-2 h-2 w-2 shrink-0 rounded-full ${n.readAt ? "bg-line" : "bg-accent"}`} aria-hidden="true" />
            <Link href={`/notifications/${n.id}`} className="min-w-0 flex-1 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <span className="sr-only">{n.readAt ? "Read" : "Unread"}</span>
              <p className="text-sm font-semibold">{n.title}</p>
              <p className="mt-0.5 break-words text-sm text-ink-soft">{n.body}</p>
              <p className="mt-1 text-xs text-ink-faint">{fmtTime(n.createdAt)}</p>
            </Link>
            <Button variant="ghost" disabled={busy} className="shrink-0" aria-label={`Mark ${n.title.toLowerCase()} ${n.readAt ? "unread" : "read"}`}
              onClick={() => void mark({ id: n.id, read: !n.readAt })}>{n.readAt ? "Unread" : "Read"}</Button>
          </div>)}
        </Card>}
      <div className="mt-3 flex gap-2">
        {before && <Button variant="secondary" onClick={() => setBefore(null)}>Newest</Button>}
        {data.nextBefore && <Button variant="secondary" onClick={() => setBefore(data.nextBefore)}>Older notifications</Button>}
      </div>
    </>}
  </AppShell>;
}
