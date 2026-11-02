# M1 — TaskList API design baseline

Status: agreed business design; implementation and recovery guarantees require verification.  
Date: 2026-11-02

## Purpose and scope

Build a standalone TaskList Web API backed by `@mamund/comp-json-store@0.1.0`, followed by a separate HTTP-only CLI client. The example demonstrates compensable business activities spanning two JSON document collections. Keep the storage library independent of the application.

The two business collections are `tasks` and `users`. A durable activity ledger is application infrastructure, rather than an additional business collection. The API operates as a single process with a single writer; serialize business mutations that affect assignments or budgets.

## Resources

Task example:

```json
{
  "id": "T100",
  "title": "Review proposal",
  "description": "Provide feedback",
  "status": "OPEN",
  "estimatedHours": 4,
  "assignedUser": null
}
```

User example:

```json
{
  "id": "U100",
  "name": "Alice",
  "budgetHours": 20
}
```

- Task statuses: `OPEN`, `IN_PROGRESS`, `COMPLETED`.
- `estimatedHours` is a positive integer and **immutable after creation**.
- `budgetHours` is a nonnegative integer representing *currently available* hours.
- `assignedUser` is either a user ID or `null`; it is controlled by assignment operations, never ordinary task PATCH.
- Direct user budget changes are out of scope for the first version.
- A task has at most one assignee.

## Business operations and invariants

| Operation | Preconditions | Effects |
|---|---|---|
| Assign | Task unassigned and incomplete; user exists with `budgetHours >= estimatedHours` | Subtract hours from user; set `assignedUser` |
| Reassign | Task assigned and incomplete; different target user exists with sufficient budget | Return hours to previous user; subtract from new user; update `assignedUser` |
| Unassign | Task assigned and incomplete | Return hours to assigned user; clear `assignedUser` |
| Complete | Task assigned and incomplete | Return hours to assigned user; set `status=COMPLETED`; **retain `assignedUser`** |
| Complete again | Task already completed | No changes; never credit hours twice |
| Delete task | Task unassigned or completed | Delete task; no budget change |
| Delete user | User has no task references, including completed tasks | Delete user |

Assignment and reassignment are distinct operations. Assigning an already assigned task fails; reassigning an unassigned task fails. Assigning, reassigning, or unassigning a completed task fails. Insufficient budget always prevents assignment or reassignment **before any storage mutation**. Reassigning to the current user also fails.

`OPEN -> IN_PROGRESS` requires assignment. An assigned task can move `IN_PROGRESS -> OPEN`. An assigned task may complete from either `OPEN` or `IN_PROGRESS`. Reopening a completed task requires compensating its completion activity, subject to reservation and dependency checks. Ordinary status PATCH cannot set `COMPLETED` or reopen a completed task.

## HTTP contract

| Method | Endpoint | Purpose |
|---|---|---|
| GET / POST | `/tasks` | List/filter or create tasks |
| GET / PATCH / DELETE | `/tasks/{id}` | Read, update allowed fields, or delete |
| GET / POST | `/users` | List/filter or create users |
| GET / PATCH / DELETE | `/users/{id}` | Read, update allowed fields, or delete |
| POST | `/tasks/{id}/assignment` | Assign an unassigned task |
| PUT | `/tasks/{id}/assignment` | Reassign an assigned task |
| DELETE | `/tasks/{id}/assignment` | Unassign an incomplete task |
| PUT | `/tasks/{id}/completion` | Complete an assigned task |
| GET | `/activities` | List business activities |
| GET | `/activities/{id}` | Inspect an activity and its effects |
| POST | `/activities/{id}/compensations` | Request coordinated compensation |
| GET | `/tasks/{id}/history` | Inspect task operation history |
| GET | `/users/{id}/history` | Inspect user operation history |
| GET | `/operations/{id}` | Inspect a storage operation (read-only) |

Assignment/reassignment request body: `{"userId":"U100"}`. The API returns an activity ID and the resulting task/user information. CLI commands map to these HTTP operations; the CLI must not import the storage library or access its files.

Use `201 Created` plus `Location` for new resources, `200 OK` for successful reads/represented mutations, `204 No Content` for deletions, `400 Bad Request` for invalid input, `404 Not Found` for unknown resources, and `409 Conflict` for violated business rules. Error responses use `application/problem+json` (RFC 9457). Exact filtering, pagination, and retry response representations can be finalized during implementation.

## Activities and compensation

Each multi-document business operation creates a durable activity record containing its identity, type, target task, state, and ordered storage effects. Planned states include `PREPARED`, `APPLYING`, `COMPLETED`, `COMPENSATING`, `COMPENSATED`, `COMPENSATION_FAILED`, and `RECOVERY_REQUIRED`.

On failure, attempt compensation of completed effects in reverse order and report every outcome. A compensation request for a completed activity must check that later activities do not depend on its effects and that restoring a reservation will not exceed a user's available budget. For example, compensating completion must reserve hours again; compensating an earlier assignment while the task remains completed must be rejected. Compensating deletion of a completed task restores the completed record without changing budgets.

Compensation is not an atomic transaction. A failure or crash may leave an activity requiring inspection and reconciliation. A committed storage operation whose ID was not recorded in the activity ledger presents a specific recovery gap; M3 must address this with a proven correlation/reconciliation mechanism before advertising automatic restart recovery.

## CLI boundary and planned commands

The standalone CLI uses HTTP/JSON exclusively. Proposed commands include `tasks list/show/create/update/delete/assign/reassign/unassign/complete/history`, `users list/show/create/update/delete/history`, `activities list/show/compensate`, and `operations show`. Support configurable server URL, text/JSON output, and nonzero exit codes for HTTP errors.

## Explicit deferrals and open implementation decisions

- Changing `estimatedHours` after creation: **not supported**.
- Administrative budget grants or adjustments: deferred.
- Multi-process or multi-writer storage: unsupported.
- Durable idempotency keys for retries: desirable, but exact semantics and implementation remain open.
- Restart-safe activity recovery: required before claiming it works; test interrupted writes and compensation failures.
- Authentication/authorization, pagination, and deployment hardening: outside the first demonstration unless later required.

## Milestones

- **M1:** Agree on business rules, API surface, and compensation design (this document).
- **M2:** Implement and test basic task/user Web API.
- **M3:** Add assignment, reassignment, unassignment, completion, durable activities, and coordinated compensation.
- **M4:** Build standalone HTTP-only CLI.
- **M5:** Exercise end-to-end workflows, recovery scenarios, and document reproducible examples.

## Acceptance focus

The primary end-to-end scenario is: create user and task; assign task and reserve hours; complete task and refund hours while retaining assignee; compensate completion to restore the reservation; compensate assignment to restore the unassigned task and original budget. Also test insufficient budget, duplicate assignment, invalid reassignment, completed-task restrictions, completed-task deletion, and compensation conflicts.
