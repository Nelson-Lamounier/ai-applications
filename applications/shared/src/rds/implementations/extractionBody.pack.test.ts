/** @format */
import {
    buildPackExtractionBody,
    parsePackSkills,
    ENRICH_SYSTEM_PROMPT,
    type PackBodyItem,
} from './extractionBody.js';

function item(key: string, content = 'body'): PackBodyItem {
    return { key, filePath: `${key}.ts`, content };
}

describe('buildPackExtractionBody', () => {
    it('reuses the per-chunk system prompt and forces the keyed array tool', () => {
        const body = buildPackExtractionBody([item('a'), item('b')]) as Record<string, unknown>;
        expect(body.system).toBe(ENRICH_SYSTEM_PROMPT);                 // same prompt, paid once
        expect(body.tool_choice).toEqual({ type: 'tool', name: 'record_extractions' });
        const msg = (body.messages as Array<{ content: string }>)[0].content;
        expect(msg).toContain('=== CHUNK a ===');
        expect(msg).toContain('=== CHUNK b ===');
    });

    it('scales max_tokens with pack size', () => {
        const small = buildPackExtractionBody([item('a')]).max_tokens as number;
        const big = buildPackExtractionBody(Array.from({ length: 20 }, (_, i) => item(`k${i}`))).max_tokens as number;
        expect(big).toBeGreaterThan(small);
    });
});

describe('parsePackSkills', () => {
    const block = (extractions: unknown) => [{ type: 'tool_use', name: 'record_extractions', input: { extractions } }];

    it('keys skills by chunk id (not positional)', () => {
        const m = parsePackSkills(block([{ key: 'b', skills: ['x'] }, { key: 'a', skills: ['y'] }]));
        expect(m.get('a')).toEqual(['y']);
        expect(m.get('b')).toEqual(['x']);
    });

    it('leaves a missing key absent (caller falls back), ignores extras', () => {
        const m = parsePackSkills(block([{ key: 'a', skills: ['x'] }, { key: 'zzz', skills: ['e'] }]));
        expect(m.has('a')).toBe(true);
        expect(m.has('b')).toBe(false);     // 'b' absent -> fallback
        expect(m.get('zzz')).toEqual(['e']); // extra retained but harmless (caller only reads its keys)
    });

    it('duplicate key is last-wins; malformed entries dropped', () => {
        const m = parsePackSkills(block([{ key: 'a', skills: ['1'] }, { key: 'a', skills: ['2'] }, { nope: true }, { key: 'c' }]));
        expect(m.get('a')).toEqual(['2']);
        expect(m.has('c')).toBe(false);     // no skills array -> dropped
    });

    it('returns empty when the tool_use / extractions is absent or malformed', () => {
        expect(parsePackSkills([{ type: 'text', name: undefined }]).size).toBe(0);
        expect(parsePackSkills(block('not-an-array')).size).toBe(0);
    });
});
