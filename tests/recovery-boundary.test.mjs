/**
 * tests/recovery-boundary.test.mjs
 *
 * Tests recovery boundary.test scenarios and expected behavior.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

/** Initialize a test server and storage fixture. */
async function start(dir, afterStepCommit) {
  const app = await createApp({ dataDir: dir, afterStepCommit });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  return { app, request };
}

test('uncertain committed step blocks subsequent writes and remains blocked after restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tasklist-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let inject = false;
  let current = await start(dir, async () => {
    if (inject) throw new Error('simulated interruption after committed journal operation');
  });
  t.after(async () => { if (current) await current.app.close(); });
  const r = (...args) => current.request(...args);
  assert.equal((await r('POST', '/tasks', { id: 'T1', title: 'Test', estimatedHours: 4 })).status, 201);
  assert.equal((await r('POST', '/users', { id: 'U1', name: 'Alice', budgetHours: 10 })).status, 201);
  inject = true;
  assert.equal((await r('POST', '/tasks/T1/assignment', { userId: 'U1' })).status, 503);
  assert.equal((await r('GET', '/users/U1')).body.budgetHours, 6);
  assert.equal((await r('GET', '/tasks/T1')).body.assignedUser, null);
  const activities = (await r('GET', '/activities')).body;
  assert.equal(activities.length, 1);
  assert.equal(activities[0].status, 'RECOVERY_REQUIRED');
  assert.deepEqual(activities[0].operations, []);
  assert.equal((await r('POST', '/tasks', { title: 'Blocked', estimatedHours: 1 })).status, 409);
  await current.app.close(); current = null;
  current = await start(dir);
  assert.equal((await r('POST', '/tasks', { title: 'Still blocked', estimatedHours: 1 })).status, 409);
  assert.equal((await r('GET', '/users/U1')).body.budgetHours, 6);
  assert.equal((await r('GET', '/activities')).body[0].status, 'RECOVERY_REQUIRED');
});
