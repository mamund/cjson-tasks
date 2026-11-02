import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

test('restart reconciles committed compensation without double reversal', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tasklist-comp-reconcile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let crash = false;
  let app;
  async function start() {
    app = await createApp({ dataDir: dir, afterCompensationCommit: () => { if (crash) throw Error('injected compensation interruption'); } });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  }
  async function req(method, path, body) {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
      method, headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }
  await start();
  t.after(async () => { if (app) await app.close(); });
  await req('POST', '/tasks', { id: 'T1', title: 'Work', estimatedHours: 4 });
  await req('POST', '/users', { id: 'U1', name: 'Alice', budgetHours: 10 });
  const assignment = await req('POST', '/tasks/T1/assignment', { userId: 'U1' });
  assert.equal(assignment.status, 201);
  crash = true;
  assert.equal((await req('POST', `/activities/${assignment.body.id}/compensations`)).status, 503);
  assert.equal((await req('GET', '/tasks/T1')).body.assignedUser, null);
  assert.equal((await req('GET', '/users/U1')).body.budgetHours, 6);
  await app.close(); app = null;
  crash = false;
  await start();
  const reports = await app.reconcile();
  assert.equal(reports[0].status, 'COMPENSATED');
  assert.equal((await req('GET', '/users/U1')).body.budgetHours, 10);
  assert.equal((await req('GET', '/tasks/T1')).body.assignedUser, null);
  const record = (await req('GET', `/activities/${assignment.body.id}`)).body;
  assert.equal(record.compensationResults.length, 2);
  assert.equal(record.status, 'COMPENSATED');
  assert.equal((await req('POST', '/tasks', { title: 'Allowed', estimatedHours: 1 })).status, 201);
});
