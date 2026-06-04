/** @format */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SessionLogger, defaultLogsDir, pruneLogs } from './logger.js';
import { LOG_RETAIN } from './config.js';
import { registerPrimitives } from './tools/primitives.js';
import { registerSystemDesign } from './tools/system-design.js';

const logsDir = defaultLogsDir();
pruneLogs(logsDir, LOG_RETAIN);
const stamp = new Date().toISOString();
const logger = new SessionLogger(logsDir, stamp);

const server = new McpServer({ name: 'tucaken-smoke', version: '0.1.0' });
registerPrimitives(server, logger);
registerSystemDesign(server, logger);

await server.connect(new StdioServerTransport());
logger.log({ tool: '_boot', ok: true, params: { logsDir, retain: LOG_RETAIN } });
