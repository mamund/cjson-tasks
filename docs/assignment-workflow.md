# Assignment workflow and compensation — M1

## Example

Initial state: task T100 (`estimatedHours=4`, `assignedUser=null`), Alice U100 (`budgetHours=20`), Bob U200 (`budgetHours=12`).

### Assign to Alice

1. Validate task/user and available hours.
2. Persist activity intent A100 (`PREPARED`).
3. Apply SUBTRACT 4 to U100 budget (20 -> 16); record effect ID.
4. Apply SET T100.assignedUser = U100; record effect ID.
5. Mark activity COMPLETED.

### Reassign to Bob

1. Validate task, Alice, Bob, and Bob's available hours.
2. Persist new activity intent.
3. ADD 4 to Alice budget (16 -> 20); record effect.
4. SUBTRACT 4 from Bob budget (12 -> 8); record effect.
5. SET T100.assignedUser = U200; record effect.
6. Mark activity COMPLETED.

### Compensate reassignment

If no conflicting subsequent changes, reverse the completed effects in reverse order: restore assignedUser to U100; ADD 4 to Bob's budget; SUBTRACT 4 from Alice's budget. The activity ledger records each attempt and its outcome. If Alice no longer has sufficient hours, compensation cannot safely complete without further policy; report a conflict rather than making the budget negative.

### Failure during assignment

If user budget debit commits but task SET fails, attempt compensation of the debit. The HTTP response reports the failure and compensation result. If compensation fails, retain an inspectable activity with reconciliation required. If the process crashes between effect commit and activity ledger update, recovery must reconcile against the authoritative journal before resuming or compensating.

## Additional cases to test

- Repeated assignment to same user: no double debit.
- Insufficient budget: no mutation.
- Assigned task estimate increased beyond available budget: reject without mutation.
- Unassign and compensate unassignment.
- Reassign and compensate after an unrelated budget adjustment: arithmetic inverse preserves unrelated adjustment if budget constraints allow.
- Compensation after later reassignment: refuse unsafe reversal.
- Concurrent assignment requests: serialized; only one final reservation.
- Client retries after response loss: idempotency strategy required.
- Restart after each step and after partial compensation.

## Decisions confirmed after initial draft

- `estimatedHours` is a positive integer and immutable after creation.
- `POST /tasks/{id}/assignment` assigns only an unassigned incomplete task; `PUT` reassigns only an already assigned incomplete task. Inapplicable requests return 409.
- Assignment/reassignment requires the target user's available `budgetHours` to cover the full estimate.
- Completion (`PUT /tasks/{id}/completion`) credits the assigned user's reserved hours, marks the task `COMPLETED`, and preserves `assignedUser`. Repeating completion must never credit twice.
- Completed tasks cannot be assigned, reassigned, or unassigned; completed tasks can be deleted without a budget effect.
- Compensating completion must re-reserve the hours, subject to available budget. Later dependent activities must be reversed first.
- Direct mutation of `budgetHours` through PATCH is prohibited.
