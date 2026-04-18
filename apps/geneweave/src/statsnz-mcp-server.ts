#!/usr/bin/env node
/**
 * Stats NZ MCP Server
 *
 * A standalone MCP (Model Context Protocol) server that exposes Stats NZ
 * Aotearoa Data Explorer API tools over stdio.
 *
 * This app entrypoint intentionally stays thin and delegates server wiring
 * to the reusable @weaveintel/mcp-statsnz package.
 *
 * Usage:
 *   STATSNZ_API_KEY=<your-key> node dist/statsnz-mcp-server.js
 */

import { startStatsNzMCPServerOverStdio } from '@weaveintel/mcp-statsnz';

const VERSION = '1.0.0';

async function main() {
  const { tools, transport } = await startStatsNzMCPServerOverStdio({
    name: 'statsnz-ade',
    version: VERSION,
  });

  // Log startup info to stderr (not stdout — stdout is reserved for MCP protocol)
  const hasApiKey = Boolean(process.env['STATSNZ_API_KEY']);
  process.stderr.write(
    `[statsnz-mcp-server] v${VERSION} started on stdio. ` +
      `API key: ${hasApiKey ? 'configured' : 'NOT SET (set STATSNZ_API_KEY)'}. ` +
      `Tools: ${Object.keys(tools).join(', ')}\n`,
  );

  // Keep alive until stdin closes
  process.stdin.on('end', () => {
    transport.close().finally(() => process.exit(0));
  });
}

main().catch((err) => {
  process.stderr.write(`[statsnz-mcp-server] Fatal error: ${err}\n`);
  process.exit(1);
});
