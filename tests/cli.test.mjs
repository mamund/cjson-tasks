/**
 * tests/cli.test.mjs
 *
 * Tests cli.test scenarios and expected behavior.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { run } from '../client/cli.mjs';

/** Create a test fixture and register cleanup. */
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tasklist-cli-'));
  const app = await createApp({ dataDir: dir });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const server = `http://127.0.0.1:${app.server.address().port}`;
  /** Implement the cli helper. */
  async function cli(...args) {
    const stdout = [], stderr = [];
    const code = await run(['--server', server, '--output', 'json', ...args], { out: x => stdout.push(x), err: x => stderr.push(x) });
    return { code, data: stdout.length ? JSON.parse(stdout[0]) : null, error: stderr.join('\n') };
  }
  return cli;
}

test('CLI uses HTTP for assignment, completion, compensation and history', async t => {
  const cli = await setup(t);
  assert.equal((await cli('users','create','--id','U1','--name','Alice','--budget','12')).code, 0);
  assert.equal((await cli('users','create','--id','U2','--name','Bob','--budget','10')).code, 0);
  assert.equal((await cli('tasks','create','--id','T1','--title','Review','--hours','4')).code, 0);
  assert.equal((await cli('tasks','assign','T1','U1')).code, 0);
  assert.equal((await cli('users','show','U1')).data.budgetHours, 8);
  assert.equal((await cli('tasks','assign','T1','U2')).code, 1);
  const reassign = await cli('tasks','reassign','T1','U2');
  assert.equal(reassign.code, 0);
  assert.equal((await cli('users','show','U1')).data.budgetHours, 12);
  assert.equal((await cli('users','show','U2')).data.budgetHours, 6);
  assert.equal((await cli('activities','compensate',reassign.data.id)).code, 0);
  assert.equal((await cli('tasks','show','T1')).data.assignedUser, 'U1');
  const completion = await cli('tasks','complete','T1');
  assert.equal(completion.code, 0);
  assert.equal((await cli('users','show','U1')).data.budgetHours, 12);
  assert.equal((await cli('tasks','show','T1')).data.assignedUser, 'U1');
  assert.equal((await cli('tasks','show','T1')).data.status, 'COMPLETED');
  assert.equal((await cli('activities','compensate',completion.data.id)).code, 0);
  assert.equal((await cli('users','show','U1')).data.budgetHours, 8);
  assert.equal((await cli('tasks','show','T1')).data.status, 'OPEN');
  assert.ok((await cli('tasks','history','T1')).data.length > 0);
  assert.ok((await cli('activities','list')).data.length >= 3);
});

test('CLI retry key and validation errors', async t => {
  const cli = await setup(t);
  await cli('users','create','--id','U1','--name','Alice','--budget','5');
  await cli('tasks','create','--id','T1','--title','Review','--hours','4');
  const args = ['--idempotency-key','demo-key','tasks','assign','T1','U1'];
  const first = await cli(...args);
  const second = await cli(...args);
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.equal(first.data.id, second.data.id);
  assert.equal((await cli('users','show','U1')).data.budgetHours, 1);
  assert.equal((await cli('tasks','create','--title','Missing hours')).code, 2);
  assert.equal((await cli('tasks','update','T1','--hours','5')).code, 2);
  assert.equal((await cli('tasks','show','unknown')).code, 1);
});
