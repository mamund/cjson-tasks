# M3 implementation checkpoint

This patch adds an initial durable activity ledger and API support for assignment, reassignment, unassignment, completion, and activity compensation. Apply files over the M2 repository, retaining the existing `package.json` and npm dependency.

## Routes

- `POST /tasks/{id}/assignment` with `{ "userId": "U100" }`: assign an unassigned incomplete task.
- `PUT /tasks/{id}/assignment` with `{ "userId": "U200" }`: reassign an assigned incomplete task.
- `DELETE /tasks/{id}/assignment`: unassign an incomplete task.
- `PUT /tasks/{id}/completion`: mark assigned task complete and refund hours, retaining assignee.
- `GET /activities`, `GET /activities/{id}`: inspect durable activity ledger.
- `POST /activities/{id}/compensations`: reverse a completed activity, subject to dependency and budget checks.

Each activity has a separate durable document in the `activities` collection. The activity records intended steps and operation IDs. All mutations through the HTTP API are serialized in process. Budget deductions and reservation-restoring compensations are checked before execution.

## Run

```bash
npm install
npm test
npm start
```

## Known limitations (not production-ready)

- **Crash window:** An effect may commit before its operation ID is written to the activity ledger. On startup, unresolved activities cause the service to block all further writes; there is no automatic reconciliation or administrative recovery endpoint yet. This is deliberate fail-closed behavior, not completed crash recovery.
- **Idempotency:** `Idempotency-Key` support has not been implemented. A retry following a lost response may produce a conflict.
- **Partial compensation:** A compensation failure may leave some inverse operations committed. The ledger records results and blocks writes pending manual investigation.
- **Single process:** One server process and one writer per data directory only; no distributed lock.
- **Security:** No authentication/authorization; suitable for local experimentation only.
- **Dependencies:** Activity dependency checks cover task activity ordering; there is no general cross-resource dependency graph.
- **History:** Activity ledger operations themselves are stored in cJSON and appear in the journal.

The test suite exercises successful workflows and compensation with persistence across a clean restart. It does **not** establish crash consistency or complete recovery guarantees.
