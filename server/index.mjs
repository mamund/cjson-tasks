import { createApp } from './app.mjs';
const port = Number(process.env.PORT ?? 3000);
const dataDir = process.env.DATA_DIR ?? './data';
const app = await createApp({ dataDir });
app.server.listen(port, () => console.log(`TaskList API listening on http://localhost:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
