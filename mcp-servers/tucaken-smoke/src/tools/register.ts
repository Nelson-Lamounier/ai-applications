/** @format */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SessionLogger } from '../logger.js';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

/** Register a tool: validate input, log call+outcome, return MCP text content. */
export function tool(server: McpServer, logger: SessionLogger, name: string, schema: z.ZodRawShape, handler: Handler): void {
  server.tool(name, schema, async (args: Record<string, unknown>) => {
    const started = Date.now();
    try {
      const result = await handler(args);
      logger.log({ tool: name, params: args, ok: true, durationMs: Date.now() - started });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? { ok: true }, null, 2) }] };
    } catch (e) {
      const err = e as Error;
      logger.log({ tool: name, params: args, ok: false, durationMs: Date.now() - started, error: err.message, stack: err.stack });
      return { content: [{ type: 'text' as const, text: `ERROR ${name}: ${err.message}` }], isError: true };
    }
  });
}
