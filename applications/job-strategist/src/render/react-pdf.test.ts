/** @format */
import { loadReactPdf } from './react-pdf.js';

describe('loadReactPdf', () => {
    // @react-pdf/renderer is a heavy pure-ESM module (fonts + yoga WASM). Cold-loading
    // it via dynamic import on a clean CI runner routinely exceeds Jest's default 5s
    // timeout — the import then resolves after teardown ("Test environment has been torn
    // down"). It's cold-load latency, not a logic failure, so allow generous time.
    it('loads the @react-pdf/renderer module with the primitives we use', async () => {
        const mod = await loadReactPdf();
        expect(typeof mod.renderToBuffer).toBe('function');
        expect(typeof mod.StyleSheet.create).toBe('function');
        // v4 primitives are string element tags, not components.
        expect(typeof mod.Document).toBe('string');
        expect(typeof mod.Page).toBe('string');
    }, 30_000);
});
