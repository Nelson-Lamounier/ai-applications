/** @format */
import { describe, it, expect } from '@jest/globals';
import { extractCoverLetter } from './strategist-agent.js';

const VALID_JSON = JSON.stringify({
    greeting:   'Dear Hiring Manager',
    paragraphs: ['I build production AI systems.', 'My background aligns well.'],
    signoff:    { name: 'Nelson', email: 'n@x.com', linkedin: 'linkedin/n', github: 'github/n' },
});

describe('extractCoverLetter', () => {
    it('parses a valid JSON CDATA block into a CoverLetter object', () => {
        const xml = `<analysis><cover_letter><![CDATA[${VALID_JSON}]]></cover_letter></analysis>`;
        const result = extractCoverLetter(xml);
        expect(result).not.toBeNull();
        expect(result?.greeting).toBe('Dear Hiring Manager');
        expect(result?.paragraphs).toEqual(['I build production AI systems.', 'My background aligns well.']);
        expect(result?.signoff.name).toBe('Nelson');
        expect(result?.signoff.email).toBe('n@x.com');
    });

    it('returns null when the cover_letter block is absent', () => {
        expect(extractCoverLetter('<analysis><other>stuff</other></analysis>')).toBeNull();
    });

    it('returns null when the CDATA contains plain prose (non-JSON)', () => {
        const xml = '<analysis><cover_letter><![CDATA[Dear Hiring Manager, I am writing...]]></cover_letter></analysis>';
        expect(extractCoverLetter(xml)).toBeNull();
    });

    it('returns null when JSON is valid but schema does not match', () => {
        const badJson = JSON.stringify({ greeting: 'Hi', paragraphs: 'not-an-array' });
        const xml = `<analysis><cover_letter><![CDATA[${badJson}]]></cover_letter></analysis>`;
        expect(extractCoverLetter(xml)).toBeNull();
    });

    it('returns null on empty string', () => {
        expect(extractCoverLetter('')).toBeNull();
    });
});
