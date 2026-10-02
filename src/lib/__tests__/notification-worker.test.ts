import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

function worker() {
  const listeners = new Map<string, (e: object) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const matchAll = vi.fn().mockResolvedValue([]);
  vm.runInNewContext(readFileSync("src/sw/sw.template.js", "utf8"), {
    self: { addEventListener: (type: string, fn: (e: object) => void) => listeners.set(type, fn),
      location: { origin: "https://fixture.example" }, registration: { showNotification }, clients: { openWindow, matchAll } },
    URL, setTimeout, clearTimeout, MessageChannel,
  });
  return { listeners, showNotification, openWindow, matchAll };
}

describe("notification service worker", () => {
  it("shows a private notification even for malformed payloads", async () => {
    const w = worker(); let pending: Promise<unknown> | undefined;
    w.listeners.get("push")!({ data: { json: () => { throw new Error("malformed"); } }, waitUntil: (p: Promise<unknown>) => { pending = p; } });
    await pending;
    expect(w.showNotification).toHaveBeenCalledWith("SplitWisest", expect.objectContaining({ body: "You have new activity. Open SplitWisest to view it.", data: { url: "/notifications" } }));
  });
  it("ignores sensitive body text and gives retries the same notification tag", async () => {
    const w = worker(); const payload = { notificationId: 4, url: "/notifications/4", body: "Private bill: $400", title: "Private person" };
    for (let i = 0; i < 2; i++) {
      let pending: Promise<unknown> | undefined;
      w.listeners.get("push")!({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => { pending = p; } }); await pending;
    }
    expect(w.showNotification.mock.calls[0]).toEqual(w.showNotification.mock.calls[1]);
    expect(w.showNotification.mock.calls[0][1].tag).toBe("notification-4");
    expect(JSON.stringify(w.showNotification.mock.calls)).not.toContain("Private");
  });
  it.each(["//outside.example", "/\\outside.example", "https://outside.example", "/api/me"])("rejects tap destination %s", async (url) => {
    const w = worker(); let pending: Promise<unknown> | undefined;
    const close = vi.fn();
    w.listeners.get("notificationclick")!({ notification: { close, data: { url } }, waitUntil: (p: Promise<unknown>) => { pending = p; } });
    await pending; expect(close).toHaveBeenCalledOnce(); expect(w.openWindow).toHaveBeenCalledWith("/notifications");
  });
  it("opens the exact notification when no app window exists", async () => {
    const w = worker(); let pending: Promise<unknown> | undefined;
    w.listeners.get("notificationclick")!({ notification: { close: vi.fn(), data: { url: "/notifications/52" } }, waitUntil: (p: Promise<unknown>) => { pending = p; } });
    await pending; expect(w.openWindow).toHaveBeenCalledWith("/notifications/52");
  });
  it("focuses a warm app and waits for its navigation acknowledgment", async () => {
    const w = worker(); let pending: Promise<unknown> | undefined;
    const focus = vi.fn().mockResolvedValue(undefined);
    const postMessage = vi.fn((_message, ports: MessagePort[]) => { ports[0].postMessage({ opened: true }); ports[0].close(); });
    w.matchAll.mockResolvedValue([{ url: "https://fixture.example/", focus, postMessage }]);
    w.listeners.get("notificationclick")!({ notification: { close: vi.fn(), data: { url: "/notifications/52" } }, waitUntil: (p: Promise<unknown>) => { pending = p; } });
    await pending; expect(focus).toHaveBeenCalledOnce(); expect(postMessage.mock.calls[0][0]).toEqual({ type: "SPLITWISEST_NOTIFICATION_CLICK", url: "/notifications/52" });
    expect(w.openWindow).not.toHaveBeenCalled();
  });
});
