# iPhone PWA verification

SplitWisest supports Safari and an installed iPhone Home Screen app. The installed app is the release target for safe areas and keyboard layout.

## Layout contract

The app is a locked frame, not a scrolling document. `.app-frame` covers the
visible viewport, `.app-scroll` is the only region that scrolls, and the bottom
navigation is the frame's last row. Navigation is therefore in normal flow. It
was `position: fixed` before, which let iOS place it differently on routes that
scroll than on routes that fit in one screen.

- The viewport uses `viewport-fit=cover`.
- The document never scrolls. `document.scrollHeight` equals `window.innerHeight`.
- Bottom navigation includes the iPhone bottom inset and a small lift.
- Mobile modal sheets include the bottom inset.
- Confirmation toasts sit above the bottom navigation and the inset.
- Bottom navigation sits at the same y on every route.
- No route carries a page title row.
- Chat fills the visible viewport without page scrolling.
- The message list keeps its own vertical scroll.
- Search, the composer, Send, and navigation stay visible.
- Sending clears the draft without moving the page.
- Shared mobile controls use a 44 px minimum height, and so does every control on a
  touch-first screen (`pointer: coarse`) at any width.
- Tapping Send keeps focus in the message field, so the navigation does not
  reappear mid-tap and move Send out from under the finger.

## Local checks

Run the permanent source checks first:

```bash
pnpm vitest run src/lib/__tests__/mobile-shell.test.ts
pnpm vitest run src/lib/__tests__/draft-guard.test.ts src/lib/__tests__/theme.test.ts
pnpm exec tsc --noEmit
pnpm lint
pnpm build
```

Check desktop WebKit and phone widths of 320, 390, and 393 pixels. An iPhone WebKit profile tests layout emulation.
It does not prove native Safari, an installed PWA, or a physical phone. Check those separately.

Set `navigator.standalone` to `true` before navigation. Use a long conversation, then verify these values:

- The user agent contains `iPhone`.
- The viewport meta tag contains `viewport-fit=cover`.
- Document and body heights equal `window.innerHeight`.
- `document.scrollHeight` equals `window.innerHeight` on every route.
- The bottom navigation's top edge is the same value on every route.
- `window.scrollY` stays at zero.
- The message list uses `overflow-y: auto` and has overflow content.
- The composer and Send bottom edges stay above the navigation top edge.
- A 34 px test inset produces 38 px bottom navigation padding.
- A modal panel includes the simulated bottom inset.

Verify the expense flow at each size:

- Payer, date, and category appear without opening Split.
- Payer defaults to the current user. Date uses local today. Category defaults to none.
- Tab stays inside the modal and skips hidden or disabled controls.
- A failed save keeps the modal open and preserves every value.
- A second click cannot submit while the first save runs.
- Group tabs and menus support arrow keys, Home, End, and Escape.
- Open the Balances tab and check the group balance preview, save action, and scrolling at phone widths.

Take a viewport screenshot before the browser closes. Keep screenshots outside the repository.

## Physical iPhone release gate

Use the deployed HTTPS URL.

1. Open the site in Safari.
2. Use **Share → Add to Home Screen**.
3. Turn on **Open as Web App** when Safari shows that option.
4. Close Safari.
5. Launch SplitWisest from the Home Screen icon.
6. Open a long direct or group conversation.
7. Scroll message history to both ends.
8. Focus the message field and show the keyboard.
9. Confirm the message field and Send stay visible, and the bottom navigation hides.
10. Send a message without scrolling the page.
11. Confirm bottom navigation stays above the Home indicator.
12. Open Add expense and confirm its actions stay above the Home indicator.

Test portrait and landscape. Repeat once with increased text size if the release changes mobile spacing.

## Update and cache contract

Every deploy ships a byte-different `/sw.js`: `pnpm build` runs
`scripts/generate-sw.ts`, which writes `public/sw.js` (gitignored) from
`src/sw/sw.template.js` with the deployment id embedded. The worker script, the
client bundle (`NEXT_PUBLIC_BUILD_ID`), `/api/version`, and the `x-build-id`
response header all derive from one id in `src/lib/deployment-id.ts`.

The browser's own service-worker update algorithm is the update mechanism:
`registration.update()` fetches `/sw.js` (served `Cache-Control: no-cache`),
new bytes install, `skipWaiting` + `clients.claim` fire `controllerchange`, and
the client reconciles. Detection runs on resume and connectivity signals —
`visibilitychange`, `pageshow` (including back/forward-cache restores),
`online`, history changes (soft navigations), and a 60 s interval as backstop.

One function decides what happens: `decideUpdateAction` in
`src/lib/update-policy.ts`. It reloads at most once per detected version,
never reloads a first install, never reloads a page already on the server's
build, stops instead of looping when a reload fails to land, and defers while
a form holds changed text, selects, checkboxes, radios, or stateful buttons.

Caching (`src/sw/sw.template.js`):

- Navigations are network-first with a 3.5 s timeout, falling back to the page
  cache, then the cached start_url shell, then `offline.html`. The first
  navigation after a deploy therefore carries the new build.
- The offline page follows the saved or system theme and includes safe-area padding.
- `/_next/static/` files are cache-first (content-hashed, immutable). They are
  never purged by a version bump; stale-build files are swept only once every
  open window reports it runs the current build.
- RSC payloads (`?_rsc=`) are never cached, and a payload the server minted
  for a different build is refused so the router hard-navigates instead of
  mixing builds.
- `/api/**` is never touched by the worker.
- Both runtime caches are entry-bounded; cached entries carry build tags in
  the meta cache.

## Two-build verification

`node scripts/pwa-swap-harness.mjs all` (or `build` then `suite`) runs the
whole contract against two local production builds differing only in
GITHUB_SHA, swapped on one origin behind a local TLS proxy, driven as an
INSTALLED app: Playwright WebKit, iPhone profile, `navigator.standalone`,
display-mode standalone, launched at the manifest start_url, logged in.
This is installed-mode emulation, not an installed PWA on a physical device.
Scenarios cover first install, cold start, cold start across a swap,
foreground-resume across a swap, in-session navigation across a swap,
three-cycle reload stability, offline cold start, and poisoned-cache repair.
Negative controls — `--mutate no-swap | break-manifest | no-sw | flap-sw |
flap-version-no-sw | break-precache | swallow-precache | bloat-storage` — each
force a named check red. The harness writes temporary data under `.pwa-harness`.

Remove `.pwa-harness`, generated `public/sw.js`, and test screenshots after verification.
See `docs/pwa-cache-ledger.md` for measured results.
