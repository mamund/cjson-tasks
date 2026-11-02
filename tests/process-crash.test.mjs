import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/crash-server.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function start(t, dir, mode = 'none') {
  const child = fork(fixture, [], { env: { ...process.env, DATA_DIR: dir, CRASH_MODE: mode }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const port = await Promise.race([
    new Promise((resolve, reject) => {
      child.on('message', message => { if (message.type === 'ready') resolve(message.port); });
      child.once('exit', (code, signal) => reject(Error(`Server exited before ready: ${code}/${signal} ${stderr}`)));
      child.once('error', reject);
    }),
    delay(10000).then(() => { throw Error(`Server start timeout: ${stderr}`); })
  ]);
  const req = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  const reconcile = () => Promise.race([
    new Promise((resolve, reject) => {
      const listener = message => {
        if (!['reconciled', 'error'].includes(message.type)) return;
        child.off('message', listener);
        if (message.type === 'error') reject(Error(message.message));
        else resolve(message.report);
      };
      child.on('message', listener);
      child.send({ type: 'reconcile' });
    }),
    delay(10000).then(() => { throw Error('Reconciliation timeout'); })
  ]);
  const waitForKill = () => Promise.race([
    new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))),
    delay(10000).then(() => { throw Error('Expected process termination') })
  ]);
  return { child, req, reconcile, waitForKill };
}

for (const mode of ['forward', 'compensation']) {
  test(`SIGKILL after committed ${mode} operation: restart and reconcile`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'tasklist-kill-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const seed = await start(t, dir);
    assert.equal((await seed.req('POST', '/tasks', { id: 'T1', title: 'Task', estimatedHours: 4 })).status, 201);
    assert.equal((await seed.req('POST', '/users', { id: 'U1', name: 'Alice', budgetHours: 10 })).status, 201);
    let activityId;
    if (mode === 'compensation') {
      const activity = await seed.req('POST', '/tasks/T1/assignment', { userId: 'U1' });
      assert.equal(activity.status, 201);
      activityId = activity.body.id;
    }
    seed.child.kill('SIGKILL');
    await new Promise(resolve => seed.child.once('exit', resolve));
    const crashing = await start(t, dir, mode);
    const killed = crashing.waitForKill();
    const request = mode === 'forward'
      ? crashing.req('POST', '/tasks/T1/assignment', { userId: 'U1' })
      : crashing.req('POST', `/activities/${activityId}/compensations`);
    await assert.rejects(request);
    assert.equal((await killed).signal, 'SIGKILL');
    const recovered = await start(t, dir);
    assert.equal((await recovered.req('POST', '/tasks', { title: 'Blocked', estimatedHours: 1 })).status, 409);
    const report = await recovered.reconcile();
    assert.equal(report.length, 1);
    assert.equal(report[0].status, mode === 'forward' ? 'COMPLETED' : 'COMPENSATED');
    const task = (await recovered.req('GET', '/tasks/T1')).body;
    const user = (await recovered.req('GET', '/users/U1')).body;
    assert.equal(task.assignedUser, mode === 'forward' ? 'U1' : null);
    assert.equal(user.budgetHours, mode === 'forward' ? 6 : 10);
    assert.equal((await recovered.req('POST', '/tasks', { title: 'Unblocked', estimatedHours: 1 })).status, 201);
    recovered.child.kill('SIGKILL');
    await new Promise(resolve => recovered.child.once('exit', resolve));
  });
}
