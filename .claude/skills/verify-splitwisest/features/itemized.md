# Itemized bills

Itemized bills add item amounts, tax, and tip while respecting currency precision.

## Sub-features

- `itemized-yen` rounds tax and tip to whole yen.
- `itemized-edit` preserves a saved one-cent adjustment when editing a title.

## How to get to it (user POV)

- Open a group, choose `Add expense`, then `Itemized bill`.
- Open a saved itemized bill and choose `Edit`.
- Global `Add expense` also exposes this method after group selection.

## Driving it with Playwright

Preconditions:

- Launch and doctor pass. The command creates USD and JPY groups and three members.

- **Run.** Execute `.claude/skills/verify-splitwisest/scripts/control.mjs drive all`.
- **Enter a bill.** The JPY form uses `Add item`, `Item 1 name`, and `Item 1 amount`. Cat receives an item of 101 yen.
- **Add adjustments.** Check `Tax` and `Tip`; fill `Tax rate` with 7.25 and `Tip rate` with 20.
- **Save.** The total is 128 yen. Stored tax is 700 internal cents and tip is 2000 internal cents.
- **Edit precision.** A synthetic saved bill with one cent of tax opens through `View Audit saved adjustment` and `Edit`. Renaming preserves the total and tax.
- **Proof.** Require both itemized PASS lines and exit 0 in `drive-all.log`.
- **Alternate entry.** Global creation needs a separate browser run. The command covers group creation and expense-detail editing.

## Gotchas

- The precision edit uses an API-created fixture. It proves the edit path, not creation through the itemized UI.
- Empty fixture groups are required so balance assertions from the preceding Shares journey remain exact.
- The command removes these saved bills and their groups after the checks.
