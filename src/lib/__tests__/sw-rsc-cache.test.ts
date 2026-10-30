import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const origin = "https://fixture.example";
const build = "__BUILD_ID__";

function response(headers: Record<string, string> = {}, body = "public shell") {
  const result = new Response(body, { headers: {
    "content-type": "text/x-component",
    date: new Date().toUTCString(),
    "cache-control": "s-maxage=31536000",
    "x-nextjs-prerender": "1",
    "x-build-id": build,
    vary: "RSC, Next-Router-State-Tree, Next-Router-Prefetch, Next-Router-Segment-Prefetch",
    ...headers,
  } });
  Object.defineProperty(result, "type", { value: "basic" });
  return result;
}

function worker() {
  const listeners = new Map<string, (event: object) => void>();
  const stores = new Map<string, { request: Request; response: Response }[]>();
  const caches = {
    async keys() { return [...stores.keys()]; },
    async delete(name: string) { return stores.delete(name); },
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, []);
      const entries = stores.get(name)!;
      const matches = (entry: typeof entries[number], request: Request) => entry.request.url === request.url
        && (entry.response.headers.get("vary") || "").split(",").filter(Boolean)
          .every(header => entry.request.headers.get(header.trim()) === request.headers.get(header.trim()));
      return {
        async match(request: Request) { return entries.find(entry => matches(entry, request))?.response.clone(); },
        async put(request: Request, result: Response) {
          const index = entries.findIndex(entry => matches(entry, request));
          if (index !== -1) entries.splice(index, 1);
          entries.push({ request: request.clone(), response: result });
        },
        async keys() { return entries.map(entry => entry.request); },
        async delete(request: Request) {
          const index = entries.findIndex(entry => matches(entry, request));
          if (index !== -1) entries.splice(index, 1);
          return index !== -1;
        },
      };
    },
  };
  const fetch = vi.fn(async () => response());
  vm.runInNewContext(readFileSync("src/sw/sw.template.js", "utf8"), {
    self: { location: { origin }, clients: { matchAll: async () => [{ id: "old-client" }], claim: async () => {} }, addEventListener: (name: string, listener: (event: object) => void) => listeners.set(name, listener) },
    caches, fetch, URL, Request, Response, AbortController, setTimeout, clearTimeout,
  });
  async function request(path = "/groups/1?_rsc=tree", headers: Record<string, string> = {}, clientId = "current") {
    const pending: Promise<unknown>[] = [];
    let result: Promise<Response> | undefined;
    listeners.get("fetch")!({ request: new Request(origin + path, { headers: { RSC: "1", ...headers } }), clientId,
      respondWith: (value: Promise<Response>) => { result = value; }, waitUntil: (value: Promise<unknown>) => pending.push(value) });
    const resolved = await result;
    await Promise.all(pending);
    return resolved;
  }
  return { request, fetch, stores, listeners, caches };
}

