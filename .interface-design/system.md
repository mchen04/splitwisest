# Interface rules

## Foundation

Use flat neutral surfaces, sans-serif text, and a restrained green accent.
Keep color, type, spacing, control size, and elevation tokens in `src/app/globals.css`.
Use named tokens in components; the Avatar uses a deterministic HSL hue.
Dark mode changes the same token names and raises card lightness above the canvas.
The saved theme wins; without a saved choice, follow the system theme.

Use `accent` for primary actions, links, and active navigation.
Use `owed` for positive balances, `owe` for debts, and `danger` for destructive actions.
Pair money colors with a sign or words so color never carries meaning alone.
Use `tnum` for money and aligned numbers.

Instrument Sans serves text and money.
Fraunces serves only the wordmark.
Use type roles outside `src/components/ui.tsx`:

| Role | Purpose |
|---|---|
| `text-meta` | Timestamps, counts, and helper text. |
| `text-body` | Labels, buttons, and secondary text. |
| `text-row` | Row titles, larger on phones. |
| `text-section` | Card and section headings. |
| `text-title` | Group, person, and dialog names. |
| `text-amount` | Balances. |
| `text-amount-lg` | Amount fields and Home currency totals. |
| `text-hero` | The main Home balance on wider screens. |

## Controls

Reuse the primitives in `src/components/ui.tsx`.
Standard controls use `--control-h`; compact controls use `--control-h-sm`.
Both become 44 pixels on phones and touch-first screens.
Use the shared radius, focus-ring, and shadow tokens.
Cards size to their content.

Icon-only controls need an accessible name.
Menus support arrows, Home, End, Escape, and focus return.
Button radios use `radioGroupKeyDown` and `radioTabIndex` for one Tab stop and arrow-key selection.
Use in-app confirmation dialogs and status toasts.
Place each action beside the item or balance it affects.

Modals become bottom sheets on phones and include the safe-area inset.
Focus skips hidden and disabled controls and returns to the opener on close.
Desktop dialogs focus their `data-autofocus` control; touch dialogs focus the panel.
Long forms keep actions in a sticky footer.

Keep expense payer, date, and category visible.
Default the payer to the current user, the date to local today, and the category to none.
Keep notes and receipts in a disclosure.
Preserve typed values after a failed save.
Keep loading, empty, and failed states distinct.
Show a retry action for failed reads and writes.

## Layout

The sidebar appears from 768 pixels and owns the persistent Add expense action.
Phones use a fixed app frame with bottom navigation.
Only its content region scrolls; chat scrolls its own message list.
Navigation hides while the chat composer has focus.
Login, signup, and recovery can scroll outside this frame.
See [PWA checks](../docs/PWA.md#mobile-layout).

Group pages show Expenses, Balances, Chat, Activity, and Insights at every width.
The member rail and dense two-column layouts begin at 1024 pixels.
Below that width, group member nets appear in Balances.
Group switchers and tabs support arrow keys.
Keep friend balances on separate lines so names, group labels, and amounts remain readable.

## Enforcement

Run `pnpm verify:ui-tokens` after UI changes.
It rejects arbitrary pixel classes, numeric text sizes and radii, and hard-coded component hex colors.
It rejects raw type sizes outside shared primitives and `text-lg` throughout components.
Each grid needs a base column template.
Radio groups and options need their shared keyboard helpers.
Use [browser checks](../docs/PWA.md) to verify layout and reachability beyond token checks.
