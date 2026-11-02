/**
 * server/app.mjs
 *
 * Defines HTTP routes, request validation, and TaskList resource behavior.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { JsonStore } from '@mamund/comp-json-store';
import { activityService } from './activities.mjs';

const statuses = new Set(['OPEN', 'IN_PROGRESS', 'COMPLETED']);
const validHours = value => Number.isSafeInteger(value) && value >= 0;
const fail = (status, title, detail) => { const e = new Error(detail); Object.assign(e, { status, title }); throw e; };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const allowed = (obj, keys) => Object.keys(obj).every(k => keys.includes(k));
const requireObject = body => { if (!plain(body)) fail(400, 'Invalid request', 'Expected a JSON object'); };
const requireString = (value, field) => { if (typeof value !== 'string' || !value.trim()) fail(400, 'Invalid request', `${field} must be a nonempty string`); };
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }), ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const problem = (res, status, title, detail, path) => {
  res.writeHead(status, { 'content-type': 'application/problem+json; charset=utf-8' });
  res.end(JSON.stringify({ type: 'about:blank', title, status, detail, instance: path }));
};

/** Parse a JSON request body and report invalid input. */
async function bodyJson(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 1024 * 1024) fail(413, 'Payload too large', 'Maximum request body is 1 MB'); }
  if (!text) fail(400, 'Invalid request', 'JSON body required');
  try { return JSON.parse(text); } catch { fail(400, 'Invalid request', 'Malformed JSON'); }
}

/** Validate the optional idempotency key header. */
function idempotencyKey(req) {
  const value = req.headers['idempotency-key'];
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(value))
    fail(400, 'Invalid Idempotency-Key', 'Idempotency-Key must be 1–128 printable ASCII characters without spaces');
  return value;
}
const record = (entry) => ({ id: entry.id, ...entry.document });

