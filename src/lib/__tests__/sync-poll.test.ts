import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ cleanups: [] as (() => void)[], updates: vi.fn(), initialValues: [] as unknown[] }));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) hooks.cleanups.push(cleanup);
  },
  useLayoutEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) hooks.cleanups.push(cleanup);
  },
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [hooks.initialValues.length ? hooks.initialValues.shift() : typeof initial === "function" ? initial() : initial, hooks.updates],
}));

type Client = typeof import("../client");
const HOUR = 60 * 60 * 1000;
let client: Client;
let page: EventTarget & { hidden: boolean; cookie: string };
let browser: EventTarget;
let requests: number[];
let cursor: number;

function response(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function emit(type: string) {
  (type === "visibilitychange" ? page : browser).dispatchEvent(new Event(type));
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  hooks.cleanups = [];
  hooks.initialValues = [];
  hooks.updates.mockClear();
  requests = [];
  cursor = 1;
  page = Object.assign(new EventTarget(), { hidden: false, cookie: "" });
  browser = Object.assign(new EventTarget(), { setInterval, clearInterval });
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", browser);
  vi.stubGlobal("location", { pathname: "/groups/1", href: "" });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (path === "/api/sync") {
      requests.push(Date.now());
      return response({ activityCursor: cursor, messageCursor: 0, nudgeCursor: 0, requestCursor: 0,
        notificationCursor: 0, unread: { messages: 0, activity: cursor, nudges: 0, requests: 0, balances: 0, notifications: 0 } });
    }
    return response({ ok: true });
  }));
  client = await import("../client");
});

afterEach(async () => {
  for (const cleanup of hooks.cleanups.reverse()) cleanup();
  await settle();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shared sync polling", () => {
  it("makes zero sync requests during an hour hidden", async () => {
    page.hidden = true;
    client.useSync(vi.fn(), true);
    await vi.advanceTimersByTimeAsync(HOUR);
    console.info(`Hidden requests/hour: ${requests.length}`);
    expect(requests).toHaveLength(0);
  });

  it("makes at most three sync requests during an hour without input", async () => {
    client.useSync(vi.fn(), true);
    await vi.advanceTimersByTimeAsync(HOUR);
    console.info(`Idle requests/hour: ${requests.length}`);
    expect(requests.length).toBeLessThanOrEqual(3);
    const later = requests.filter((time) => time >= 120_000);
    for (let i = 1; i < later.length; i++) expect(later[i] - later[i - 1]).toBeGreaterThan(300_000);
    expect(later).toHaveLength(0);
  });

  it("keeps a four second cadence with input every thirty seconds for an hour", async () => {
    client.useSync(vi.fn(), true);
    emit("pointerdown");
    for (let elapsed = 0; elapsed < HOUR; elapsed += 30_000) {
      await vi.advanceTimersByTimeAsync(30_000);
      emit("pointerdown");
    }
    await settle();
    console.info(`Active requests/hour: ${requests.length}`);
    expect(requests.length).toBeGreaterThanOrEqual(900);
    expect(requests.length).toBeLessThanOrEqual(902);
    for (let i = 1; i < requests.length; i++) expect(requests[i] - requests[i - 1]).toBe(4000);
  });

  it.each(["visibilitychange", "focus", "pageshow", "online"])("syncs within 100 ms on %s", async (event) => {
    page.hidden = true;
    client.useSync(vi.fn(), true);
    await vi.advanceTimersByTimeAsync(1000);
    const before = requests.length;
    page.hidden = false;
    emit(event);
    await vi.advanceTimersByTimeAsync(100);
    expect(requests.length - before).toBe(1);
    expect(requests.at(-1)).toBeLessThanOrEqual(1100);
  });
});

