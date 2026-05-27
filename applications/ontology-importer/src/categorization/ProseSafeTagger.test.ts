/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildConverseRequest, parseConverseResponse, verdictToProseSafe, PROSE_SAFE_MODEL_DEFAULT } from './ProseSafeTagger.js';

describe('buildConverseRequest', () => {
    it('includes the alias, canonical, and category in the user message', () => {
        const body = buildConverseRequest({ alias: 'k8s', canonical: 'kubernetes', category: 'orchestration' });
        const text = body.messages[0].content[0].text;
        expect(text).toContain('Alias: k8s');
        expect(text).toContain('Canonical: kubernetes');
        expect(text).toContain('Category: orchestration');
    });
    it('forces the tag_alias tool via toolChoice', () => {
        const body = buildConverseRequest({ alias: 'go', canonical: 'go', category: 'language' });
        expect(body.toolConfig.toolChoice).toEqual({ tool: { name: 'tag_alias' } });
        expect(body.toolConfig.tools[0].toolSpec.name).toBe('tag_alias');
    });
    it('embeds calibration few-shot in the system prompt', () => {
        const body = buildConverseRequest({ alias: 'x', canonical: 'x', category: 'x' });
        const sys = body.system[0].text;
        // a few calibration markers
        expect(sys).toContain('"kubernetes"');
        expect(sys).toContain('"go"');
        expect(sys).toContain('"react"');
        expect(sys).toContain('Calibration examples');
    });
    it('embeds F4 cloud-prefix compound-form calibration (post-2026-05-27)', () => {
        const body = buildConverseRequest({ alias: 'x', canonical: 'x', category: 'x' });
        const sys = body.system[0].text;
        expect(sys).toContain('"aws_bedrock"');
        expect(sys).toContain('"amazon_cognito"');
        expect(sys).toContain('"azure_sql"');
        expect(sys).toMatch(/aws\|amazon\|azure\|google\|gcp\|apache/);
    });
    it('sets temperature 0 for deterministic classification', () => {
        const body = buildConverseRequest({ alias: 'x', canonical: 'x', category: 'x' });
        expect(body.inferenceConfig.temperature).toBe(0);
    });
});

describe('parseConverseResponse', () => {
    it('extracts a yes verdict + reasoning', () => {
        const out = parseConverseResponse({
            output: { message: { content: [{ toolUse: { name: 'tag_alias', input: { prose_safe: 'yes', reasoning: 'distinctive proper noun' } } }] } },
        });
        expect(out).toEqual({ verdict: 'yes', reasoning: 'distinctive proper noun' });
    });
    it('extracts no', () => {
        const out = parseConverseResponse({
            output: { message: { content: [{ toolUse: { name: 'tag_alias', input: { prose_safe: 'no', reasoning: 'common verb' } } }] } },
        });
        expect(out.verdict).toBe('no');
    });
    it('defaults to maybe when no tool_use returned', () => {
        const out = parseConverseResponse({ output: { message: { content: [] } } });
        expect(out.verdict).toBe('maybe');
    });
    it('defaults to maybe on missing response shape', () => {
        expect(parseConverseResponse({}).verdict).toBe('maybe');
    });
    it('coerces unrecognised verdict strings to maybe', () => {
        const out = parseConverseResponse({
            output: { message: { content: [{ toolUse: { name: 'tag_alias', input: { prose_safe: 'definitely', reasoning: 'idk' } } }] } },
        });
        expect(out.verdict).toBe('maybe');
    });
    it('handles case-variant verdicts (YES → yes)', () => {
        const out = parseConverseResponse({
            output: { message: { content: [{ toolUse: { name: 'tag_alias', input: { prose_safe: 'YES', reasoning: 'ok' } } }] } },
        });
        expect(out.verdict).toBe('yes');
    });
});

describe('verdictToProseSafe', () => {
    it('yes → true, no → false, maybe → null', () => {
        expect(verdictToProseSafe('yes')).toBe(true);
        expect(verdictToProseSafe('no')).toBe(false);
        expect(verdictToProseSafe('maybe')).toBeNull();
    });
});

describe('PROSE_SAFE_MODEL_DEFAULT', () => {
    it('is the eu cross-region Haiku 4.5 inference profile', () => {
        expect(PROSE_SAFE_MODEL_DEFAULT).toBe('eu.anthropic.claude-haiku-4-5-20251001-v1:0');
    });
});
