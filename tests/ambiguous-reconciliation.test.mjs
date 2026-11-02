import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

async function start(dir, hook) {
  const app = await createApp({ dataDir: dir, afterStepCommit: hook });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const req = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
      method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  return { app, req };
}

test('ambiguous journal evidence blocks reconciliation and preserves data', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tasklist-ambiguous-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let interrupted = false;
  let current = await start(dir, () => { if (interrupted) throw Error('interrupted'); });
  t.after(async () => { if (current) await current.app.close(); });
  assert.equal((await current.req('POST', '/tasks', { id: 'T1', title: 'Task', estimatedHours: 4 })).status, 201);
  assert.equal((await current.req('POST', '/users', { id: 'U1', name: 'Alice', budgetHours: 10 })).status, 201);
  interrupted = true;
  assert.equal((await current.req('POST', '/tasks/T1/assignment', { userId: 'U1' })).status, 503);
  // Deliberately violate the single-writer ownership assumption to simulate
  // conflicting journal evidence after the recorded intent boundary.
  await current.app.store.add('users', 'U1', 'budgetHours', 1);
  await current.app.close(); current = null;
  current = await start(dir);
  const result = await current.app.reconcile();
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'BLOCKED');
  assert.match(result[0].reason, /Ambiguous journal history/);
  assert.equal((await current.req('GET', '/users/U1')).body.budgetHours, 7);
  assert.equal((await current.req('GET', '/tasks/T1')).body.assignedUser, null);
  assert.equal((await current.req('POST', '/tasks', { title: 'Still blocked', estimatedHours: 1 })).status, 409);
});
