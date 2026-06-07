/** @format */
import { stripCdata, deepStripCdata } from './strip-cdata.js';

describe('stripCdata', () => {
    it('unwraps a CDATA-wrapped string and trims inner whitespace', () => {
        expect(stripCdata('<![CDATA[\n**Title**\nbody]]>')).toBe('**Title**\nbody');
    });

    it('tolerates surrounding whitespace around the wrapper', () => {
        expect(stripCdata('  <![CDATA[hi]]>  ')).toBe('hi');
    });

    it('returns an unwrapped string unchanged', () => {
        expect(stripCdata('plain **markdown** text')).toBe('plain **markdown** text');
    });

    it('does not strip when only the opening delimiter is present', () => {
        const s = 'text <![CDATA[ not a wrapper';
        expect(stripCdata(s)).toBe(s);
    });

    it('does not strip a closing delimiter that appears mid-string', () => {
        const s = 'first half ]]> second half';
        expect(stripCdata(s)).toBe(s);
    });

    it('collapses an empty CDATA wrapper to an empty string', () => {
        expect(stripCdata('<![CDATA[]]>')).toBe('');
    });
});

describe('deepStripCdata', () => {
    it('strips CDATA from nested object string values', () => {
        const input = {
            coachingNotes: '<![CDATA[\nnotes]]>',
            technicalPrepChecklist: [
                { topic: 'X', rationale: '<![CDATA[why]]>' },
            ],
            count: 3,
            flag: true,
            empty: null,
        };
        expect(deepStripCdata(input)).toEqual({
            coachingNotes: 'notes',
            technicalPrepChecklist: [{ topic: 'X', rationale: 'why' }],
            count: 3,
            flag: true,
            empty: null,
        });
    });

    it('leaves a clean object structurally identical', () => {
        const clean = { a: 'plain', b: ['one', 'two'], c: 1 };
        expect(deepStripCdata(clean)).toEqual(clean);
    });
});
