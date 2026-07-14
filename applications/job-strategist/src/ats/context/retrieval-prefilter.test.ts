/** @format */
import { buildRetrievalPrefilter } from './retrieval-prefilter.js';

const GROUPS: string[][] = [['openai', 'claude', 'anthropic', 'bedrock']];
const ALIAS = new Map<string, string>([
    ['openai api', 'openai'],
    ['kubernetes', 'kubernetes'],
    ['eks', 'aws_eks'],
]);

describe('buildRetrievalPrefilter', () => {
    it('lowercases + dedupes JD skills', () => {
        const p = buildRetrievalPrefilter(['React', 'react', 'AWS '], [], [], new Map());
        expect(p.skills).toEqual(['react', 'aws']);
    });

    it('resolves JD tech to canonicals (alias + normalized fallback)', () => {
        const p = buildRetrievalPrefilter([], ['OpenAI API', 'Kubernetes', 'Some New Tool'], [], ALIAS);
        expect(p.tech).toEqual(expect.arrayContaining(['openai', 'kubernetes', 'some_new_tool']));
    });

    it('TRANSFER-AWARE: expands a JD tech with its transfer-group siblings', () => {
        const p = buildRetrievalPrefilter([], ['OpenAI API'], GROUPS, ALIAS);
        // openai resolved → its group {claude, anthropic, bedrock} added so transferable evidence survives
        expect(p.tech).toEqual(expect.arrayContaining(['openai', 'claude', 'anthropic', 'bedrock']));
    });

    it('does not expand when the tech is in no group', () => {
        const p = buildRetrievalPrefilter([], ['Kubernetes'], GROUPS, ALIAS);
        expect(p.tech).toEqual(['kubernetes']);
    });

    it('empty JD → empty prefilter', () => {
        const p = buildRetrievalPrefilter([], [], GROUPS, ALIAS);
        expect(p).toEqual({ skills: [], tech: [] });
    });

    it('canonicalisation divergence fix: a punctuation-bearing term with no alias hit resolves via the shared normalizeTerm-based fallback (Node.js -> node_js, not "node.js")', () => {
        const p = buildRetrievalPrefilter([], ['Node.js'], [], new Map());
        expect(p.tech).toEqual(['node_js']);
    });
});
