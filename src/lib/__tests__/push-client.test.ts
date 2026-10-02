import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../client", () => ({ api: mocks.api }));
const publicKey = webpush.generateVAPIDKeys().publicKey;
const keyBytes = Uint8Array.from(Buffer.from(publicKey, "base64url")).buffer;
const calls: string[] = [];
const store = new Map<string, string>();
const unsubscribe = vi.fn().mockResolvedValue(true);
const sub = { endpoint: "https://web.push.apple.com/fixture", options: { applicationServerKey: keyBytes },
  toJSON: () => ({ keys: { p256dh: "fixture-key", auth: "fixture-auth" } }), unsubscribe };
const getSubscription = vi.fn();
const subscribe = vi.fn();
const requestPermission = vi.fn();
let permission = "default";
function browser(userAgent = "Chrome", standalone = false, support = true) {
  const registration = { pushManager: { getSubscription, subscribe } };
  vi.stubGlobal("navigator", { userAgent, platform: "MacIntel", maxTouchPoints: 0,
    serviceWorker: { getRegistration: vi.fn().mockResolvedValue(registration), ready: Promise.resolve(registration) } });
  vi.stubGlobal("window", { isSecureContext: true, matchMedia: () => ({ matches: standalone }),
    ...(support ? { PushManager: class {}, Notification: class {} } : {}) });
  vi.stubGlobal("Notification", { get permission() { return permission; }, requestPermission });
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); calls.length = 0; store.clear(); permission = "default";
  getSubscription.mockResolvedValue(null);
  subscribe.mockImplementation(async () => { calls.push("subscribe"); return sub; });
  requestPermission.mockImplementation(async () => { calls.push("permission"); permission = "granted"; return permission; });
  mocks.api.mockImplementation(async (path: string) => { calls.push(path); return path === "/api/notification-settings" ? { publicKey } : { id: 4 }; });
  browser();
});
afterEach(() => vi.unstubAllGlobals());

describe("device push lifecycle", () => {
  it("requests permission from the tap before subscribing or making a network call", async () => {
    const { enablePush } = await import("../push-client");
    expect(await enablePush(publicKey, 12)).toBe(4);
    expect(calls).toEqual(["permission", "subscribe", "/api/push/subscriptions"]);
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array(keyBytes) });
  });
  it("handles denied or dismissed permission without storing a device", async () => {
    const { enablePush } = await import("../push-client");
    requestPermission.mockResolvedValueOnce("denied").mockResolvedValueOnce("default");
    await expect(enablePush(publicKey, 12)).rejects.toThrow("blocked");
    await expect(enablePush(publicKey, 12)).rejects.toThrow("not granted");
    expect(mocks.api).not.toHaveBeenCalled(); expect(subscribe).not.toHaveBeenCalled();
  });
  it("requires Home Screen installation on iPhone and iPad, even if APIs exist", async () => {
    const { pushSupport, enablePush } = await import("../push-client");
    browser("iPhone"); expect(pushSupport()).toBe("install");
    await expect(enablePush(publicKey, 12)).rejects.toThrow("Install");
    expect(requestPermission).not.toHaveBeenCalled();
    browser("iPhone", true); expect(pushSupport()).toBe("supported");
    browser("Chrome", false, false); expect(pushSupport()).toBe("unsupported");
  });
  it("only reports on after the server confirms ownership", async () => {
    permission = "granted"; getSubscription.mockResolvedValue(sub);
    const { devicePushStatus } = await import("../push-client");
    mocks.api.mockResolvedValueOnce({ id: null });
    expect(await devicePushStatus(publicKey)).toEqual({ status: "off", id: null });
    mocks.api.mockResolvedValueOnce({ id: 4 });
    expect(await devicePushStatus(publicKey)).toEqual({ status: "on", id: 4 });
  });
  it("leaves a failed subscription save retryable and never remembers success", async () => {
    const { enablePush, syncExistingPush } = await import("../push-client");
    mocks.api.mockRejectedValueOnce(new Error("Offline"));
    await expect(enablePush(publicKey, 12)).rejects.toThrow("Offline");
    expect(store.size).toBe(0);
    mocks.api.mockClear(); await syncExistingPush(12); expect(mocks.api).not.toHaveBeenCalled();
  });
  it("does not silently restore a device removed from another browser", async () => {
    const { enablePush, syncExistingPush } = await import("../push-client");
    await enablePush(publicKey, 12); getSubscription.mockResolvedValue(sub);
    mocks.api.mockClear(); mocks.api.mockResolvedValueOnce({ id: null });
    await syncExistingPush(12);
    expect(calls.filter((v) => v === "permission")).toHaveLength(1);
    expect(mocks.api).toHaveBeenCalledOnce(); expect(store.size).toBe(0);
  });
  it("does not attach another account's device on sign-in", async () => {
    const { enablePush, syncExistingPush } = await import("../push-client");
    await enablePush(publicKey, 12); mocks.api.mockClear();
    await syncExistingPush(13); expect(mocks.api).not.toHaveBeenCalled();
  });
  it("replaces a subscription after key rotation only on a new tap", async () => {
    const { enablePush } = await import("../push-client");
    getSubscription.mockResolvedValue({ ...sub, options: { applicationServerKey: new Uint8Array(65).buffer } });
    await enablePush(publicKey, 12);
    expect(unsubscribe).toHaveBeenCalledOnce(); expect(subscribe).toHaveBeenCalledOnce();
    expect(mocks.api.mock.calls[0][1].method).toBe("DELETE");
  });
  it("removes the server device before browser unsubscribe, and exposes failures", async () => {
    permission = "granted"; getSubscription.mockResolvedValue(sub);
    const { disablePush } = await import("../push-client");
    mocks.api.mockRejectedValueOnce(new Error("Offline"));
    await expect(disablePush(4)).rejects.toThrow("Offline"); expect(unsubscribe).not.toHaveBeenCalled();
    await disablePush(4); expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
