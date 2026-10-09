"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, Smartphone } from "lucide-react";
import { api, fmtTime, useMe } from "@/lib/client";
import { NOTIFICATION_CATEGORIES, type NotificationPreferences, type NotificationSettings } from "@/lib/notification-types";
import { devicePushStatus, disablePush, enablePush, type DevicePushStatus } from "@/lib/push-client";
import { Button, Card, CardHeader, ErrorNote, HeaderLink } from "./ui";

const STATUS_TEXT: Record<DevicePushStatus, string> = {
  on: "Notifications are on for this device.", off: "Notifications are off for this device.",
  install: "On iPhone or iPad, use Safari → Share → Add to Home Screen. Open that app, then turn on notifications.",
  denied: "Notifications are blocked. Allow SplitWisest notifications in your browser or device settings, then return here.",
  unsupported: "This browser cannot receive push notifications. Your notification inbox still works.",
  unavailable: "Phone notifications are not available for this account yet. Your notification inbox still works.",
  development: "Use the hosted app to turn on notifications. This development preview supports the inbox only.",
};

export function NotificationSettingsCard() {
  const me = useMe();
  const [data, setData] = useState<NotificationSettings | null>(null);
  const [device, setDevice] = useState<{ status: DevicePushStatus; id: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [testId, setTestId] = useState<number | null>(null);
  const reload = useCallback(async () => {
    const next = await api<NotificationSettings>("/api/notification-settings");
    setData(next);
    setDevice(await devicePushStatus(next.publicKey));
  }, []);
  useEffect(() => {
    const refresh = () => { void reload().catch(() => setError("Could not load notification settings. Try again.")); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [reload]);

  useEffect(() => {
    if (!testId) return;
    let active = true;
    const poll = async () => {
      try {
        const result = await api<{ state: string; attempts: number }>(`/api/push/test?id=${testId}`);
        if (!active) return;
        if (result.state === "sent") {
          setNotice("Push service accepted the test. Confirm arrival and tap it on this device."); setTestId(null);
        } else if (result.state === "failed" || result.state === "skipped") {
          setError("The test could not reach this device. Turn notifications off and on, then try again."); setTestId(null);
        } else if (result.attempts > 0) setNotice("The test is waiting for delivery. It will retry automatically.");
      } catch { /* The next poll handles a short connection loss. */ }
    };
    const timer = window.setInterval(() => void poll(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [testId]);

  async function act(work: () => Promise<unknown>, success: string) {
    if (busy) return;
    setBusy(true); setError(null); setNotice("");
    try { await work(); await reload(); setNotice(success); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save notifications. Try again."); }
    finally { setBusy(false); }
  }
  function preference(patch: Partial<NotificationPreferences>) {
    void act(() => api("/api/notification-settings", { method: "PATCH", body: patch }), "Preferences saved.");
  }
  function test(delaySeconds: 0 | 15) {
    void act(async () => {
      const result = await api<{ id: number }>("/api/push/test", { body: { subscriptionId: device?.id, delaySeconds } });
      setTestId(result.id);
    },
      delaySeconds ? "Test queued for 15 seconds from now. Leave the app, then tap the notification when it arrives."
        : "Test queued. Confirm it appears on this device, then tap it.");
  }

  return <section id="notifications"><Card>
    <CardHeader title={<span className="flex items-center gap-2"><Bell className="h-4 w-4" /> Notifications</span>}
      action={<HeaderLink href="/notifications">Open inbox</HeaderLink>} />
    <div className="space-y-3 px-4 py-3">
      <div className="space-y-3">
        <p className="text-body text-ink-soft" role="status">{device ? STATUS_TEXT[device.status] : "Checking this device…"}</p>
        <p className="text-meta text-ink-faint">Alerts hide names, messages, and amounts. Open SplitWisest to see the details.</p>
        {device?.status === "off" && data?.publicKey && me && <Button disabled={busy} onClick={() => {
          // act calls work synchronously, so Safari still sees the user's tap.
          void act(() => enablePush(data.publicKey!, me.id), "Notifications are on for this device.");
        }}>Turn on notifications</Button>}
        {device?.status === "on" && <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => test(0)}>Send test</Button>
          <Button variant="secondary" disabled={busy} onClick={() => test(15)}>Test in 15 seconds</Button>
          <Button variant="ghost" disabled={busy} onClick={() => void act(() => disablePush(device.id), "Notifications are off for this device.")}>Turn off this device</Button>
        </div>}
      </div>
      {data && <fieldset className="space-y-1 border-t border-line pt-3" disabled={busy}>
        <legend className="sr-only">Phone alert preferences</legend>
        <label className="flex min-h-11 items-center justify-between gap-3 text-body font-semibold">
          Phone alerts on all devices
          <input type="checkbox" className="h-5 w-5 shrink-0 accent-accent" checked={data.preferences.pushEnabled}
            onChange={(e) => preference({ pushEnabled: e.target.checked })} />
        </label>
        <p className="pb-2 text-meta text-ink-faint">Choose which alerts reach your devices. All activity stays in your notification inbox for 90 days.</p>
        {Object.entries(NOTIFICATION_CATEGORIES).map(([key, label]) => <label key={key} className="flex min-h-11 items-center justify-between gap-3 text-body text-ink-soft">
          {label}
          <input type="checkbox" className="h-5 w-5 shrink-0 accent-accent" disabled={!data.preferences.pushEnabled}
            checked={data.preferences.categories[key as keyof typeof NOTIFICATION_CATEGORIES]}
            onChange={(e) => preference({ categories: { ...data.preferences.categories, [key]: e.target.checked } })} />
        </label>)}
      </fieldset>}
      {!!data?.devices.length && <div className="space-y-2 border-t border-line pt-3">
        <p className="text-body font-semibold">Your devices</p>
        {data.devices.map((d) => <div key={d.id} className="flex items-center gap-2 text-body">
          <Smartphone className="h-4 w-4 shrink-0 text-ink-faint" />
          <div className="min-w-0 flex-1"><p>{d.label}{d.id === device?.id ? " · This device" : ""}</p><p className="text-meta text-ink-faint">Last connected {fmtTime(d.updatedAt)}</p></div>
          <Button variant="ghost" disabled={busy} aria-label={`Remove ${d.label}${d.id === device?.id ? " on this device" : " device"}`}
            onClick={() => void act(() => d.id === device?.id ? disablePush(d.id)
              : api("/api/push/subscriptions", { method: "DELETE", body: { id: d.id } }), "Device removed.")}>Remove</Button>
        </div>)}
      </div>}
      <ErrorNote message={error} />
      {error && <Button variant="secondary" disabled={busy} onClick={() => void act(reload, "Settings refreshed.")}>Try again</Button>}
      {notice && <p role="status" className="text-body text-accent">{notice}</p>}
    </div>
  </Card></section>;
}
