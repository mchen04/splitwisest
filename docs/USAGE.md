# Using SplitWisest

## Getting in

- **Sign up** with a display name, username, and password. An invite code is optional; a friend's personal code makes you friends immediately, and a group code joins that group.
- **Invite a friend** from the Balances page — **Copy link** shares a sign-up link that connects them to you automatically. You can also add someone by entering their invite code.
- **Forgot your password?** Use the "Forgot your password?" link on login and one of your recovery codes (generate these in Settings) to set a new one.

## Account & settings

- **Settings** (gear icon / profile in the sidebar) lets you change your display name and username, change your password (requires your current one), generate one-time **recovery codes**, and log out.
- **Recovery codes** are shown once when generated — store them safely. Each works a single time and regenerating invalidates the old set.

## Friend requests

- **Adding a friend by code** sends a **pending request**; you become friends only once they **accept** it (Balances → Friend requests). You can cancel a request you sent, and accept or decline ones you receive. If you both request each other, the friendship is created automatically.
- **Group invites stay open**: anyone with a group's invite code can join directly (no approval step), and joining a group makes everyone in it friends. This keeps group onboarding frictionless while friend connections stay consent-based.

## Groups

- **Create a group** (Groups → New group) for any shared context: a trip, an apartment, a dinner crew. Pick the group currency — balances display in it.
- **Invite friends** to a group from the group menu (**⋯ → Copy invite link**). Joining a group makes everyone in it friends.

## Expenses

- Use **Add expense** from any page. The current group opens directly.
- Outside a group, one group opens directly. Multiple groups show a picker.
- Enter the amount and description. The payer defaults to you, and the date defaults to local today.
- **Paid by**, **Date**, and **Category** stay visible. **Split** keeps less common choices under **Change**.
- The default split assigns the full amount to one other member.
- Choose Equal, Exact, Percentages, Shares, or Itemized when needed.
- The form shows each share and reports whether the split matches the total.
- Use **New category** beside Category. Enter adds the category without submitting the expense.
- Notes and receipts stay under **Add note or receipt**.
- A save error keeps the form and its values open. Offline errors ask you to reconnect.
- **Edit or delete** any expense with the pencil/trash icons. Balances update for everyone instantly.
- **Recurring**: set up weekly/monthly expenses (rent, subscriptions); they post automatically.

## Who owes who

- Open a group’s **Balances** tab and choose **Add group balance** to record shared obligations.
- Enter a description and total in the group currency. Choose who owes and who should receive.
- Split each side by Equal, Exact amounts, Percentages, or Shares. Enter a value for every selected person with a weighted method. Zero is allowed. Both sides must match the total.
- The preview shows each person’s net change and the resulting group debts before you save. On edit, it includes people removed from the new split.
- If another member changes the group before you save, the form stays open and refreshes the group balance preview. Review it before retrying. If the entry you are editing changed, the preview and Save action stop until you close and reopen it.
- One person can appear on both sides. Only the difference changes their balance.
- Edit or delete a group balance from the same tab. This does not record a payment.
- Before removing a member, edit or delete every group balance that includes them. This also applies to zero shares and net-zero entries.
- The **group balance strip** shows each member's net. **Suggested settle-up** shows the fewest payments that clear the group.
- The **Balances page** shows every friend relationship across all groups and what should happen next.
- **Settle up** records an offline payment (cash, bank transfer — whatever you used). SplitWisest never moves money.

## Finding things

- **Expenses page** searches across all groups; filter by group, friend, category, payer, and date range.
- **CSV export** from the group menu (⋯).
- **Insights** charts use the full group history. Expense filters and loaded pages do not limit them.

## Chat

Each group has a chat tab; each friend has a direct chat. The **Chat** nav item lists every conversation. Messages and balances update live for everyone viewing — no refresh needed. Long histories load the newest messages first with a "Load earlier messages" affordance.

On phones, scroll inside the message list to read history. Search, the message field, and Send stay visible. The bottom navigation hides while you write a message. The page itself does not scroll while a conversation is open.

## Install on iPhone

Open the deployed site in Safari. Use **Share → Add to Home Screen**.

Turn on **Open as Web App** when Safari shows that option. Then launch SplitWisest from its Home Screen icon.

The bottom navigation and modal actions stay above the Home indicator.

For release verification, follow `docs/PWA.md`.

## Staying on top of things

- **Unread badges** on the Chat, Activity, and Balances nav items show new messages, new activity, and pending settle-up nudges. A badge clears once you view the relevant screen.
- **Activity** has its own nav page with the full cross-group feed (paged with "Load more").
- **Expense details**: tap an expense to open a read-only view — payer, split breakdown, notes, inline receipt previews, and a **per-expense comment thread**. Edit/Delete are available from there too.
- **Settle-up reminders**: on Balances, **Remind** a friend who owes you to settle up. They see it as a reminder (and an unread badge) until they dismiss it.

## Pagination

Expenses, group balances, settlements, activity, and chat all load a bounded first page and fetch more on demand ("Load more" / "Load earlier"), so large groups stay fast.
