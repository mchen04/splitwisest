"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { AppShell } from "@/components/shell";
import { api } from "@/lib/client";
import { safeNotificationPath, type NotificationItem } from "@/lib/notification-types";

export default function OpenNotification() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { notification } = await api<{ notification: NotificationItem }>(`/api/notifications/${id}`);
        if (!active) return;
        await api("/api/notifications", { method: "PATCH", body: { id: notification.id, read: true } });
        if (active) router.replace(safeNotificationPath(notification.href));
      } catch { if (active) setError(true); }
    })();
    return () => { active = false; };
  }, [id, router]);
  return <AppShell title="Open notification"><p role={error ? "alert" : "status"} className="py-4 text-body text-ink-soft">
    {error ? "This notification is unavailable, or your connection was interrupted." : "Opening notification…"}</p>
    {error && <Link href="/notifications" className="inline-flex min-h-[var(--control-h)] items-center text-body font-semibold text-accent">Back to notifications</Link>}
  </AppShell>;
}
