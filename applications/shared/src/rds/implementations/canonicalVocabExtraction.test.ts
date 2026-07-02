/** @format */
import {
    buildCanonicalExtractionBody,
    buildCanonicalPackExtractionBody,
    parseCanonicalSkills,
    parseCanonicalPackSkills,
    ENRICH_CANONICAL_SYSTEM_PROMPT,
    ENRICH_CANONICAL_PACK_SYSTEM_PROMPT,
} from './canonicalVocabExtraction.js';

describe('buildCanonicalExtractionBody', () => {
    it('puts the controlled vocabulary in the system prefix + forces the tool', () => {
        const body = buildCanonicalExtractionBody(['kubernetes', 'terraform'], 'a.ts', 'body') as Record<string, unknown>;
        const system = body.system as string;
        expect(system).toContain(ENRICH_CANONICAL_SYSTEM_PROMPT);
        expect(system).toContain('CONTROLLED VOCABULARY (2 terms');
        expect(system).toContain('kubernetes');
        expect(system).toContain('terraform');
        expect(body.tool_choice).toEqual({ type: 'tool', name: 'record_extraction' });
    });
});

describe('buildCanonicalPackExtractionBody', () => {
    const items = [
        { key: 'id-1', filePath: 'a.ts', content: 'uses kubernetes' },
        { key: 'id-2', filePath: 'b.md', content: 'terraform modules', heading: 'Infra' },
    ];

    it('pays the vocabulary once in the system prefix + forces the keyed pack tool', () => {
        const body = buildCanonicalPackExtractionBody(['kubernetes', 'terraform'], items) as Record<string, unknown>;
        const system = body.system as string;
        expect(system).toContain(ENRICH_CANONICAL_PACK_SYSTEM_PROMPT);
        expect(system).toContain('CONTROLLED VOCABULARY (2 terms');
        expect(body.tool_choice).toEqual({ type: 'tool', name: 'record_extractions' });
    });

    it('labels every chunk by its stable key and scales max_tokens with pack size', () => {
        const body = buildCanonicalPackExtractionBody(['kubernetes'], items) as Record<string, unknown>;
        const user = (body.messages as Array<{ content: string }>)[0].content;
        expect(user).toContain('=== CHUNK id-1 ===');
        expect(user).toContain('=== CHUNK id-2 ===');
        expect(body.max_tokens).toBe(128 + 2 * 160);
    });
});

describe('parseCanonicalPackSkills', () => {
    const vocab = new Set(['kubernetes', 'dynamodb']);

    it('splits each keyed entry through the SAME canonical/alias resolution', () => {
        const aliases = new Map([['aws dynamodb', 'dynamodb']]);
        const content = [{
            type: 'tool_use',
            name: 'record_extractions',
            input: { extractions: [
                { key: 'id-1', skills: ['kubernetes', 'NEW: webassembly'] },
                { key: 'id-2', skills: ['aws dynamodb'] },
            ] },
        }];
        const out = parseCanonicalPackSkills(content, vocab, aliases);
        expect(out.get('id-1')).toEqual({ canonical: ['kubernetes'], newSkills: ['webassembly'] });
        expect(out.get('id-2')).toEqual({ canonical: ['dynamodb'], newSkills: [] });
    });

    it('omits keys the model skipped (caller falls those back per-chunk)', () => {
        const content = [{
            type: 'tool_use',
            name: 'record_extractions',
            input: { extractions: [{ key: 'id-1', skills: ['kubernetes'] }] },
        }];
        const out = parseCanonicalPackSkills(content, vocab);
        expect(out.has('id-2')).toBe(false);
        expect(out.size).toBe(1);
    });

    it('returns an empty map when no tool_use is present', () => {
        expect(parseCanonicalPackSkills([{ type: 'text' }], vocab).size).toBe(0);
    });
});

describe('parseCanonicalSkills', () => {
    const vocab = new Set(['kubernetes', 'infrastructure as code', 'argocd']);

    it('keeps only in-vocabulary terms as canonical', () => {
        const r = parseCanonicalSkills(['kubernetes', 'argocd'], vocab);
        expect(r.canonical.sort((a, b) => a.localeCompare(b))).toEqual(['argocd', 'kubernetes']);
        expect(r.newSkills).toEqual([]);
    });

    it('routes an explicit NEW: term to the growth queue (prefix stripped)', () => {
        const r = parseCanonicalSkills(['kubernetes', 'NEW: webassembly'], vocab);
        expect(r.canonical).toEqual(['kubernetes']);
        expect(r.newSkills).toEqual(['webassembly']);
    });

    it('routes an off-vocab term WITHOUT the prefix to NEW (never pollutes canonical)', () => {
        const r = parseCanonicalSkills(['iac with cdk', 'kubernetes'], vocab);
        expect(r.canonical).toEqual(['kubernetes']);
        expect(r.newSkills).toEqual(['iac with cdk']);   // not in vocab -> gap, not a corpus skill
    });

    it('resolves an alias phrasing to its canonical instead of queuing it as NEW:', () => {
        const aliases = new Map([['aws dynamodb', 'dynamodb'], ['amazon dynamodb', 'dynamodb']]);
        const v = new Set(['kubernetes', 'dynamodb']);
        const r = parseCanonicalSkills(['aws dynamodb', 'NEW: amazon dynamodb', 'webassembly'], v, aliases);
        expect([...r.canonical].sort((a, b) => a.localeCompare(b))).toEqual(['dynamodb']);  // both alias forms -> canonical, deduped
        expect(r.newSkills).toEqual(['webassembly']);                                   // only the true gap remains
    });

    it('lowercases, trims, dedupes, drops empties/non-strings', () => {
        const r = parseCanonicalSkills(['  Kubernetes ', 'kubernetes', '', 42, 'NEW:  Rust '], vocab);
        expect(r.canonical).toEqual(['kubernetes']);
        expect(r.newSkills).toEqual(['rust']);
    });
});
