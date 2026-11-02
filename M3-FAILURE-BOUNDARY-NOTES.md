# M3 failure-boundary test checkpoint

## Scope

Adds `tests/failure-boundaries.test.mjs` to the existing M3 repository. No server or storage-library source changes are required.

The test matrix covers four activities (ASSIGN, REASSIGN, UNASSIGN, COMPLETE), each committed forward step, and each committed compensation step. Every case interrupts execution after cJSON reports a committed mutation but before the activity ledger records its result. The test closes the server, opens a new instance against the same directory, invokes `app.reconcile()`, and checks task state, user budgets, and activity state.

| Activity | Forward boundaries | Compensation boundaries |
| --- | ---: | ---: |
| Assign | 2 | 2 |
| Reassign | 3 | 3 |
| Unassign | 2 | 2 |
| Complete | 2 | 2 |
| **Total** | **9** | **9** |

## Verification

- New failure-boundary tests: 18 passed, 0 failed.
- Full test suite (with this test file): 25 passed, 0 failed.
- Verified with the local M3 source tree and its installed `@mamund/comp-json-store` dependency.

Run `npm test` from the project root.

## Limits of evidence

- Tests inject exceptions through `afterStepCommit` and `afterCompensationCommit`; they do not forcibly kill a separate OS process or simulate power loss.
- Other interruption windows (before intent persistence, during journal commit, after ledger update, and during reconciliation itself) remain untested.
- Tests assume one process owns the store directory; they do not establish safety with multiple writers.
- Reconciliation remains an explicit application operation, not a public recovery endpoint or automatic startup action.
- These tests do not establish filesystem crash durability.

## Recommended next checkpoint

Add a child-process crash harness that terminates the server at selected boundaries, then verifies restart behavior. Include interrupted reconciliation and ambiguity/conflict cases before closing M3.
