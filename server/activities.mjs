import { randomUUID } from 'node:crypto';

const conflict = detail => Object.assign(new Error(detail), { status: 409, title: 'Conflict' });
const incomplete = a => ['PREPARED', 'APPLYING', 'COMPENSATING', 'RECOVERY_REQUIRED', 'COMPENSATION_FAILED'].includes(a.status);

export function activityService(store, { afterStepCommit, afterCompensationCommit, afterReconcileLedgerCommit } = {}) {
  let queue = Promise.resolve();
  let blocked = false;
  const exclusive = fn => {
    const next = queue.then(async () => {
      if (blocked) throw conflict('Activity reconciliation required; writes are blocked');
      return fn();
    });
    queue = next.catch(() => {});
    return next;
  };
  const list = async () => (await store.list('activities')).map(x => x.document);
  const initialize = async () => {
    blocked = (await list()).some(incomplete);
    // A reconciliation is explicit. Startup does not guess at unfinished work.
  };
  const matching = (op, step) => op && op.type === step.kind &&
    op.collection === step.collection && op.documentId === step.id &&
    op.field === step.field &&
    (step.kind === 'SET' ? JSON.stringify(op.value) === JSON.stringify(step.value) : op.amount === step.amount);
  const execute = (step) => step.kind === 'SET' ? store.set(step.collection, step.id, step.field, step.value)
    : step.kind === 'ADD' ? store.add(step.collection, step.id, step.field, step.amount)
    : store.subtract(step.collection, step.id, step.field, step.amount);
  async function recordIntent(id, index, step) {
    const history = await store.history(step.collection, step.id);
    const boundary = history.at(-1)?.sequence ?? 0;
    await update(id, 'pendingStep', { index, boundary });
  }
  // Persist a compensation intent before touching the original operation.
  // The original operation's compensationId is journal-derived evidence even
  // when the response from store.compensate() was lost.
  async function reconcileCompensation(id) {
    let a = await get(id);
    if (!Array.isArray(a.operations) || !Array.isArray(a.compensationResults) ||
        !a.pendingCompensation || !Number.isSafeInteger(a.pendingCompensation.index))
      return { id, status: 'BLOCKED', reason: 'Missing durable compensation intent' };
    const start = a.pendingCompensation.index;
    const completedBefore = a.operations.length - 1 - start;
    if (start < 0 || start >= a.operations.length ||
        ![completedBefore, completedBefore + 1].includes(a.compensationResults.length) ||
        a.pendingCompensation.operationId !== a.operations[start])
      return { id, status: 'BLOCKED', reason: 'Invalid compensation step intent' };
    // A crash may occur after the result is recorded but before the next
    // intent is persisted. In that case, skip the recorded step.
    if (a.compensationResults.length === completedBefore + 1) {
      const recorded = a.compensationResults.at(-1);
      const original = await store.getOperation(a.operations[start]);
      if (recorded.operationId !== a.operations[start] ||
          !['SUCCESS', 'ALREADY_COMPENSATED'].includes(recorded.status) ||
          !original?.compensationId || original.compensationId !== recorded.compensationId)
        return { id, status: 'BLOCKED', reason: 'Recorded compensation disagrees with journal' };
    }
    for (let i = start - (a.compensationResults.length === completedBefore + 1 ? 1 : 0); i >= 0; i--) {
      a = await get(id);
      const opId = a.operations[i];
      if (i !== start) await update(id, 'pendingCompensation', { index: i, operationId: opId });
      const original = await store.getOperation(opId);
      if (!original) return { id, status: 'BLOCKED', reason: `Missing original operation ${opId}` };
      let result;
      if (original.compensationId) {
        const inverse = await store.getOperation(original.compensationId);
        if (!inverse || inverse.type !== 'COMPENSATE' || inverse.compensates !== opId)
          return { id, status: 'BLOCKED', reason: `Invalid compensation journal evidence for ${opId}` };
        result = { operationId: opId, status: 'ALREADY_COMPENSATED', compensationId: original.compensationId };
      } else {
        result = await store.compensate(opId);
      }
      await update(id, 'compensationResults', [...a.compensationResults, result]);
      if (afterReconcileLedgerCommit) await afterReconcileLedgerCommit({ activityId: id, phase: 'compensation', index: i });
      if (!['SUCCESS', 'ALREADY_COMPENSATED'].includes(result.status)) {
        await update(id, 'status', 'COMPENSATION_FAILED');
        return { id, status: 'BLOCKED', reason: `Compensation ${opId}: ${result.status}` };
      }
    }
    await update(id, 'pendingCompensation', null);
    await update(id, 'status', 'COMPENSATED');
    return { id, status: 'COMPENSATED' };
  }
  async function reconcile() {
    // Must be called with the server quiescent; no external writers may use this store.
    return exclusiveReconcile(async () => {
      const unresolved = (await list()).filter(incomplete);
      const reports = [];
      for (const item of unresolved) {
        if (item.status === 'COMPENSATING' || (item.status === 'RECOVERY_REQUIRED' && item.pendingCompensation)) {
          reports.push(await reconcileCompensation(item.id));
          continue;
        }
        let a = await get(item.id);
        if (!Array.isArray(a.steps) || !Array.isArray(a.operations) || !a.pendingStep) {
          reports.push({ id: a.id, status: 'BLOCKED', reason: 'Missing durable step intent' });
          continue;
        }
        const { index, boundary } = a.pendingStep;
        if (!Number.isSafeInteger(index) || index < 0 || index >= a.steps.length || !Number.isSafeInteger(boundary)) {
          reports.push({ id: a.id, status: 'BLOCKED', reason: 'Invalid durable step intent' });
          continue;
        }
        const step = a.steps[index];
        const history = await store.history(step.collection, step.id);
        const candidates = history.filter(h => h.sequence > boundary);
        // The ledger itself writes only to activities; with exclusive ownership,
        // any other write to this document makes attribution ambiguous.
        if (candidates.length > 1) {
          reports.push({ id: a.id, status: 'BLOCKED', reason: 'Ambiguous journal history' });
          continue;
        }
        // A restart may find the operation already in the activity ledger.
        // Verify it against the journal instead of replaying or blocking.
        if (a.operations.length === index + 1) {
          if (candidates.length !== 1 || candidates[0].operationId !== a.operations[index]) {
            reports.push({ id: a.id, status: 'BLOCKED', reason: 'Recorded operation disagrees with journal' });
            continue;
          }
          const op = await store.getOperation(a.operations[index]);
          if (!matching(op, step)) {
            reports.push({ id: a.id, status: 'BLOCKED', reason: 'Recorded operation does not match intent' });
            continue;
          }
        } else if (a.operations.length !== index) {
          reports.push({ id: a.id, status: 'BLOCKED', reason: 'Ledger step count disagrees with intent' });
          continue;
        } else if (candidates.length === 1) {
          const op = await store.getOperation(candidates[0].operationId);
          if (!matching(op, step)) {
            reports.push({ id: a.id, status: 'BLOCKED', reason: 'Journal entry does not match step intent' });
            continue;
          }
          await update(a.id, 'operations', [...a.operations, op.operationId]);
          if (afterReconcileLedgerCommit) await afterReconcileLedgerCommit({ activityId: a.id, phase: 'forward', index });
        } else if (candidates.length === 0) {
          const result = await execute(step);
          await update(a.id, 'operations', [...a.operations, result.operationId]);
          if (afterReconcileLedgerCommit) await afterReconcileLedgerCommit({ activityId: a.id, phase: 'forward', index });
        }
        a = await get(a.id);
        for (let i = index + 1; i < a.steps.length; i++) {
          await recordIntent(a.id, i, a.steps[i]);
          const result = await execute(a.steps[i]);
          await update(a.id, 'operations', [...a.operations, result.operationId]);
          a = await get(a.id);
        }
        await update(a.id, 'pendingStep', null);
        await update(a.id, 'status', 'COMPLETED');
        reports.push({ id: a.id, status: 'COMPLETED' });
      }
      blocked = (await list()).some(incomplete);
      return reports;
    });
  }
  const exclusiveReconcile = fn => {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  };
  const get = async id => store.get('activities', id);
  const update = async (id, field, value) => store.set('activities', id, field, value);
  const requireTask = async id => {
    const t = await store.get('tasks', id);
    if (!t) throw Object.assign(new Error(`Task ${id} does not exist`), { status: 404, title: 'Not found' });
    return t;
  };
  const requireUser = async id => {
    const u = await store.get('users', id);
    if (!u) throw Object.assign(new Error(`User ${id} does not exist`), { status: 404, title: 'Not found' });
    return u;
  };
  const checkBudget = (user, hours) => { if (user.budgetHours < hours) throw conflict(`User ${user.id} has ${user.budgetHours} available hours; ${hours} required`); };
  const active = task => task.status !== 'COMPLETED';
  const latest = async taskId => {
    const items = (await list()).filter(a => a.taskId === taskId && a.status === 'COMPLETED');
    const withOrder = await Promise.all(items.map(async a => ({
      activity: a,
      sequence: (await store.history('activities', a.id))[0]?.sequence ?? 0
    })));
    withOrder.sort((a, b) => a.sequence - b.sequence);
    return withOrder.at(-1)?.activity;
  };

  async function run(type, taskId, targetUserId, idempotencyKey = null) {
    return exclusive(async () => {
      // Check the durable activity ledger before evaluating mutable business state.
      // This allows an identical retry to recover its original response.
      if (idempotencyKey !== null) {
        const previous = (await list()).find(a => a.idempotencyKey === idempotencyKey);
        if (previous) {
          if (previous.type !== type || previous.taskId !== taskId ||
              previous.newUserId !== (targetUserId ?? null)) {
            throw conflict('Idempotency-Key was previously used for a different request');
          }
          if (previous.status !== 'COMPLETED') {
            throw Object.assign(new Error(`Activity ${previous.id} requires reconciliation`),
              { status: 503, title: 'Reconciliation required' });
          }
          return { activity: previous, replayed: true };
        }
      }
      const task = await requireTask(taskId);
      const hours = task.estimatedHours;
      const oldUserId = task.assignedUser;
      if (!active(task)) throw conflict('Completed tasks cannot be modified');
      let steps;
      if (type === 'ASSIGN') {
        if (oldUserId !== null) throw conflict('Task is already assigned; use reassignment');
        if (typeof targetUserId !== 'string') throw conflict('userId is required');
        const user = await requireUser(targetUserId); checkBudget(user, hours);
        steps = [{ kind: 'SUBTRACT', collection: 'users', id: targetUserId, field: 'budgetHours', amount: hours }, { kind: 'SET', collection: 'tasks', id: taskId, field: 'assignedUser', value: targetUserId }];
      } else if (type === 'REASSIGN') {
        if (oldUserId === null) throw conflict('Task is unassigned; use assignment');
        if (typeof targetUserId !== 'string' || targetUserId === oldUserId) throw conflict('New assignee must differ from current assignee');
        const user = await requireUser(targetUserId); checkBudget(user, hours);
        await requireUser(oldUserId);
        steps = [{ kind: 'ADD', collection: 'users', id: oldUserId, field: 'budgetHours', amount: hours }, { kind: 'SUBTRACT', collection: 'users', id: targetUserId, field: 'budgetHours', amount: hours }, { kind: 'SET', collection: 'tasks', id: taskId, field: 'assignedUser', value: targetUserId }];
      } else if (type === 'UNASSIGN') {
        if (oldUserId === null) throw conflict('Task is not assigned');
        await requireUser(oldUserId);
        steps = [{ kind: 'ADD', collection: 'users', id: oldUserId, field: 'budgetHours', amount: hours }, { kind: 'SET', collection: 'tasks', id: taskId, field: 'assignedUser', value: null }];
      } else if (type === 'COMPLETE') {
        if (oldUserId === null) throw conflict('An unassigned task cannot be completed');
        await requireUser(oldUserId);
        steps = [{ kind: 'ADD', collection: 'users', id: oldUserId, field: 'budgetHours', amount: hours }, { kind: 'SET', collection: 'tasks', id: taskId, field: 'status', value: 'COMPLETED' }];
      } else throw conflict('Unknown activity type');
      const id = `A-${randomUUID()}`;
      const activity = { id, type, taskId, oldUserId, newUserId: targetUserId ?? null, hours, status: 'PREPARED', idempotencyKey, operations: [], steps };
      await store.create('activities', id, activity);
      try {
        await update(id, 'status', 'APPLYING');
        for (const [index, step] of steps.entries()) {
          await recordIntent(id, index, step);
          const result = await execute(step);
          // Deliberately injectable crash boundary for recovery testing. The
          // operation is committed, but its ID has not yet reached the ledger.
          if (afterStepCommit) await afterStepCommit({ activityId: id, step, result });
          const current = await get(id);
          await update(id, 'operations', [...current.operations, result.operationId]);
        }
        await update(id, 'pendingStep', null);
        await update(id, 'status', 'COMPLETED');
        return { activity: await get(id), replayed: false };
      } catch (err) {
        // Fail closed. A storage operation may have committed before its ID was recorded.
        blocked = true;
        try { await update(id, 'status', 'RECOVERY_REQUIRED'); } catch {}
        throw Object.assign(new Error(`Activity ${id} requires reconciliation: ${err.message}`), { status: 503, title: 'Reconciliation required' });
      }
    });
  }

  async function compensate(id) {
    return exclusive(async () => {
      const a = await get(id);
      if (!a) throw Object.assign(new Error('Activity does not exist'), { status: 404, title: 'Not found' });
      if (a.status !== 'COMPLETED') throw conflict(`Activity cannot be compensated from ${a.status}`);
      const current = await requireTask(a.taskId);
      const last = await latest(a.taskId);
      if (last?.id !== id) throw conflict('Compensate later task activities first');
      if (a.type === 'COMPLETE') {
        if (current.status !== 'COMPLETED' || current.assignedUser !== a.oldUserId) throw conflict('Task state changed');
        checkBudget(await requireUser(a.oldUserId), a.hours);
      } else {
        if (current.status === 'COMPLETED') throw conflict('Compensate completion first');
        const expected = a.type === 'UNASSIGN' ? null : a.newUserId;
        if (current.assignedUser !== expected) throw conflict('Task assignment changed');
        if (a.type === 'REASSIGN') checkBudget(await requireUser(a.oldUserId), a.hours);
        if (a.type === 'UNASSIGN') checkBudget(await requireUser(a.oldUserId), a.hours);
      }
      await update(id, 'compensationResults', []);
      await update(id, 'pendingCompensation', { index: a.operations.length - 1, operationId: a.operations.at(-1) });
      await update(id, 'status', 'COMPENSATING');
      try {
        for (let i = a.operations.length - 1; i >= 0; i--) {
          const opId = a.operations[i];
          if (i !== a.operations.length - 1)
            await update(id, 'pendingCompensation', { index: i, operationId: opId });
          const result = await store.compensate(opId);
          if (afterCompensationCommit) await afterCompensationCommit({ activityId: id, operationId: opId, result });
          const currentActivity = await get(id);
          await update(id, 'compensationResults', [...currentActivity.compensationResults, result]);
          if (!['SUCCESS', 'ALREADY_COMPENSATED'].includes(result.status)) {
            await update(id, 'status', 'COMPENSATION_FAILED');
            blocked = true;
            return get(id);
          }
        }
        await update(id, 'pendingCompensation', null);
        await update(id, 'status', 'COMPENSATED');
        return get(id);
      } catch (e) {
        blocked = true;
        // Preserve the pending intent; the journal is authoritative on restart.
        throw Object.assign(new Error(`Compensation ${id} requires reconciliation: ${e.message}`),
          { status: 503, title: 'Reconciliation required' });
      }
    });
  }
  return { initialize, reconcile, run, compensate, get, list, exclusive, isBlocked: () => blocked };
}
