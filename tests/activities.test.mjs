/**
 * tests/activities.test.mjs
 *
 * Tests activities.test scenarios and expected behavior.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

/** Create a test fixture and register cleanup. */
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tasklist-m3-'));
  let app = await createApp({ dataDir: dir });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const request = async (path, method='GET', data) => {
    const r = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {method, headers: data ? {'content-type':'application/json'} : {}, body: data ? JSON.stringify(data) : undefined});
    return {status:r.status, data: r.status===204?null:await r.json()};
  };
  const restart = async () => { await app.close(); app = await createApp({ dataDir: dir }); await new Promise(r => app.server.listen(0,'127.0.0.1',r)); };
  t.after(async () => { await app.close(); await rm(dir,{recursive:true,force:true}); });
  return {request,restart};
}

test('assignment, budget guard, completion, compensation and restart', async t => {
  const {request:r,restart} = await setup(t);
  assert.equal((await r('/tasks','POST',{id:'T1',title:'Work',estimatedHours:4})).status,201);
  await r('/users','POST',{id:'U1',name:'Alice',budgetHours:10});
  await r('/users','POST',{id:'U2',name:'Bob',budgetHours:2});
  assert.equal((await r('/tasks/T1/assignment','POST',{userId:'U2'})).status,409);
  assert.equal((await r('/users/U2')).data.budgetHours,2);
  const a=(await r('/tasks/T1/assignment','POST',{userId:'U1'}));
  assert.equal(a.status,201);
  assert.equal(a.data.operations.length,2);
  assert.equal((await r('/users/U1')).data.budgetHours,6);
  assert.equal((await r('/tasks/T1/assignment','POST',{userId:'U1'})).status,409);
  assert.equal((await r('/tasks/T1/assignment','PUT',{userId:'U2'})).status,409);
  assert.equal((await r('/tasks/T1/completion','PUT')).status,201);
  assert.equal((await r('/users/U1')).data.budgetHours,10);
  assert.equal((await r('/tasks/T1')).data.assignedUser,'U1');
  assert.equal((await r('/tasks/T1/assignment','PUT',{userId:'U2'})).status,409);
  const activities=(await r('/activities')).data;
  assert.equal(activities.length,2);
  assert.equal((await r(`/activities/${a.data.id}/compensations`,'POST')).status,409);
  const complete=activities.find(x=>x.type==='COMPLETE');
  assert.equal((await r(`/activities/${complete.id}/compensations`,'POST')).status,200);
  assert.equal((await r('/users/U1')).data.budgetHours,6);
  assert.equal((await r('/tasks/T1')).data.status,'OPEN');
  assert.equal((await r(`/activities/${a.data.id}/compensations`,'POST')).status,200);
  assert.equal((await r('/users/U1')).data.budgetHours,10);
  assert.equal((await r('/tasks/T1')).data.assignedUser,null);
  await restart();
  assert.equal((await r('/users/U1')).data.budgetHours,10);
  assert.equal((await r('/activities')).data.length,2);
});

test('reassignment and unassignment compensation', async t => {
  const {request:r} = await setup(t);
  await r('/tasks','POST',{id:'T2',title:'Work',estimatedHours:3});
  await r('/users','POST',{id:'U1',name:'Alice',budgetHours:8});
  await r('/users','POST',{id:'U2',name:'Bob',budgetHours:7});
  await r('/tasks/T2/assignment','POST',{userId:'U1'});
  const reassigned=await r('/tasks/T2/assignment','PUT',{userId:'U2'});
  assert.equal(reassigned.status,201);
  assert.equal((await r('/users/U1')).data.budgetHours,8);
  assert.equal((await r('/users/U2')).data.budgetHours,4);
  assert.equal((await r(`/activities/${reassigned.data.id}/compensations`,'POST')).status,200);
  assert.equal((await r('/tasks/T2')).data.assignedUser,'U1');
  assert.equal((await r('/users/U1')).data.budgetHours,5);
  assert.equal((await r('/users/U2')).data.budgetHours,7);
  const unassigned=await r('/tasks/T2/assignment','DELETE');
  assert.equal(unassigned.status,201);
  assert.equal((await r('/users/U1')).data.budgetHours,8);
  assert.equal((await r(`/activities/${unassigned.data.id}/compensations`,'POST')).status,200);
  assert.equal((await r('/users/U1')).data.budgetHours,5);
  assert.equal((await r('/tasks/T2')).data.assignedUser,'U1');
});
