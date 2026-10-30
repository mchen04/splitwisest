# Architecture

## Boundaries and access

Pages and components fetch JSON from API routes.
`src/lib/` holds shared business rules and database access.
API routes check sessions and group membership or friendship before returning private data.
The delivery endpoint uses a scheduler secret instead of a user session.

Passwords use scrypt hashes with random salts.
Sessions use random 32-byte tokens and expire after 30 days.
The session cookie uses HttpOnly and SameSite=Lax; production also uses Secure.
Missing or malformed session tokens fail before a database query.
A valid token has 64 lowercase hexadecimal characters.
Well-formed unknown tokens still require an authentication query.

Login, signup, and recovery replace the browser's previous session.
Recovery consumes a code, changes the password, and revokes the account's sessions in one statement.
Authentication routes apply database rate limits by account and IP.
The shared route wrapper rejects unsafe requests when their Origin host differs from the request Host.
It permits clients that omit Origin.

## Money rules

Store amounts as integer cents.
JPY and KRW use multiples of 100 cents, so splits never produce fractional currency units.
Expense splits use largest remainders to keep the shares equal to the total.
Each expense stores its original amount, group-currency amount, and exchange-rate snapshot.
Later rate changes do not alter that expense's balance.
The balance query also uses largest remainders when allocating converted expense shares.

A member's group net equals payments minus expense shares, plus balance receipts minus balance debts, plus settlements paid minus received.
Group balance entries allocate one total between an owing side and a receiving side.
Both sides support equal, exact, percentage, and share splits.
Weighted group balance inputs use scaled integers and allow at most seven decimal places.
Percentages must total exactly 100.
One member can appear on both sides; only the difference changes their net.
Group balance entries do not enter expense charts or settlement history.

Deferred database triggers enforce expense share totals and both group balance allocation totals.
An immediate trigger prevents moving an allocation to another group balance.
Member removal checks every group balance allocation, including zero amounts.

Group balance writes hold a group advisory lock.
An edit checks the saved record version and the preview's group net before saving.
A changed or deleted record requires reopening the form.
A create UUID identifies the group, creator, and original payload.
A retained receipt prevents retries from creating duplicates after edits or deletion.

Debt simplification finds the minimum payment count for up to 18 active balances.
Larger sets use a deterministic largest-debtor/largest-creditor fallback.
Friend views reuse group payment plans and keep each group and currency separate.
Direct payments remain separate from group balances.

Settlements record payments made outside the app.
The actor must be the payer or recipient when creating one.
Editing a group settlement requires membership and participation as payer, recipient, or creator.
Editing a direct settlement requires being its payer or recipient.

## Reads and sync

`GET /api/sync` reads cursors and unread counts in one query.
A visible, active tab polls every four seconds.
A hidden tab never polls; a visible tab stops after two minutes without input.
Focus, visibility, pageshow, and online events request sync when visible.
Input requests sync when it resumes an idle tab, then extends the active period.
A 401 stops polling until the account state resets.

An open group checks `/api/groups/:id/version` on each sync update.
Content fingerprints identify changes to group details, member nets, and group balance entries.
A due recurring expense also requests a fresh detail read.
A failed version check falls back to reading the detail and balance list.
Open group balance forms refresh their preview data and block stale saves.

Private JSON reads use cookie-specific ETags, `Cache-Control: private, no-cache`, and `Vary: Cookie`.
Matching conditional requests return 304 after the route reads and authorizes the data.
ETags reduce response bytes; they do not remove database queries.
The shared wrapper answers API GET/HEAD prefetches with 204 after token-format validation, without querying.
Missing or malformed tokens get 401 instead.

The browser keeps selected reads in memory and account-scoped local storage.
Account changes clear stale state; local edits invalidate affected cached reads.
Notification inbox reads bypass the persistent read cache.
The service worker never caches API responses.
See [PWA caching](PWA.md#updates-and-caching) for public page fragments and build changes.

## Recurring expenses and history

Group detail and expense reads materialize due recurring expenses.
One call creates at most 24 periods; later calls handle remaining periods.
Each expense insert and its date advance share one SQL statement.
Monthly rules preserve their anchor day across short months.
Rules pause if their payer or a participant leaves the group.
Existing expenses survive rule deletion.

The expense list uses bounded pages.
Insights uses `all=1` to read complete, unfiltered chart data.
Filters and loaded pages therefore do not change chart totals.

Group activity follows membership.
Direct activity records explicit visible user IDs.
Group and direct chat support incremental reads and text search.
Text remains escaped; detected links render as anchors.

## Attachments

Uploads accept images and PDFs up to 4 MB and check their byte signatures.
The app sanitizes stored and download filenames.
Downloads use an inline Content-Disposition and `X-Content-Type-Options: nosniff`.

## Notifications

Database triggers insert inbox entries and device delivery jobs with the business write.
A failed business transaction cannot leave an alert behind.
The sender rechecks access, preferences, and session validity before sending.
See [notification operations](NOTIFICATIONS.md) for scheduling, retries, and setup.
