/** @format */
import { loadReactPdf } from './react-pdf.js';

describe('loadReactPdf', () => {
    it('loads the @react-pdf/renderer module with the primitives we use', async () => {
        const mod = await loadReactPdf();
        expect(typeof mod.renderToBuffer).toBe('function');
        expect(typeof mod.StyleSheet.create).toBe('function');
        // v4 primitives are string element tags, not components.
        expect(typeof mod.Document).toBe('string');
        expect(typeof mod.Page).toBe('string');
    });
});
