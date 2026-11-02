import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

test('M2 API: tasks, users, validation, filtering, immutable estimates and persistence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tasklist-m2-'));
  let app;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
      method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, headers: response.headers, data: response.status === 204 ? null : await response.json() };
  };
  try {
    app = await createApp({ dataDir: dir });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    assert.equal((await request('/tasks', 'POST', { id: 'T100', title: 'Review', estimatedHours: 4 })).status, 201);
    assert.equal((await request('/users', 'POST', { id: 'U100', name: 'Alice', budgetHours: 20 })).status, 201);
    assert.equal((await request('/tasks/T100')).data.estimatedHours, 4);
    assert.equal((await request('/tasks?title=rev')).data.length, 1);
    assert.equal((await request('/tasks/T100', 'PATCH', { estimatedHours: 6 })).status, 409);
    assert.equal((await request('/users/U100', 'PATCH', { budgetHours: 50 })).status, 409);
    assert.equal((await request('/tasks/T100', 'PATCH', { title: 'Reviewed' })).status, 200);
    assert.equal((await request('/tasks/T100/assignment', 'POST', { userId: 'U100' })).status, 501);
    assert.equal((await request('/tasks/T100', 'DELETE')).status, 204);
    await app.close(); app = null;
    app = await createApp({ dataDir: dir });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    assert.equal((await request('/users/U100')).data.budgetHours, 20);
    assert.equal((await request('/tasks/T100')).status, 404);
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});
