"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiClientError } from "@/lib/client";
import { Button, Field, Input, ErrorNote } from "@/components/ui";
import { AuthFrame } from "@/components/auth-frame";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { body: { username, password } });
      const next = new URLSearchParams(window.location.search).get("next") ?? "";
      router.push(/^\/notifications(?:\/\d+)?$/.test(next) ? next : "/");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not log in");
      setBusy(false);
    }
  }

  return (
    <AuthFrame>
      <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mt-1 text-sm text-ink-soft">Log in to pick up where your group left off.</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <Field label="Username">
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <ErrorNote message={error} />
        <Button type="submit" busy={busy} className="w-full">
          Log in
        </Button>
      </form>
      <div className="mt-4 flex items-center justify-between text-sm">
        <Link href="/recover" className="whitespace-nowrap text-ink-soft hover:text-accent">
          Forgot password?
        </Link>
        <Link href="/signup" className="whitespace-nowrap font-semibold text-accent hover:text-accent-dark">
          Create account
        </Link>
      </div>
    </AuthFrame>
  );
}
