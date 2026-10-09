# Using SplitWisest

## Getting in

- **Sign up** with a display name, username, and password. An invite code is optional; a friend's personal code makes you friends immediately, and a group code joins that group.
- **Invite a friend** from the Balances page — **Copy invite link** shares a sign-up link that connects them to you automatically. You can also add someone by entering their invite code with **Add friend**.
- **Forgot your password?** Use the "Forgot your password?" link on login and one of your recovery codes (generate these in Settings) to set a new one.

## Account & settings

- **Settings** (gear icon / profile in the sidebar) lets you change your display name and username, change your password (requires your current one), generate one-time **recovery codes**, and log out.
- **Recovery codes** are shown once when generated — store them safely. Each works a single time and regenerating invalidates the old set.

## Friend requests

- **Adding a friend by code** sends a **pending request**; you become friends only once they **accept** it (Balances → Requests and reminders). You can cancel a request you sent, and accept or decline ones you receive. If you both request each other, the friendship is created automatically.
- **Group invites stay open**: anyone with a group's invite code can join directly (no approval step), and joining a group makes everyone in it friends. This keeps group onboarding frictionless while friend connections stay consent-based.

## Groups

- **Create a group** (Groups → New group) for any shared context: a trip, an apartment, a dinner crew. Pick the group currency — balances display in it. **Join with code** joins someone else's group.
- **Invite friends** to a group from the group menu (**⋯ → Copy invite link**). A confirmation shows when the link is copied. Joining a group makes everyone in it friends.
- A group has five sections on every screen size: **Expenses**, **Balances**, **Chat**, **Activity**, and **Insights**.

## Expenses

- Use **Add expense** from any page. Inside a group, the form opens for that group.
- Outside a group, the form opens in place for the group you last added to on this device, or your only group. You can switch the group at the top of the form. The first time, with several groups, a picker comes first. The page you were on stays open, and a confirmation links to the group.
- Enter the amount and description. On a computer the amount field is ready to type, and Return moves to the description. The payer defaults to you, and the date defaults to local today.
- **Paid by**, **Date**, and **Category** stay visible.
- The default split (**One person**) assigns the full amount to one other member.
- Choose Equal, Exact amounts, Percentages, Shares, or Itemized bill when needed.
- The form shows each share and reports whether the split matches the total.
- Use **New category** beside Category. Enter adds the category without submitting the expense.
- Notes and receipts stay under **Add note or receipt**.
- A save error keeps the form and its values open. Offline errors ask you to reconnect.
- **Edit or delete** any expense with the pencil/trash icons, or from its details. Balances update for everyone instantly. Deleting asks for confirmation.
- **Recurring**: set up weekly/monthly expenses (rent, subscriptions) with **Recurring** on the group's expense list (also in the group menu); they post automatically.

## Who owes who

- Open a group’s **Balances** tab and choose **Add group balance** to record shared obligations.
- Enter a description and total in the group currency. Choose who owes and who should receive.
- Split each side by Equal, Exact amounts, Percentages, or Shares. Enter a value for every selected person when using Exact amounts, Percentages, or Shares. Zero is allowed. Both sides must match the total.
- Percentages and Shares allow up to seven decimal places. Percentages must add up to exactly 100% at that precision.
- The preview shows each person’s net change and the resulting group debts before you save. On edit, it includes people removed from the new split.
- The resulting debts update after another member adds an expense or changes a group balance.
- If the group changes while you edit, the preview refreshes. Review the new debts before saving. If someone changes or deletes that group balance, close and reopen it before editing again.
- While an open edit checks for changes, its preview and Save action pause. A failed check shows Try again.
- One person can appear on both sides. Only the difference changes their balance.
- Edit or delete a group balance from the same tab. This does not record a payment.
- If the group balance list fails to load, choose **Try again** on the Balances tab.
- A group balance form stays open while its save is in progress.
- If a save response is lost, retry the same entry. The app keeps its create request ID and does not add a second entry. Changing the entry starts a new request.
- Before removing a member, edit or delete every group balance that includes them. This also applies to zero shares and net-zero entries.
- **Who owes who** shows the fewest payments that clear the group. Each member's net shows in the members list on wide screens and under **Member balances** on the Balances tab on phones and tablets.
- The group's **Settle up** opens your suggested payment ready to record. With several, it lists them; **Record a different payment** opens a blank form.
- **Home** lists every open balance under **Settle up**. Each balance you owe has its own **Settle up**; a friend who owes you has **Remind**.
- The **Balances page** shows every friend relationship across all groups, with the same actions, plus requests and reminders. A reminder from someone you owe has **Settle up** on it.
- **Settle up** records an offline payment (cash, bank transfer — whatever you used). SplitWisest never moves money.

## Finding things

- **Expenses page** searches across all groups; filter by group, friend, category, and date range. On phones, open it with the search icon on Home; **Filters** shows the filters.
- In the **Activity** feed, a group name opens that group's activity.
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

- **Unread badges** on the Chat, Activity, and Balances nav items show new messages, new activity, and pending settle-up nudges. A badge clears once you view the relevant screen. On phones, Home carries the search, notifications, and account buttons.
- **Activity** has its own nav page with the full cross-group feed (paged with "Load more").
- **Expense details**: tap an expense to open a read-only view — payer, split breakdown, notes, inline receipt previews, and a **per-expense comment thread**. Edit and Delete stay pinned at the bottom of the details.
- **Settle-up reminders**: on Home or Balances, **Remind** a friend who owes you to settle up. They see it as a reminder (and an unread badge) until they dismiss it.
- **Confirmations** appear briefly at the bottom of the screen (above the navigation on phones) after you add, change, or delete something.

## Pagination

Expenses, group balances, settlements, activity, and chat all load a bounded first page and fetch more on demand ("Load more" / "Load earlier"), so large groups stay fast.