describe("sync lifecycle", () => {
  it("stops two minutes after the last input for the rest of the hour", async () => {
    client.useSync(vi.fn(), true);
    emit("pointerdown");
    await vi.advanceTimersByTimeAsync(120_000);
    const activeCount = requests.length;
    await vi.advanceTimersByTimeAsync(HOUR - 120_000);
    expect(activeCount).toBe(30);
    expect(requests).toHaveLength(activeCount);
    expect(HOUR - requests.at(-1)!).toBeGreaterThan(300_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pointerdown", "keydown", "touchstart", "scroll", "wheel", "focus"])("resumes an idle tab immediately on %s", async (event) => {
    client.useSync(vi.fn(), true);
    await vi.advanceTimersByTimeAsync(600_000);
    const before = requests.length;
    emit(event);
    await vi.advanceTimersByTimeAsync(100);
    expect(requests.length - before).toBe(1);
    expect(requests.at(-1)).toBe(600_000);
    await vi.advanceTimersByTimeAsync(3900);
    expect(requests.length - before).toBe(2);
  });

  it("ignores wake events while hidden and cancels active polling", async () => {
    client.useSync(vi.fn(), true);
    emit("pointerdown");
    await vi.advanceTimersByTimeAsync(1000);
    page.hidden = true;
    emit("visibilitychange");
    for (const event of ["pointerdown", "keydown", "touchstart", "scroll", "wheel", "focus", "pageshow", "online"]) emit(event);
    const before = requests.length;
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(requests).toHaveLength(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one loop, fans out changes, and removes listeners after unmount", async () => {
    const first = vi.fn();
    const second = vi.fn();
    client.useSync(first, true);
    client.useSync(second, true);
    client.useUnread();
    emit("pointerdown");
    await vi.advanceTimersByTimeAsync(8000);
    expect(requests).toHaveLength(3);
    expect(first).toHaveBeenCalledTimes(3);
    expect(second).toHaveBeenCalledTimes(3);
    expect(hooks.updates).toHaveBeenCalledTimes(3);
    for (const cleanup of hooks.cleanups.splice(0)) cleanup();
    emit("focus");
    emit("pointerdown");
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(requests).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes sync hooks and cached reads after an idle user's mutation", async () => {
    const changed = vi.fn();
    client.useSync(changed);
    client.useApiData("/api/groups", 0, { sync: "activityCursor" });
    await vi.advanceTimersByTimeAsync(600_000);
    const before = requests.length;
    const reads = vi.mocked(fetch).mock.calls.filter(([path]) => path === "/api/groups").length;
    cursor++;
    await client.api("/api/expenses/1", { method: "PATCH", body: { amountCents: 200 } });
    await settle();
    expect(requests.length - before).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls.filter(([path]) => path === "/api/groups")).toHaveLength(reads + 1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(requests.length - before).toBe(1);
  });

  it("defers a hidden mutation's sync until the tab becomes visible", async () => {
    page.hidden = true;
    client.useSync(vi.fn(), true);
    await client.api("/api/expenses/1", { method: "PATCH", body: {} });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(requests).toHaveLength(0);
    page.hidden = false;
    emit("visibilitychange");
    await settle();
    expect(requests).toHaveLength(1);
  });

  it("coalesces return events while a sync is in flight", async () => {
    let release!: (value: ReturnType<typeof response>) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { release = resolve as typeof release; }));
    const listener = vi.fn();
    client.useSync(listener, true);
    for (const event of ["focus", "pageshow", "online"]) emit(event);
    expect(fetch).toHaveBeenCalledTimes(1);
    release(response({ activityCursor: 1 }));
    await settle();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not fan out an in-flight sync after the tab is hidden", async () => {
    let release!: (value: ReturnType<typeof response>) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { release = resolve as typeof release; }));
    const listener = vi.fn();
    client.useSync(listener, true);
    page.hidden = true;
    emit("visibilitychange");
    release(response({ activityCursor: 1 }));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(listener).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops an old account's in-flight result and syncs the signed-in account", async () => {
    let release!: (value: ReturnType<typeof response>) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { release = resolve as typeof release; }));
    const listener = vi.fn();
    client.useSync(listener, true);
    await client.api("/api/auth/login", { body: { username: "next" } });
    release(response({ activityCursor: 999 }));
    await settle();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].activityCursor).toBe(1);
  });

  it("stops polling after logout and can resume after login", async () => {
    const listener = vi.fn();
    client.useSync(listener, true);
    await settle();
    await client.api("/api/auth/logout", { method: "POST" });
    const before = requests.length;
    emit("focus");
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(requests).toHaveLength(before);
    await client.api("/api/auth/login", { body: { username: "next" } });
    await settle();
    expect(requests).toHaveLength(before + 1);
  });

  it("stops retries after an unauthenticated sync response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({}, 401) as Response);
    client.useSync(vi.fn(), true);
    emit("pointerdown");
    await vi.advanceTimersByTimeAsync(HOUR);
    emit("focus");
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(location.href).toBe("/login");
  });
});


describe("other background requests", () => {
  it.each([true, false])("pauses notification test checks with hidden=%s", async (hidden) => {
    vi.spyOn(client, "useMe").mockReturnValue(null);
    const push = await import("../push-client");
    vi.spyOn(push, "devicePushStatus").mockResolvedValue({ status: "off", id: null });
    hooks.initialValues = [null, null, null, "", false, 7];
    page.hidden = hidden;
    const { NotificationSettingsCard } = await import("../../components/notification-settings");
    NotificationSettingsCard();
    await vi.advanceTimersByTimeAsync(HOUR);
    const testRequests = () => vi.mocked(fetch).mock.calls.filter(([path]) => path === "/api/push/test?id=7");
    const settingsRequests = () => vi.mocked(fetch).mock.calls.filter(([path]) => path === "/api/notification-settings");
    expect(testRequests()).toHaveLength(hidden ? 0 : 1);
    expect(settingsRequests()).toHaveLength(hidden ? 0 : 1);
    if (hidden) {
      page.hidden = false;
      emit("visibilitychange");
    } else emit("focus");
    await vi.advanceTimersByTimeAsync(100);
    expect(testRequests()).toHaveLength(hidden ? 1 : 2);
  });

  it("disables speculative navigation requests on client links", () => {
    const links: string[] = [];
    function checkDirectory(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) checkDirectory(path);
        else if (entry.name.endsWith(".tsx")) {
          const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
          function visit(node: ts.Node) {
            if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(file) === "Link") {
              links.push(path);
              const prefetch = node.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === "prefetch");
              expect(prefetch?.getText(file), path).toBe("prefetch={false}");
            }
            ts.forEachChild(node, visit);
          }
          visit(file);
        }
      }
    }
    checkDirectory("src/app");
    checkDirectory("src/components");
    expect(links.length).toBeGreaterThan(30);
  });
});
