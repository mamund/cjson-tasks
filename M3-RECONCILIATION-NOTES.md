# M3 forward-operation reconciliation checkpoint

## Scope

This checkpoint adds durable intent and explicit reconciliation for interrupted **forward** activity steps. It does not provide general-purpose crash-safe compensation, a process lock, or an administrative HTTP recovery endpoint.

## Files

- `server/activities.mjs`: record pending step intent (index and per-document journal boundary) before mutation; reconcile a pending forward step against committed cJSON history; continue remaining steps when attribution is unambiguous.
- `server/app.mjs`: expose `app.reconcile()` for a controlled maintenance/test invocation.
- `tests/reconcile.test.mjs`: verify no double debit after a simulated post-commit interruption and restart.

## Preconditions

- Only one TaskList process uses the data directory, and no other writer accesses the cJSON store.
- All business mutations pass through the application activity coordinator.
- Run reconciliation with the server quiescent; `app.reconcile()` is a maintenance API, not an HTTP endpoint.
- The committed journal remains intact and cJSON can open the store successfully.

## Recovery policy

A step intent records the target and the last journal sequence for that document before mutation. On reconciliation, the coordinator examines later entries for that document. Exactly one matching entry is accepted as the committed step; zero entries means the step can be executed; multiple entries or a mismatch keeps the activity blocked. Subsequent steps are executed only after attribution succeeds.

This model relies on single-writer ownership and excludes direct changes to the data directory. It is not a general transaction protocol.

## Known limitations

- Compensation operations do not yet have durable step intents. Interrupted compensation remains blocked and needs its own reconciliation design.
- Activities created before this checkpoint may lack `pendingStep`; these remain blocked rather than being guessed at.
- No process-level file lock prevents a second process from opening the same directory.
- No process-kill matrix has been completed for every journal/ledger boundary. The automated test injects a post-commit exception.
- The application does not yet expose a safe, authenticated operational workflow to trigger reconciliation.
- `reconcile()` must be invoked on a quiescent server; it does not protect against a concurrent in-flight HTTP request.

## Apply and test

Copy the changed files into the repository and run `npm test`. The new test requires the previous M3 checkpoints to have been applied.

## Next

Design durable compensation intents and test interruption during compensation before considering M3 complete.
