import { createLiveAgentsDemo } from './index.js';

const port = Number.parseInt(process.env['LIVE_AGENTS_DEMO_PORT'] ?? '3600', 10);
const host = process.env['LIVE_AGENTS_DEMO_HOST'] ?? '0.0.0.0';

createLiveAgentsDemo({
  host,
  port,
  databaseUrl: process.env['LIVE_AGENTS_DEMO_DATABASE_URL'],
}).then(() => {
  console.log(`live-agents-demo running on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
