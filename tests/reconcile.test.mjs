/**
 * tests/reconcile.test.mjs
 *
 * Tests reconcile.test scenarios and expected behavior.
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
  /** Implement the req helper. */
  async function req(method, path, body) {
    const response = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }
  return { app, req };
}

test('reconciles a committed but unrecorded debit after restart without double charging', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tasklist-reconcile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let crash = false;
  let current = await start(dir, async () => { if (crash) throw Error('injected interruption'); });
  t.after(async () => { if (current) await current.app.close(); });
  assert.equal((await current.req('POST', '/tasks', { id: 'T1', title: 'Test', estimatedHours: 4 })).status, 201);
  assert.equal((await current.req('POST', '/users', { id: 'U1', name: 'Alice', budgetHours: 10 })).status, 201);
  crash = true;
  assert.equal((await current.req('POST', '/tasks/T1/assignment', { userId: 'U1' })).status, 503);
  assert.equal((await current.req('GET', '/users/U1')).body.budgetHours, 6);
  await current.app.close(); current = null;
  current = await start(dir);
  const result = await current.app.reconcile();
  assert.equal(result[0].status, 'COMPLETED');
  assert.equal((await current.req('GET', '/users/U1')).body.budgetHours, 6);
  assert.equal((await current.req('GET', '/tasks/T1')).body.assignedUser, 'U1');
  assert.equal((await current.req('GET', '/activities')).body[0].operations.length, 2);
  assert.equal((await current.req('POST', '/tasks', { title: 'Allowed', estimatedHours: 1 })).status, 201);
});
