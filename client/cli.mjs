#!/usr/bin/env node

/**
 * client/cli.mjs
 *
 * Implements the standalone TaskList command-line interface.
 */

import { pathToFileURL } from 'node:url';
import { apiRequest, ApiError } from './http-client.mjs';

const HELP = `TaskList HTTP CLI
Usage: tasklist [--server URL] [--output text|json] [--idempotency-key KEY] <command>

Tasks:
  tasks list [--status STATUS] [--assigned-user ID]
  tasks show ID
  tasks create --title TEXT --hours N [--id ID] [--description TEXT]
  tasks update ID --title TEXT | --description TEXT
  tasks delete ID
  tasks history ID
  tasks assign TASK_ID USER_ID
  tasks reassign TASK_ID USER_ID
  tasks unassign TASK_ID
  tasks complete TASK_ID
Users:
  users list [--name TEXT]
  users show ID
  users create --name TEXT --budget N [--id ID]
  users update ID --name TEXT
  users delete ID
  users history ID
Activities:
  activities list
  activities show ID
  activities compensate ID
Operations:
  operations show ID

Environment: TASKLIST_SERVER (default http://127.0.0.1:3000)
Exit codes: 0 success; 1 HTTP/network error; 2 usage error.
`;
class UsageError extends Error {}
const enc = encodeURIComponent;

/** Parse CLI options and positional arguments. */
function parse(args) {
  const flags = {};
  const positional = [];
  const keys = new Set(['server', 'output', 'idempotency-key', 'title', 'description', 'hours', 'budget', 'id', 'name', 'status', 'assigned-user']);
  for (let i = 0; i < args.length; i++) {
    const item = args[i];
    if (item === '--help' || item === '-h') return { help: true };
    if (item.startsWith('--')) {
      const eq = item.indexOf('=');
      const key = item.slice(2, eq === -1 ? undefined : eq);
      if (!keys.has(key) || key in flags) throw new UsageError(`Unknown or repeated option: --${key}`);
      const value = eq === -1 ? args[++i] : item.slice(eq + 1);
      if (!value || value.startsWith('--')) throw new UsageError(`Missing value for --${key}`);
      flags[key] = value;
    } else positional.push(item);
  }
  return { flags, positional };
}

/** Validate the allowed options for a CLI command. */
function only(flags, names) {
  const globals = ['server', 'output', 'idempotency-key'];
  for (const key of Object.keys(flags)) if (![...globals, ...names].includes(key)) throw new UsageError(`Option --${key} is not valid for this command`);
}

/** Check the expected number of positional arguments. */
function requireArgs(parts, n) { if (parts.length !== n) throw new UsageError(`Expected ${n} command argument(s), received ${parts.length}`); }

/** Parse and validate an integer CLI option. */
function positiveInt(s, label, zero = false) {
  if (s === undefined || !/^(0|[1-9][0-9]*)$/.test(s) || !Number.isSafeInteger(Number(s)) || (!zero && Number(s) === 0)) {
    throw new UsageError(`${label} must be ${zero ? 'a nonnegative' : 'a positive'} integer`);
  }
  return Number(s);
}

/** Require a nonempty text argument. */
function required(value, label) { if (typeof value !== 'string' || !value.trim()) throw new UsageError(`${label} is required`); return value; }

