import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

test('idempotent assignment and completion survive restart without double budget changes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tasklist-idem-'));
  let app;
  const start = async () => { app = await createApp({dataDir: dir}); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); };
  const request = async (path, method = 'GET', body, key) => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {method, headers: {...(body ? {'content-type':'application/json'} : {}), ...(key ? {'Idempotency-Key': key} : {})}, body: body ? JSON.stringify(body) : undefined});
    return {status:res.status, data:res.status === 204 ? null : await res.json(), replayed:res.headers.get('idempotency-replayed')};
  };
  await start();
  t.after(async () => { if (app) await app.close(); await rm(dir,{recursive:true,force:true}); });
  await request('/tasks','POST',{id:'T1',title:'Work',estimatedHours:4});
  await request('/users','POST',{id:'U1',name:'Alice',budgetHours:10});
  await request('/users','POST',{id:'U2',name:'Bob',budgetHours:10});
  const first = await request('/tasks/T1/assignment','POST',{userId:'U1'},'assign-T1');
  assert.equal(first.status,201);
  assert.equal((await request('/users/U1')).data.budgetHours,6);
  const again = await request('/tasks/T1/assignment','POST',{userId:'U1'},'assign-T1');
  assert.equal(again.status,200);
  assert.equal(again.data.id,first.data.id);
  assert.equal(again.replayed,'true');
  assert.equal((await request('/users/U1')).data.budgetHours,6);
  assert.equal((await request('/tasks/T1/assignment','POST',{userId:'U2'},'assign-T1')).status,409);
  await app.close(); app = null; await start();
  const afterRestart = await request('/tasks/T1/assignment','POST',{userId:'U1'},'assign-T1');
  assert.equal(afterRestart.status,200);
  assert.equal(afterRestart.data.id,first.data.id);
  const complete = await request('/tasks/T1/completion','PUT',undefined,'complete-T1');
  assert.equal(complete.status,201);
  assert.equal((await request('/tasks/T1/completion','PUT',undefined,'complete-T1')).status,200);
  assert.equal((await request('/users/U1')).data.budgetHours,10);
  assert.equal((await request('/activities')).data.length,2);
});