/** Open storage, initialize activities, and construct the HTTP server. */
export async function createApp({ dataDir, afterStepCommit, afterCompensationCommit, afterReconcileLedgerCommit } = {}) {
  const store = new JsonStore(dataDir);
  await store.open();
  const activities = activityService(store, { afterStepCommit, afterCompensationCommit, afterReconcileLedgerCommit });
  await activities.initialize();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const dispatch = async () => {
      const segments = path.split('/').filter(Boolean);
      if (segments.length === 1 && ['tasks', 'users'].includes(segments[0])) {
        const collection = segments[0];
        if (req.method === 'GET') {
          const params = url.searchParams;
          const filterKeys = collection === 'tasks' ? ['title', 'description', 'status', 'assignedUser'] : ['name'];
          if ([...params.keys()].some(k => !filterKeys.includes(k))) fail(400, 'Invalid filter', 'Unsupported query parameter');
          const entries = params.size ? await store.query(collection, params) : await store.list(collection);
          return send(res, 200, entries.map(record));
        }
        if (req.method === 'POST') {
          const input = await bodyJson(req); requireObject(input);
          const id = input.id ?? `${collection === 'tasks' ? 'T' : 'U'}-${randomUUID()}`;
          requireString(id, 'id');
          if (collection === 'tasks') {
            if (!allowed(input, ['id', 'title', 'description', 'estimatedHours'])) fail(400, 'Invalid request', 'Unknown or read-only task field');
            requireString(input.title, 'title');
            if (!Number.isSafeInteger(input.estimatedHours) || input.estimatedHours <= 0) fail(400, 'Invalid request', 'estimatedHours must be a positive integer');
            if (input.description !== undefined && typeof input.description !== 'string') fail(400, 'Invalid request', 'description must be a string');
            const task = { id, title: input.title, description: input.description ?? '', status: 'OPEN', estimatedHours: input.estimatedHours, assignedUser: null };
            await store.create('tasks', id, task);
            return send(res, 201, task, { location: `/tasks/${encodeURIComponent(id)}` });
          }
          if (!allowed(input, ['id', 'name', 'budgetHours'])) fail(400, 'Invalid request', 'Unknown or read-only user field');
          requireString(input.name, 'name');
          if (!validHours(input.budgetHours)) fail(400, 'Invalid request', 'budgetHours must be a nonnegative integer');
          const user = { id, name: input.name, budgetHours: input.budgetHours };
          await store.create('users', id, user);
          return send(res, 201, user, { location: `/users/${encodeURIComponent(id)}` });
        }
      }
      if (segments.length === 2 && ['tasks', 'users'].includes(segments[0])) {
        const [collection, id] = segments;
        const current = await store.get(collection, id);
        if (!current) fail(404, 'Not found', `${collection} ${id} does not exist`);
        if (req.method === 'GET') return send(res, 200, current);
        if (req.method === 'PATCH') {
          const input = await bodyJson(req); requireObject(input);
          const fields = collection === 'tasks' ? ['title', 'description'] : ['name'];
          if (!Object.keys(input).length || !allowed(input, fields)) fail(409, 'Immutable or protected field', `Only ${fields.join(', ')} may be updated`);
          for (const [field, value] of Object.entries(input)) requireString(value, field);
          // M2 only permits a single-field PATCH. Multi-field changes require
          // the coordinated compensation policy being implemented in M3.
          if (Object.keys(input).length !== 1) fail(400, 'Invalid request', 'PATCH accepts one field per request in M2');
          const [[field, value]] = Object.entries(input);
          await store.set(collection, id, field, value);
          return send(res, 200, await store.get(collection, id));
        }
        if (req.method === 'DELETE') {
          if (collection === 'tasks' && current.assignedUser !== null && current.status !== 'COMPLETED') fail(409, 'Task assigned', 'Unassign or complete the task before deletion');
          if (collection === 'users') {
            const tasks = await store.list('tasks');
            if (tasks.some(({ document }) => document.assignedUser === id)) fail(409, 'User referenced', 'User remains assigned to a task, including completed tasks');
          }
          await store.delete(collection, id);
          return send(res, 204);
        }
      }
      if (segments.length === 3 && segments[2] === 'history' && ['tasks', 'users'].includes(segments[0]) && req.method === 'GET') {
        const current = await store.get(segments[0], segments[1]);
        if (!current) fail(404, 'Not found', 'Resource does not exist');
        return send(res, 200, await store.history(segments[0], segments[1]));
      }
      if (segments.length === 2 && segments[0] === 'operations' && req.method === 'GET') {
        const operation = await store.getOperation(segments[1]);
        if (!operation) fail(404, 'Not found', 'Operation does not exist');
        return send(res, 200, operation);
      }
      if (segments[0] === 'activities') {
        if (segments.length === 1 && req.method === 'GET') return send(res, 200, await activities.list());
        if (segments.length === 2 && req.method === 'GET') {
          const a = await activities.get(segments[1]);
          if (!a) fail(404, 'Not found', 'Activity does not exist');
          return send(res, 200, a);
        }
        if (segments.length === 3 && segments[2] === 'compensations' && req.method === 'POST') {
          const a = await activities.compensate(segments[1]);
          return send(res, a.status === 'COMPENSATED' ? 200 : 409, a);
        }
      }
      if (segments[0] === 'tasks' && segments.length === 3) {
        const taskId = segments[1];
        if (segments[2] === 'assignment') {
          if (req.method === 'POST' || req.method === 'PUT') {
            const body = await bodyJson(req); requireObject(body);
            if (!allowed(body, ['userId']) || typeof body.userId !== 'string' || !body.userId) fail(400, 'Invalid request', 'userId is required');
            const { activity: a, replayed } = await activities.run(req.method === 'POST' ? 'ASSIGN' : 'REASSIGN', taskId, body.userId, idempotencyKey(req));
            return send(res, replayed ? 200 : 201, a, { location: `/activities/${a.id}`, ...(replayed ? { 'idempotency-replayed': 'true' } : {}) });
          }
          if (req.method === 'DELETE') {
            const { activity: a, replayed } = await activities.run('UNASSIGN', taskId, undefined, idempotencyKey(req));
            return send(res, replayed ? 200 : 201, a, { location: `/activities/${a.id}`, ...(replayed ? { 'idempotency-replayed': 'true' } : {}) });
          }
        }
        if (segments[2] === 'completion' && req.method === 'PUT') {
          const { activity: a, replayed } = await activities.run('COMPLETE', taskId, undefined, idempotencyKey(req));
          return send(res, replayed ? 200 : 201, a, { location: `/activities/${a.id}`, ...(replayed ? { 'idempotency-replayed': 'true' } : {}) });
        }
      }
      fail(404, 'Not found', 'No matching endpoint');
    };
    try {
      const isActivityMutation = (path.startsWith('/activities/') && req.method === 'POST') || (path.startsWith('/tasks/') && (path.endsWith('/assignment') || path.endsWith('/completion')));
      if (!['GET', 'HEAD'].includes(req.method) && !isActivityMutation) await activities.exclusive(dispatch);
      else await dispatch();
    } catch (e) {
      const status = e.status ?? ({ DOCUMENT_EXISTS: 409, DOCUMENT_NOT_FOUND: 404, INVALID_DOCUMENT: 400, INVALID_NAME: 400 }[e.code] ?? 500);
      problem(res, status, e.title ?? (status === 500 ? 'Internal server error' : 'Request failed'), status === 500 ? 'An unexpected server error occurred' : e.message, path);
    }
  });
  return { server, store, reconcile: () => activities.reconcile(), async close() { await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())); await store.close(); } };
}
