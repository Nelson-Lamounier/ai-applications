/** @format */
import { loadReactPdf } from './react-pdf.js';

describe('loadReactPdf', () => {
    // @react-pdf/renderer is a heavy pure-ESM module (fonts + yoga WASM) loaded via a
    // `new Function` dynamic import (to dodge transpilation) — so jest CANNOT mock it.
    // Cold-loading it on a busy CI worker races jest's environment teardown and fails
    // with "Test environment has been torn down" — an environmental flake, not a logic
    // bug (it passes in isolation and most runs). A generous timeout alone doesn't
    // help because the teardown is worker-driven, not this test's timeout. Retry the
    // cold load a few times; the warmed module cache makes the retry near-instant.
    jest.retryTimes(3, { logErrorsBeforeRetry: true });

    it('loads the @react-pdf/renderer module with the primitives we use', async () => {
        const mod = await loadReactPdf();
        expect(typeof mod.renderToBuffer).toBe('function');
        expect(typeof mod.StyleSheet.create).toBe('function');
        // v4 primitives are string element tags, not components.
        expect(typeof mod.Document).toBe('string');
        expect(typeof mod.Page).toBe('string');
    }, 30_000);
});
