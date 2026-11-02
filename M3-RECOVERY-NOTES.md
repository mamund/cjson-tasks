# M3 recovery checkpoint: uncertain commit boundary

## Scope

This checkpoint adds a deterministic failure-injection hook and an integration test
for a committed cJSON operation whose identifier has not yet been persisted in the
TaskList activity ledger. It **does not implement automatic reconciliation**.

The test verifies that the application refuses further writes and retains the
`RECOVERY_REQUIRED` state after a clean restart. Reads remain available.

## Why automatic reconciliation is not yet safe

The cJSON v0.1.0 mutation interface returns a generated `operationId` *after*
committing. A process interruption can occur before TaskList persists that ID.
An activity's recorded `operations` array can therefore be incomplete even
though the budget changed. Blindly compensating the recorded array would leave
an inconsistent reservation.

## Required design before automatic recovery

1. Record durable step intent, including collection, document ID, operation
   kind, field, and expected value/amount, before executing a mutation.
2. Establish an unambiguous journal boundary for each step. Consider a durable
   sequence checkpoint and verify that journal entries are attributable to the
   intended activity, including after a crash.
3. Reconcile each step against committed journal history before choosing to
   resume, compensate, or remain blocked. Do not infer commitment solely from
   the current document value.
4. Track compensation progress with the same care. Compensation itself can
   commit before its result reaches the activity ledger.
5. Validate assumptions about single-process exclusive access. Direct edits
   or concurrent store instances invalidate sequence-based attribution.
6. Add process-kill tests for every commit/ledger boundary and verify recovery
   after reopening the same data directory.

Until these are established, fail-closed behavior is intentional. The current
HTTP status for blocked writes is 409; a dedicated 503 recovery response may be
preferable in a later contract revision.

## Apply

Copy `server/app.mjs` and `server/activities.mjs` into the existing repository;
add `tests/recovery-boundary.test.mjs`. Then run `npm test`.

`afterStepCommit` is a **test-only** injection option on `createApp`. It is not
exposed by the production server entry point.
