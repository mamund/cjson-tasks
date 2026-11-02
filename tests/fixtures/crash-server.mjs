import { createApp } from '../../server/app.mjs';

const mode = process.env.CRASH_MODE ?? 'none';
let crashed = false;
let seen = 0;
const crashIndex = Number(process.env.CRASH_INDEX ?? 0);
const killAtBoundary = () => {
  if (crashed || seen++ !== crashIndex) return;
  crashed = true;
  process.kill(process.pid, 'SIGKILL');
};
const app = await createApp({
  dataDir: process.env.DATA_DIR,
  afterStepCommit: mode === 'forward' ? killAtBoundary : undefined,
  afterCompensationCommit: mode === 'compensation' ? killAtBoundary : undefined,
  afterReconcileLedgerCommit: mode === 'reconcile' ? killAtBoundary : undefined
});
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
process.send?.({ type: 'ready', port: app.server.address().port });
process.on('message', async message => {
  if (message?.type !== 'reconcile') return;
  try { process.send?.({ type: 'reconciled', report: await app.reconcile() }); }
  catch (error) { process.send?.({ type: 'error', message: error.message }); }
});
