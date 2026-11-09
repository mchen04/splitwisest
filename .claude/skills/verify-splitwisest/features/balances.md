# Balances

Group balances show what each member owes after expenses and recorded payments.

## Sub-features

- `balances-net` matches each member's net with stored expenses.
- `balances-debts` shows who pays whom.
- `balances-currency` preserves whole-yen amounts.

## How to get to it (user POV)

- Open a group and choose its `Balances` tab.
- Member net balances also appear in the desktop group sidebar.
- The global Balances page shows balances across groups.

## Driving it with Playwright

Preconditions:

- Launch and doctor pass. Ann pays the only expense in the newly seeded group.
- Ben and Cat each have one share; Ann has two.

- **Run.** Execute `.claude/skills/verify-splitwisest/scripts/control.mjs drive shares`.
- **Open.** After saving USD 40, select the `Balances` tab.
- **Debts.** `Record payment: Ben pays Ann` and `Record payment: Cat pays Ann` each sit in a $10 row.
- **Net values.** The group API and `group_balance_rows` SQL function return Ann +2000, Ben -1000, and Cat -1000 cents.
- **Reload.** Each subsequent edit and reload compares API and SQL nets again. All nets sum to zero.
- **Proof.** Inspect `after-balances.png`, `yen-balances.png`, their ARIA snapshots, and `money-form-proof.json`.
- **Alternate views.** Sidebar and global Balances require separate browser coverage. The command claims the group's Balances tab only.

## Gotchas

- The mobile-sized browser puts member balances inside the Balances tab.
- `Group balances` also names a separate obligation feature. This journey does not create obligations.
- Do not record a payment during this journey. It would change the expected expense-only nets.
- Existing expenses or settlements invalidate the fixture precondition; do not relax the expected values.
