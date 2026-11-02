/**
 * tests/failure-boundaries.test.mjs
 *
 * Tests failure boundaries.test scenarios and expected behavior.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

/** Construct a test harness with injectable failure hooks. */
async function harness(t, hooks = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tasklist-boundary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let app;
  const start = async (options = {}) => {
    app = await createApp({ dataDir: dir, ...options });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  };
  const close = async () => { if (app) await app.close(); app = null; };
  t.after(close);
  const req = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
      method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  await start(hooks);
  return { req, close, start, reconcile: () => app.reconcile() };
}

const scenarios = [
  { name: 'assign', method: 'POST', path: '/tasks/T1/assignment', body: { userId: 'U1' }, steps: 2,
    setup: [], expected: { assignee: 'U1', status: 'OPEN', alice: 6, bob: 10 } },
  { name: 'reassign', method: 'PUT', path: '/tasks/T1/assignment', body: { userId: 'U2' }, steps: 3,
    setup: [['POST', '/tasks/T1/assignment', { userId: 'U1' }]],
    expected: { assignee: 'U2', status: 'OPEN', alice: 10, bob: 6 } },
  { name: 'unassign', method: 'DELETE', path: '/tasks/T1/assignment', steps: 2,
    setup: [['POST', '/tasks/T1/assignment', { userId: 'U1' }]],
    expected: { assignee: null, status: 'OPEN', alice: 10, bob: 10 } },
  { name: 'complete', method: 'PUT', path: '/tasks/T1/completion', steps: 2,
    setup: [['POST', '/tasks/T1/assignment', { userId: 'U1' }]],
    expected: { assignee: 'U1', status: 'COMPLETED', alice: 10, bob: 10 } }
];

for (const scenario of scenarios) {
  for (let index = 0; index < scenario.steps; index++) {
    test(`forward ${scenario.name}: committed step ${index + 1} before ledger receipt`, async t => {
      let enabled = false;
      let seen = 0;
      const h = await harness(t, { afterStepCommit: () => {
        if (enabled && seen++ === index) throw Error('injected interruption');
      } });
      assert.equal((await h.req('POST', '/tasks', { id: 'T1', title: 'Task', estimatedHours: 4 })).status, 201);
      assert.equal((await h.req('POST', '/users', { id: 'U1', name: 'Alice', budgetHours: 10 })).status, 201);
      assert.equal((await h.req('POST', '/users', { id: 'U2', name: 'Bob', budgetHours: 10 })).status, 201);
      for (const [method, path, body] of scenario.setup) assert.equal((await h.req(method, path, body)).status, 201);
      enabled = true;
      assert.equal((await h.req(scenario.method, scenario.path, scenario.body)).status, 503);
      assert.equal((await h.req('POST', '/tasks', { title: 'Blocked', estimatedHours: 1 })).status, 409);
      await h.close();
      await h.start();
      const report = await h.reconcile();
      assert.equal(report.length, 1);
      assert.equal(report[0].status, 'COMPLETED');
      const task = (await h.req('GET', '/tasks/T1')).body;
      assert.equal(task.assignedUser, scenario.expected.assignee);
      assert.equal(task.status, scenario.expected.status);
      assert.equal((await h.req('GET', '/users/U1')).body.budgetHours, scenario.expected.alice);
      assert.equal((await h.req('GET', '/users/U2')).body.budgetHours, scenario.expected.bob);
      assert.equal((await h.req('POST', '/tasks', { title: 'Unblocked', estimatedHours: 1 })).status, 201);
    });
  }
}

for (const scenario of scenarios) {
  for (let index = 0; index < scenario.steps; index++) {
    test(`compensation ${scenario.name}: committed reverse step ${index + 1} before ledger receipt`, async t => {
      let enabled = false;
      let seen = 0;
      const h = await harness(t, { afterCompensationCommit: () => {
        if (enabled && seen++ === index) throw Error('injected compensation interruption');
      } });
      assert.equal((await h.req('POST', '/tasks', { id: 'T1', title: 'Task', estimatedHours: 4 })).status, 201);
      assert.equal((await h.req('POST', '/users', { id: 'U1', name: 'Alice', budgetHours: 10 })).status, 201);
      assert.equal((await h.req('POST', '/users', { id: 'U2', name: 'Bob', budgetHours: 10 })).status, 201);
      for (const [method, path, body] of scenario.setup) assert.equal((await h.req(method, path, body)).status, 201);
      const activity = await h.req(scenario.method, scenario.path, scenario.body);
      assert.equal(activity.status, 201);
      enabled = true;
      assert.equal((await h.req('POST', `/activities/${activity.body.id}/compensations`)).status, 503);
      await h.close();
      await h.start();
      const report = await h.reconcile();
      assert.equal(report.length, 1);
      assert.equal(report[0].status, 'COMPENSATED');
      const task = (await h.req('GET', '/tasks/T1')).body;
      const priorAssignee = scenario.setup.length ? 'U1' : null;
      assert.equal(task.assignedUser, priorAssignee);
      assert.equal(task.status, 'OPEN');
      assert.equal((await h.req('GET', '/users/U1')).body.budgetHours, priorAssignee ? 6 : 10);
      assert.equal((await h.req('GET', '/users/U2')).body.budgetHours, 10);
      const saved = (await h.req('GET', `/activities/${activity.body.id}`)).body;
      assert.equal(saved.status, 'COMPENSATED');
      assert.equal(saved.compensationResults.length, scenario.steps);
    });
  }
}
