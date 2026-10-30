import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { handler } from "@/lib/api";

export function privateJson(req: Request | undefined, value: unknown) {
  const body = JSON.stringify(value);
  const digest = createHash("sha256")
    .update(req?.headers.get("cookie") ?? "")
    .update("\0")
    .update(body)
    .digest("base64url");
  const tag = `"${digest}"`;
  const headers = {
    "Cache-Control": "private, no-cache",
    "Content-Type": "application/json",
    ETag: `W/${tag}`,
    Vary: "Cookie",
  };
  return new NextResponse(body, { headers });
}

export function privateHandler<T extends unknown[]>(fn: (...args: T) => Promise<NextResponse | Response>) {
  const wrapped = handler(fn);
  return async (...args: T): Promise<NextResponse | Response> => {
    const response = await wrapped(...args);
    const req = args[0];
    const tag = response.headers.get("etag")?.replace(/^W\//, "");
    if (response.status !== 200 || !tag || !(req instanceof Request)) return response;
    const matches = req.headers.get("if-none-match")?.split(",")
      .some((item) => item.trim() === "*" || item.trim().replace(/^W\//, "") === tag);
    return matches ? new NextResponse(null, { status: 304, headers: response.headers }) : response;
  };
}
