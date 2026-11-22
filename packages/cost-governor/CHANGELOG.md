# @weaveintel/cost-governor

## 0.2.2

### Patch Changes

- Updated dependencies
  - @weaveintel/core@0.3.0
  - @weaveintel/tools@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [766246e]
  - @weaveintel/core@0.2.0
  - @weaveintel/tools@0.2.1

## 0.2.0

### Breaking (fail-closed default)

- `weaveBudgetGate` denies when the ledger throws or returns a non-finite total
  (`CostLedgerUnavailableError`), instead of logging and letting the step run. Opt out explicitly with
  `onLedgerError: 'allow'` (GAPS G-WI-11, platform-architecture §7.4 item 4).
- `weaveCostLedgerFromBreakdown().total()` rethrows a read failure instead of reporting $0.

### Added

- `onLedgerFailure` callback so the host can alert; `CostLedgerUnavailableError`.
