# PWA verification

## Mobile layout

On phones, `.app-frame` fills the visible viewport.
`.app-scroll` owns page scrolling; chat instead scrolls its message list inside `.app-fixed`.
Bottom navigation stays in the frame's normal flow and includes the safe-area inset.
It hides while the chat composer has focus.
Modal panels include the bottom inset, and toasts sit above navigation.
Login, signup, and recovery remain scrollable outside the app frame.

Check phone widths of 320, 390, and 393 pixels.
Use long names, a long conversation, and increased text size.
Confirm that fields, labels, actions, and navigation remain reachable.
A reduced viewport tests available space but does not open a native phone keyboard.

## Updates and caching

`pnpm build` generates the ignored `public/sw.js` from `src/sw/sw.template.js`.
The worker, client bundle, `/api/version`, and `x-build-id` header share one deployment ID.
The ID uses `VERCEL_GIT_COMMIT_SHA`, then `GITHUB_SHA`, then a local source hash.
The worker script revalidates so new bytes trigger an update.
The client checks for updates on resume, online events, navigation, and a 60-second interval.

`decideUpdateAction` prevents repeated reloads for the same build.
It avoids reloads on first installation or when the page already uses the server build.
Changed form text or choices defer a reload.
Expense, chat, and comment drafts use per-account browser storage.
Expense drafts do not retain receipt files.

| Resource | Cache behavior |
|---|---|
| Page navigation | Network first, with a 3.5-second timeout; fallback to the cached page, start page, then offline page. |
| Content-hashed static files | Cache first; remove stale build files after all open windows report the current build. |
| Public page fragments | Separate cache per build; reuse only while public freshness headers remain valid. |
| Private fragments | Never cache. |
| API responses | Never intercept or cache. |

Fragment caching requires a successful prerendered response from the same build.
Private, no-store, no-cache, Set-Cookie, and cookie-varying responses cannot enter it.
Requests with Authorization cannot use it.
A fragment from another build fails so the router can load a full page.
Caches have entry limits: 24 pages, 150 static files, and 150 fragments per build.
The offline page follows the saved or system theme.

## Two-build verification

Start the [local database](DATABASE.md#local-setup) and export its connection values.
The harness builds two versions and serves them on one local HTTPS origin.
It uses WebKit with an iPhone profile and standalone-mode emulation.
It tests first install, cold starts, resume, navigation, repeated swaps, offline fallback, and damaged caches.

```sh
node scripts/pwa-swap-harness.mjs all
node scripts/pwa-swap-harness.mjs suite --mutate no-swap
```

The normal run must pass; the no-swap control must fail.
Other controls include break-manifest, no-sw, flap-sw, flap-version-no-sw, break-precache, swallow-precache, and bloat-storage.
Keep failed controls separate from passing evidence.
The harness writes temporary builds and output under `.pwa-harness/`.
Remove its temporary files and generated worker after review.

## Form and overflow checks

Create three synthetic accounts and a shared USD group through a disposable local app.
Keep fixtures and evidence outside the checkout.
Put the first account's username and password in `fixture-secrets.json`.
Put the group ID in `fixture.json`, for example `{"groupId": 1}`.
Use local HTTPS for a production server because its session cookie requires Secure.

```sh
MOBILE_ORIGIN=https://127.0.0.1:3148 \
MOBILE_FIXTURE_DIR=/absolute/path/to/local-fixture \
MOBILE_EVIDENCE_DIR=/absolute/path/to/evidence/webkit \
node scripts/verify-mobile-overflow.mjs
```

Repeat with `MOBILE_ENGINE=chromium` and a separate evidence directory.
The check saves real fixture expenses and creates categories.
It covers date controls, splits, recurring forms, payments, settings, navigation, and chat Send.
The default run permits service workers and fails on browser runtime errors.
`MOBILE_SERVICE_WORKERS=block` isolates layout for diagnosis; it does not prove worker behavior.
Check keyboard reachability as well as screenshots.
WebKit uses Option-Tab to include buttons in keyboard navigation.

For draft and theme changes, run the focused checks:

```sh
pnpm exec vitest run src/lib/__tests__/draft-guard.test.ts src/lib/__tests__/theme.test.ts
```

## Physical iPhone check

Use the deployed HTTPS app and synthetic data.

1. Add the app to the Home Screen from Safari.
2. Enable Open as Web App if offered.
3. Launch the Home Screen app in portrait and landscape.
4. Open a long conversation and scroll both ways.
5. Focus the composer and confirm that the keyboard leaves Send reachable.
6. Send a message and confirm that the page does not scroll.
7. Dismiss the keyboard and check navigation above the Home indicator.
8. Open an expense form and check its fields and actions above the Home indicator.
9. Repeat with larger text after changes to mobile spacing.

Desktop emulation does not prove native Safari, installed-app behavior, or physical keyboard layout.
See [notification checks](NOTIFICATIONS.md#verification) for background alerts and tap destinations.
