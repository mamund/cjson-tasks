import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/crash-server.mjs', import.meta.url));
const timeout = (promise, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Error(`${label} timed out`)), 10000))]);
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
const scenarios = [
  { name: 'assign', method: 'POST', path: '/tasks/T1/assignment', body: { userId: 'U1' }, setup: [], steps: 2, after: ['U1', 'OPEN', 6, 10], before: [null, 'OPEN', 10, 10] },
  { name: 'reassign', method: 'PUT', path: '/tasks/T1/assignment', body: { userId: 'U2' }, setup: [['POST', '/tasks/T1/assignment', { userId: 'U1' }]], steps: 3, after: ['U2', 'OPEN', 10, 6], before: ['U1', 'OPEN', 6, 10] },
  { name: 'unassign', method: 'DELETE', path: '/tasks/T1/assignment', setup: [['POST', '/tasks/T1/assignment', { userId: 'U1' }]], steps: 2, after: [null, 'OPEN', 10, 10], before: ['U1', 'OPEN', 6, 10] },
  { name: 'complete', method: 'PUT', path: '/tasks/T1/completion', setup: [['POST', '/tasks/T1/assignment', { userId: 'U1' }]], steps: 2, after: ['U1', 'COMPLETED', 10, 10], before: ['U1', 'OPEN', 6, 10] }
];
async function state(api) {
  const task = (await api.req('GET', '/tasks/T1')).body;
  const a = (await api.req('GET', '/users/U1')).body;
  const b = (await api.req('GET', '/users/U2')).body;
  return [task.assignedUser, task.status, a.budgetHours, b.budgetHours];
}
for (const s of scenarios) for (let step = 0; step < s.steps; step++) for (const mode of ['forward', 'compensation']) {
  test(`SIGKILL ${mode} ${s.name} step ${step + 1}/${s.steps}`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'tasklist-process-boundary-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const seed = await launch(t, dir);
    assert.equal((await seed.req('POST', '/tasks', { id: 'T1', title: 'Task', estimatedHours: 4 })).status, 201);
    for (const [id, name] of [['U1', 'Alice'], ['U2', 'Bob']])
      assert.equal((await seed.req('POST', '/users', { id, name, budgetHours: 10 })).status, 201);
    for (const [method, path, body] of s.setup)
      assert.equal((await seed.req(method, path, body)).status, 201);
    let activityId;
    if (mode === 'compensation') {
      const result = await seed.req(s.method, s.path, s.body);
      assert.equal(result.status, 201);
      activityId = result.body.id;
    }
    await seed.stop();
    const crashing = await launch(t, dir, mode, step);
    const died = crashing.killed();
    const pending = mode === 'forward'
      ? crashing.req(s.method, s.path, s.body)
      : crashing.req('POST', `/activities/${activityId}/compensations`);
    await assert.rejects(pending);
    assert.equal(await died, 'SIGKILL');
    const restarted = await launch(t, dir);
    assert.equal((await restarted.req('POST', '/tasks', { title: 'Blocked', estimatedHours: 1 })).status, 409);
    const report = await restarted.reconcile();
    assert.equal(report.length, 1);
    assert.equal(report[0].status, mode === 'forward' ? 'COMPLETED' : 'COMPENSATED');
    assert.deepEqual(await state(restarted), mode === 'forward' ? s.after : s.before);
    assert.equal((await restarted.req('POST', '/tasks', { title: 'Unblocked', estimatedHours: 1 })).status, 201);
    await restarted.stop();
  });
}