/** Translate CLI arguments into an HTTP request. */
function command(parts, flags) {
  const [resource, action, ...rest] = parts;
  if (!resource || !action) throw new UsageError('Missing command');
  const id = rest[0] === undefined ? undefined : enc(rest[0]);
  const mutation = (method, path, body) => ({ method, path, body });
  if (resource === 'tasks' || resource === 'users') {
    const root = `/${resource}`;
    if (action === 'list') {
      requireArgs(rest, 0); only(flags, resource === 'tasks' ? ['status', 'assigned-user'] : ['name']);
      const params = new URLSearchParams();
      if (flags.status) params.set('status', flags.status);
      if (flags['assigned-user']) params.set('assignedUser', flags['assigned-user']);
      if (flags.name) params.set('name', flags.name);
      return mutation('GET', root + (params.size ? `?${params}` : ''));
    }
    if (action === 'create') {
      requireArgs(rest, 0);
      if (resource === 'tasks') {
        only(flags, ['id', 'title', 'description', 'hours']);
        const body = { title: required(flags.title, '--title'), estimatedHours: positiveInt(flags.hours, '--hours') };
        if (flags.id) body.id = flags.id;
        if (flags.description !== undefined) body.description = flags.description;
        return mutation('POST', root, body);
      }
      only(flags, ['id', 'name', 'budget']);
      const body = { name: required(flags.name, '--name'), budgetHours: positiveInt(flags.budget, '--budget', true) };
      if (flags.id) body.id = flags.id;
      return mutation('POST', root, body);
    }
    if (['show', 'delete', 'history', 'update'].includes(action)) {
      requireArgs(rest, 1);
      const path = `${root}/${id}`;
      if (action === 'show') { only(flags, []); return mutation('GET', path); }
      if (action === 'delete') { only(flags, []); return mutation('DELETE', path); }
      if (action === 'history') { only(flags, []); return mutation('GET', `${path}/history`); }
      only(flags, resource === 'tasks' ? ['title', 'description'] : ['name']);
      const fields = resource === 'tasks' ? ['title', 'description'] : ['name'];
      const supplied = fields.filter(f => flags[f] !== undefined);
      if (supplied.length !== 1) throw new UsageError('Update requires exactly one editable field');
      return mutation('PATCH', path, { [supplied[0]]: required(flags[supplied[0]], `--${supplied[0]}`) });
    }
    if (resource === 'tasks' && ['assign', 'reassign', 'unassign', 'complete'].includes(action)) {
      only(flags, []);
      requireArgs(rest, ['assign', 'reassign'].includes(action) ? 2 : 1);
      if (action === 'complete') return mutation('PUT', `${root}/${id}/completion`);
      const path = `${root}/${id}/assignment`;
      if (action === 'unassign') return mutation('DELETE', path);
      return mutation(action === 'assign' ? 'POST' : 'PUT', path, { userId: rest[1] });
    }
  }
  if (resource === 'activities') {
    only(flags, []);
    if (action === 'list') { requireArgs(rest, 0); return mutation('GET', '/activities'); }
    if (action === 'show') { requireArgs(rest, 1); return mutation('GET', `/activities/${id}`); }
    if (action === 'compensate') { requireArgs(rest, 1); return mutation('POST', `/activities/${id}/compensations`); }
  }
  if (resource === 'operations' && action === 'show') {
    only(flags, []); requireArgs(rest, 1); return mutation('GET', `/operations/${id}`);
  }
  throw new UsageError(`Unknown command: ${resource} ${action}`);
}

/** Execute the selected CLI command and format its response. */
export async function run(argv, { out = console.log, err = console.error, request = apiRequest } = {}) {
  try {
    const parsed = parse(argv);
    if (parsed.help) { out(HELP); return 0; }
    const { flags, positional } = parsed;
    const server = flags.server ?? process.env.TASKLIST_SERVER ?? 'http://127.0.0.1:3000';
    try { const url = new URL(server); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); }
    catch { throw new UsageError('--server must be an HTTP or HTTPS URL'); }
    const output = flags.output ?? 'text';
    if (!['text', 'json'].includes(output)) throw new UsageError('--output must be text or json');
    const spec = command(positional, flags);
    if (flags['idempotency-key'] && !['POST', 'PUT', 'DELETE'].includes(spec.method)) throw new UsageError('--idempotency-key requires a mutation');
    const response = await request(server, spec.method, spec.path, { body: spec.body, idempotencyKey: flags['idempotency-key'] });
    if (output === 'json') out(JSON.stringify(response.data));
    else if (response.data === null) out('Success (no content)');
    else out(JSON.stringify(response.data, null, 2));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) { err(`Usage error: ${error.message}\nRun tasklist --help for commands.`); return 2; }
    if (error instanceof ApiError) { err(`HTTP ${error.status}: ${error.message}`); return 1; }
    err(`Request failed: ${error.message}`);
    return 1;
  }
}
if (process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await run(process.argv.slice(2));
