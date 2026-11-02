# M3 extended recovery verification checkpoint

## Scope

- `tests/process-boundaries-extended.test.mjs` exercises real `SIGKILL` after each committed forward and compensation step of assign (2), reassign (3), unassign (2), and complete (2): 18 cases.
- `tests/fixtures/crash-server.mjs` extends the previous fixture with `CRASH_INDEX` (zero-based) while retaining `CRASH_MODE`.
- `tests/ambiguous-reconciliation.test.mjs` introduces a second journal mutation after an unrecorded commit and verifies reconciliation reports BLOCKED, preserves data, and keeps writes blocked.

## Verified locally

`npm test`: 46 passed, 0 failed (Node.js, installed `@mamund/comp-json-store@0.1.0`).

## Limitations and next step

- The ambiguous-evidence test deliberately violates the exclusive-writer assumption. It tests fail-closed behavior rather than a supported concurrent-write workflow.
- Tests still do not forcibly terminate the process *during reconciliation*. Reconciliation itself may need restart-safe checkpoints, especially if termination occurs after an activity-ledger update but before the next step intent is written.
- These tests do not establish filesystem power-loss durability.

M3 should remain open until interrupted-reconciliation testing is implemented and passes.
