# M3 compensation reconciliation checkpoint

## Scope

This checkpoint adds durable compensation-step intent and explicit restart reconciliation for committed cJSON compensation entries whose results were not recorded in the activity ledger.

Changed files:

- `server/activities.mjs`
- `server/app.mjs`
- `tests/compensation-reconcile.test.mjs`

## Behavior

Before compensating an operation, the service persists `pendingCompensation` with the operation identifier and its index. It retains a list of completed compensation results. After a restart, `app.reconcile()` inspects `getOperation(originalOperationId)` and verifies the `COMPENSATE` entry referenced by `compensationId`. It does not repeat a committed reversal. The service proceeds through remaining steps in reverse order and marks the activity `COMPENSATED` after all steps are accounted for.

An interruption leaves the service write-blocked until explicit reconciliation. Journal discrepancies remain blocked. A compensation that returns a domain conflict enters `COMPENSATION_FAILED` and remains blocked for manual investigation; this checkpoint does not attempt to automatically repair conflicts.

## Verification

The seven-test suite passed in the assembled local test base, including a restart test that interrupts compensation after its first committed reversal and verifies that reconciliation restores the budget exactly once.

## Limitations / follow-up

- The system assumes a single process owns the store and that no external writers alter the collections.
- The recovery test injects an exception at a commit boundary; it is not an OS-level process-kill or power-loss test.
- Reconciliation is invoked explicitly by the host; no HTTP administrative endpoint is exposed.
- No automatic resolution is attempted for ambiguous journal evidence or compensation conflicts.
- Further tests should interrupt every compensation boundary, including after result recording and before final status commit.
