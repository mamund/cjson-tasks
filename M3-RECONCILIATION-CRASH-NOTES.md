# M3: Recovery from interruption during reconciliation

## Change

Forward reconciliation now accepts a pending step whose operation identifier has already been durably appended to the activity ledger. It verifies that the recorded operation is the sole journal candidate after the recorded boundary and that the journal entry matches the step intent. It then continues without replaying the mutation. Mismatched or ambiguous evidence remains blocked.

A new optional `afterReconcileLedgerCommit` injection hook permits a process-level crash immediately after the activity ledger records a reconciled forward or compensation step. The hook is used only by tests.

## Tests

`tests/reconciliation-crash.test.mjs` runs two process-kill scenarios:

- Forward reconciliation: kill after recording a recovered budget deduction, restart, reconcile, and verify no duplicate debit.
- Compensation reconciliation: kill after recording a recovered compensation, restart, reconcile, and verify no duplicate refund.

The full assembled M2/M3 suite passed locally: **48 tests passed, 0 failed**.

## Applying

Overlay the changed files on the existing M3 repository, then run `npm test`.

## Scope and remaining limitations

These tests demonstrate recovery at the injected ledger-update boundaries under a single-process, single-writer assumption. They do not establish guarantees for arbitrary power loss, filesystem failure, concurrent writers, or every possible journal/ledger corruption scenario. Recovery remains an explicit operation, and ambiguous evidence blocks writes.