describe("public RSC cache", () => {
  it("reuses a public prerendered payload within the same build", async () => {
    const w = worker();
    expect(await (await w.request())!.text()).toBe("public shell");
    expect(await (await w.request())!.text()).toBe("public shell");
    expect(w.fetch).toHaveBeenCalledTimes(1);
  });

  it.each<Record<string, string>>([
    { "cache-control": "private, s-maxage=60" },
    { "cache-control": "no-store, s-maxage=60" },
    { "cache-control": "no-cache, s-maxage=60" },
    { "cache-control": "s-maxage=0" },
    { "cache-control": "max-age=60" },
    { "cache-control": "s-maxage=60", date: "Thu, 01 Jan 1970 00:00:00 GMT" },
    { "cache-control": "s-maxage=60", age: "60" },
    { date: "" },
    { "x-nextjs-prerender": "" },
    { "content-type": "text/html" },
    { vary: "*" },
    { vary: "RSC, Cookie" },
    { vary: "Authorization" },
    { "set-cookie": "session=private" },
  ])("never stores a non-public shell: %j", async headers => {
    const w = worker();
    w.fetch.mockImplementation(async () => response(headers));
    await w.request();
    await w.request();
    expect(w.fetch).toHaveBeenCalledTimes(2);
  });

  it("refetches a cached payload after its shared freshness expires", async () => {
    const w = worker();
    await w.request();
    for (const entry of [...w.stores.values()].flat()) entry.response.headers.set("date", "Thu, 01 Jan 1970 00:00:00 GMT");
    await w.request();
    expect(w.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["redirected", "partial"])("does not cache a %s response", async kind => {
    const w = worker();
    w.fetch.mockImplementation(async () => {
      const result = response();
      Object.defineProperty(result, kind === "redirected" ? "redirected" : "status", { value: kind === "redirected" ? true : 206 });
      return result;
    });
    await w.request();
    await w.request();
    expect(w.fetch).toHaveBeenCalledTimes(2);
  });

  it("deletes older build caches while preserving current and unrelated caches", async () => {
    const w = worker();
    await w.caches.open("splitwisest-rsc-v1-old");
    await w.caches.open("unrelated");
    await w.request();
    let pending: Promise<unknown> | undefined;
    w.listeners.get("activate")!({ waitUntil: (value: Promise<unknown>) => { pending = value; } });
    await pending;
    expect(await w.caches.keys()).not.toContain("splitwisest-rsc-v1-old");
    expect(await w.caches.keys()).toContain(`splitwisest-rsc-v1-${build}`);
    expect(await w.caches.keys()).toContain("unrelated");
  });

  it("keeps router variants and URLs distinct", async () => {
    const w = worker();
    await w.request(undefined, { "Next-Router-State-Tree": "first" });
    await w.request(undefined, { "Next-Router-State-Tree": "second" });
    await w.request("/groups/2?_rsc=tree");
    await w.request(undefined, { "Next-Router-State-Tree": "first" });
    expect(w.fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects a payload from another build", async () => {
    const w = worker();
    w.fetch.mockImplementation(async () => response({ "x-build-id": "different" }));
    expect((await w.request())!.type).toBe("error");
    expect([...w.stores.values()].flat()).toHaveLength(0);
  });

  it("keeps old clients on the network after an update", async () => {
    const w = worker();
    await w.request();
    w.listeners.get("message")!({ data: { type: "CLIENT_READY", build: "old" }, source: { id: "old-client" }, waitUntil: () => {} });
    expect((await w.request(undefined, {}, "old-client"))!.type).toBe("error");
    expect(w.fetch).toHaveBeenCalledTimes(2);
  });

  it("bypasses authenticated API requests and explicit authorization", async () => {
    const w = worker();
    expect(await w.request("/api/groups/1")).toBeUndefined();
    expect(w.fetch).not.toHaveBeenCalled();
    await w.request(undefined, { Authorization: "Bearer fixture" });
    await w.request(undefined, { Authorization: "Bearer fixture" });
    expect(w.fetch).toHaveBeenCalledTimes(2);
  });

  it("bounds stored router variants", async () => {
    const w = worker();
    for (let i = 0; i < 151; i++) await w.request(`/groups/${i}?_rsc=tree`);
    expect([...w.stores.values()].flat()).toHaveLength(150);
    await w.request("/groups/0?_rsc=tree");
    expect(w.fetch).toHaveBeenCalledTimes(152);
  });

  it("keeps fetching when cache storage is unavailable", async () => {
    const w = worker();
    vi.spyOn(w.caches, "open").mockRejectedValue(new Error("storage unavailable"));
    expect(await (await w.request())!.text()).toBe("public shell");
    expect(await (await w.request())!.text()).toBe("public shell");
    expect(w.fetch).toHaveBeenCalledTimes(2);
  });

  it("propagates network failures without storing a response", async () => {
    const w = worker();
    w.fetch.mockRejectedValue(new Error("offline"));
    await expect(w.request()).rejects.toThrow("offline");
    expect([...w.stores.values()].flat()).toHaveLength(0);
  });
});
