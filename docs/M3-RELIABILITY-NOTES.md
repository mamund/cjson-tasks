# M3 reliability checkpoint: HTTP idempotency

## Changes

- Assignment, reassignment, unassignment and completion accept an optional `Idempotency-Key` header (1–128 printable ASCII characters without spaces).
- A successful initial request returns `201 Created` and the durable activity representation.
- A retry with the same key and the same operation type, task ID and target user ID returns `200 OK`, the original activity, and `Idempotency-Replayed: true`. No new budget operation is performed.
- Reuse of a key for a different activity request returns `409 Conflict`.
- A matching key for an activity not in `COMPLETED` state returns `503 Reconciliation required` (unless the service is already write-blocked, in which case it returns its existing write-blocked conflict). The server does not attempt an uncertain replay.
- Keys are scoped to the whole activity ledger, not to individual tasks, and retained for the life of the ledger. No expiry policy exists yet.

## Changed files

- `server/activities.mjs`
- `server/app.mjs`
- `tests/idempotency.test.mjs` (new)

## Verification

Applied over the M3 checkpoint, `npm test` reported 4 passing tests, 0 failures, including a restart-and-retry scenario. The test environment uses the locally installed `@mamund/comp-json-store` package.

## Remaining M3 work

**Crash reconciliation remains unresolved.** A cJSON effect can commit between writing an activity's intent and recording its operation ID. This patch does not make such a window safe. The server continues to block writes when it detects an incomplete activity. A recovery design must identify journal entries for each intended step without guessing or duplicating effects, and must cover crashes during compensation as well.

Other limits: no authentication, single process/single writer only, no expiry or pruning of idempotency keys, no guarantees about process crash durability beyond the storage library's documented behavior.

## Example

```bash
curl -i -X POST http://localhost:3000/tasks/T100/assignment \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: assign-T100-U100' \
  -d '{"userId":"U100"}'
```
