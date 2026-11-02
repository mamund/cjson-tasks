# TaskList API contract — M1

Status: proposed design baseline (2026-11-02). No server implementation yet.

## Scope and invariants

Two business collections: `tasks` and `users`. A separate durable activity ledger is application infrastructure, not a third business table. IDs are immutable strings. Hours are nonnegative safe integers; task estimates must be positive integers. `budgetHours` means available, unreserved hours. A task has at most one assigned user.

Tasks: `id`, `title`, `description`, `status` (`OPEN`, `IN_PROGRESS`, `COMPLETED`), `estimatedHours`, `assignedUser` (user ID or null).
Users: `id`, `name`, `budgetHours`.

The server is single-process/single-writer, consistent with the storage library's constraints. All task assignment, estimate changes for assigned tasks, and user budget mutations must be serialized by the application. Do not claim atomic multi-document transactions or crash-safe coordinated recovery without proving it.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET, POST | `/tasks` | List/filter, create |
| GET, PATCH, DELETE | `/tasks/{id}` | Read, update title/description, delete unassigned or completed task |
| GET, POST | `/users` | List/filter, create |
| GET, PATCH, DELETE | `/users/{id}` | Read, update allowed fields, delete user with no assigned tasks |
| PUT, DELETE | `/tasks/{id}/assignment` | Assign/reassign, unassign |
| PUT | `/tasks/{id}/completion` | Complete assigned task and release hours |
| GET | `/activities` | List activities |
| GET | `/activities/{id}` | Activity status and effects |
| POST | `/activities/{id}/compensations` | Request coordinated compensation |
| GET | `/tasks/{id}/history` | Journal history for task |
| GET | `/users/{id}/history` | Journal history for user |
| GET | `/operations/{id}` | Inspect individual storage operation (read-only) |

GET collection filters use query parameters; specific allowed filters and pagination remain to be finalized before M2. `assignedUser` is read-only on task PATCH. `estimatedHours` changes on assigned tasks must route through the reservation workflow. `estimatedHours` is immutable after creation. `budgetHours` direct PATCH is disallowed initially; add budget grants through a dedicated activity later if needed.

## Assignment requests

`POST /tasks/T100/assignment` (assign only) or `PUT /tasks/T100/assignment` (reassign only) with `{"userId":"U100"}`. Assign on an assigned task, and reassign on an unassigned task, return 409. Completed tasks cannot be assigned, reassigned, or unassigned. `DELETE /tasks/T100/assignment` unassigns an incomplete assigned task; repeat delete returns 409. Return the current task, affected user budget snapshots, and activity reference for changed assignments. `Location: /activities/{id}` is useful for inspection but not a substitute for the task URL.

Example response (illustrative identifiers):

```json
{
  "taskId": "T100",
  "assignedUser": "U100",
  "activityId": "A100",
  "status": "COMPLETED",
  "effects": [
    {"collection":"users","documentId":"U100","operationId":"op-123"},
    {"collection":"tasks","documentId":"T100","operationId":"op-124"}
  ]
}
```

## Business rules

- Assign: validate task/user/estimate and available budget; debit target user, then set assignment.
- Reassign: validate both users and target budget; credit prior user, debit target user, then set assignment.
- Unassign: credit prior user, then clear assignment.
- Task `estimatedHours` is immutable after creation.
- Complete assigned task: credit reserved hours to assigned user, mark task `COMPLETED`, retain `assignedUser`. Completion of an already completed task is a no-op and never credits twice.
- Completed tasks may be deleted without a budget adjustment; deletion compensation restores the completed document.
- Reject deletion of an incomplete assigned task or a user referenced by any task (including completed tasks).
- Reject insufficient budget with `409 Conflict`; reject invalid payload with `400 Bad Request` or `422 Unprocessable Content` (choose one consistently before M2).
- A completed activity's compensation may be refused if subsequent business changes make reversal invalid; storage-level compensation success alone does not prove domain invariants.

## Activity lifecycle

`PREPARED -> APPLYING -> COMPLETED`

On failure: `APPLYING -> COMPENSATING -> COMPENSATED` if all completed effects reverse successfully; otherwise `COMPENSATION_FAILED` (inspectable, requires reconciliation). An interrupted activity may be `RECOVERY_REQUIRED` until safely reconciled. Compensation of completed activities uses `COMPLETED -> COMPENSATING -> COMPENSATED` or `COMPENSATION_FAILED`.

Persist intent and ordered effect identifiers. Journal entries remain authoritative for individual effects. Critical open design issue: a crash can occur after a mutation commits but before its operation ID is added to the activity record. M2/M3 must close this gap through durable correlation metadata, recoverable operation lookup, or another demonstrably safe protocol; do not promise automatic crash recovery until implemented and tested.

Compensate completed effects in reverse order. Revalidate domain constraints before and after each step. Record all attempts and outcomes. Never describe compensation as rollback or atomicity.

## HTTP behavior

- `201 Created` and `Location` for newly created tasks/users.
- `200 OK` for reads and completed mutations with representations; `204 No Content` for deletion without a body.
- `400 Bad Request` for malformed JSON/invalid syntax; `404 Not Found` for unknown IDs; `409 Conflict` for budget/invariant/compensation conflicts; `500` for unexpected errors.
- Error responses use `application/problem+json` with `type`, `title`, `status`, `detail`, and optionally `instance`.
- Idempotency of retryable mutation requests requires explicit design. For v1, an idempotency key should be considered for assignment/compensation requests, especially after network timeouts.

## CLI boundary

CLI uses HTTP only, no store import or filesystem access. Commands: `tasks list/show/create/update/delete/assign/reassign/unassign/history`; `users list/show/create/update/delete/history`; `activities list/show/compensate`; `operations show`. Global `--server` and `--output text|json`. Nonzero exit status on HTTP failures; retain full error payload in JSON mode.

## Acceptance criteria for M1

1. Two resource schemas and validation constraints agreed.
2. Assignment, reassignment, unassignment, estimate adjustment, and compensation state transitions documented.
3. HTTP paths, method semantics, error representation, and CLI command mapping agreed.
4. Crash consistency and idempotency questions explicitly tracked before implementation.
