import { beforeEach, describe, expect, it, vi } from "vitest";

const after = vi.fn();
vi.mock("@/lib/db", () => ({ sql: vi.fn().mockResolvedValue([]) }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after }));

const { handler } = await import("../api");
const { AuthError } = await import("../auth");

const ok = handler(async (_req: Request) => new Response("{}", { status: 200 }));
const denied = handler(async (_req: Request) => new Response("{}", { status: 403 }));
const anonymous = handler(async (_req: Request): Promise<Response> => { throw new AuthError(); });
const get = (path: string) => new Request(`https://app.example${path}`);

describe("delivery after a response", () => {
  beforeEach(() => { after.mockClear(); vi.stubEnv("VAPID_PUBLIC_KEY", "key"); });

  it.each(["/api/groups/7", "/api/groups/7/expenses", "/api/groups/7/version"])("runs after a successful GET %s", async (path) => {
    await ok(get(path));
    expect(after).toHaveBeenCalledTimes(1);
  });

  it.each(["/api/sync", "/api/groups/7/group-balances", "/api/groups/abc/version", "/api/groups/7/version/x"])(
    "skips other reads such as %s", async (path) => {
      await ok(get(path));
      expect(after).not.toHaveBeenCalled();
    });

  it("skips denied and unauthenticated version checks", async () => {
    await denied(get("/api/groups/7/version"));
    await anonymous(get("/api/groups/7/version"));
    expect(after).not.toHaveBeenCalled();
  });

  it("skips delivery when push is not configured", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "");
    await ok(get("/api/groups/7/version"));
    expect(after).not.toHaveBeenCalled();
  });
});
