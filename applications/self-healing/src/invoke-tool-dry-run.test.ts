/**
 * @format
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';

describe('invokeTool dry-run guard', () => {
    const originalEnv = { ...process.env };
    const realFetch = globalThis.fetch;

    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        process.env = { ...originalEnv };
        globalThis.fetch = realFetch;
    });

    it('blocks write tools in dry-run mode before calling the MCP Gateway', async () => {
        process.env['DRY_RUN'] = 'true';
        process.env['GATEWAY_URL'] = 'https://gateway.example/mcp';

        const fetchMock = jest.fn<typeof fetch>();
        globalThis.fetch = fetchMock;

        const { invokeTool } = await import('./index.js');
        const result = await invokeTool('remediate_node_bootstrap', { nodeName: 'ip-10-0-0-1' });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(JSON.parse(result)).toMatchObject({
            status: 'dry_run_blocked',
            tool:   'remediate_node_bootstrap',
        });
    });
});
