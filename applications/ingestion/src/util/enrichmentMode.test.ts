import { normalizeEnrichmentMode } from './enrichmentMode.js';
test('maps worker modes to stored values', () => {
    expect(normalizeEnrichmentMode('premium')).toBe('llm');
    expect(normalizeEnrichmentMode('free-tier1-only')).toBe('tier1');
    expect(normalizeEnrichmentMode('disabled')).toBe('none');
});
