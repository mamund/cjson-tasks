/**
 * tests/reconciliation-crash.test.mjs
 *
 * Tests reconciliation crash.test scenarios and expected behavior.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/crash-server.mjs', import.meta.url));
const timeout = (promise, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Error(`${label} timed out`)), 10000))]);

/** Launch a separate server process for crash testing. */
async function launch(t, dir, mode = 'none', index = 0) {
  const child = fork(fixture, { env: { ...process.env, DATA_DIR: dir, CRASH_MODE: mode, CRASH_INDEX: String(index) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const port = await timeout(new Promise((resolve, reject) => {
    child.on('message', m => { if (m.type === 'ready') resolve(m.port); });
    child.once('exit', (code, signal) => reject(Error(`Start failed: ${code}/${signal} ${stderr}`)));
    child.once('error', reject);
  }), 'start');
  const req = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  const reconcile = () => timeout(new Promise((resolve, reject) => {
    const onMessage = m => {
      if (m.type !== 'reconciled' && m.type !== 'error') return;
      child.off('message', onMessage);
      if (m.type === 'error') reject(Error(m.message)); else resolve(m.report);
    };
    child.on('message', onMessage);
    child.once('exit', () => { child.off('message', onMessage); reject(Error('Reconciliation process exited')); });
    child.send({ type: 'reconcile' });
  }), 'reconcile');
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', (_, signal) => resolve(signal)));
    child.kill('SIGKILL');
    await timeout(exited, 'stop');
  };
  const killed = () => timeout(new Promise(resolve => child.once('exit', (_, signal) => resolve(signal))), 'SIGKILL');
  return { req, reconcile, stop, killed };
}

for (const phase of ['forward', 'compensation']) {
  test(`SIGKILL during ${phase} reconciliation ledger update is recoverable`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'tasklist-reconcile-crash-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const seed = await launch(t, dir);
    assert.equal((await seed.req('POST', '/tasks', { id: 'T1', title: 'Task', estimatedHours: 4 })).status, 201);
    assert.equal((await seed.req('POST', '/users', { id: 'U1', name: 'Alice', budgetHours: 10 })).status, 201);
    let activityId;
    if (phase === 'compensation') {
      const created = await seed.req('POST', '/tasks/T1/assignment', { userId: 'U1' });
      assert.equal(created.status, 201);
      activityId = created.body.id;
    }
    await seed.stop();
    const initial = await launch(t, dir, phase, 0);
    const died = initial.killed();
    const pending = phase === 'forward'
      ? initial.req('POST', '/tasks/T1/assignment', { userId: 'U1' })
      : initial.req('POST', `/activities/${activityId}/compensations`);
    await assert.rejects(pending);
    assert.equal(await died, 'SIGKILL');
    const reconciling = await launch(t, dir, 'reconcile', 0);
    const diedAgain = reconciling.killed();
    const interrupted = reconciling.reconcile();
    await assert.rejects(interrupted);
    assert.equal(await diedAgain, 'SIGKILL');
    const restarted = await launch(t, dir);
    assert.equal((await restarted.req('POST', '/tasks', { title: 'Blocked', estimatedHours: 1 })).status, 409);
    const report = await restarted.reconcile();
    assert.equal(report.length, 1);
    assert.equal(report[0].status, phase === 'forward' ? 'COMPLETED' : 'COMPENSATED');
    const task = (await restarted.req('GET', '/tasks/T1')).body;
    const user = (await restarted.req('GET', '/users/U1')).body;
    assert.equal(task.assignedUser, phase === 'forward' ? 'U1' : null);
    assert.equal(user.budgetHours, phase === 'forward' ? 6 : 10);
    assert.equal((await restarted.req('POST', '/tasks', { title: 'Unblocked', estimatedHours: 1 })).status, 201);
    await restarted.stop();
  });
}
