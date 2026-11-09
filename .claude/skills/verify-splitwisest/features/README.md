# Splitwisest verification map

This map describes the real web app's expense and balance behavior.
Read the selected recipe before running it.

## Baseline preconditions

- Launch from the checkout root using this skill's executable helper.
- Require `doctor` to pass for the recorded app, local database, and schema.
- Use the private browser created by the harness.
- Drive seeds Ann, Ben, and Cat into fresh USD and JPY groups.
- Do not reuse a person's account or another run's group.

## Driving conventions

- Use accessible roles and exact labels, scoped to the active dialog.
- Use `#expense-amount` for the amount field.
- Run `control.mjs drive shares` for Shares, edits, and balance proof.
- Run `control.mjs drive all` for the additional split methods.
- API calls seed accounts and groups; browser controls create and edit Shares expenses.
- Each drive deletes its fixtures. Each separate command starts from fresh fixtures.

## Proof and skip reporting

- Save screenshots and ARIA snapshots before submitting and after saving or reloading.
- Compare stored shares, raw weights, API balances, and SQL balances.
- Capture stdout, stderr, and exit code through the helper's drive logs.
- The automated entry point is the bottom Add expense button while viewing a group.
- Home-page group selection, the empty-group Add expense button, and direct expense links need separate manual coverage.
- Do not claim those alternate entry points passed merely because the group route passed.
- A missing fixture, unavailable control, or failed doctor is a failure with its reason, not a skipped assertion.
- Cleanup must retain all evidence.

## Features

- [Shares](shares.md) covers blank defaults, proportional weights, and equal weights.
- [Exact amounts and percentages](amount-splits.md) covers fixed amounts and percentage validation.
- [Itemized bills](itemized.md) covers tax, tip, and saved adjustment precision.
- [Edit and reload](edit.md) covers unchanged saves and amount changes.
- [Balances](balances.md) covers debt rows and whole-yen totals.
