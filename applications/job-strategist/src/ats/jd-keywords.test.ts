/** @format */
import { collectJdMustHaves } from './jd-keywords.js';
import type { JdSignal } from '@bedrock/shared';

const ti = (over: Partial<JdSignal['technologyInventory']> = {}): Pick<JdSignal, 'technologyInventory'> => ({
    technologyInventory: {
        languages: [], frameworks: [], infrastructure: [], tools: [], methodologies: [],
        ...over,
    },
});

describe('collectJdMustHaves', () => {
    it('collects atomic terms from every technologyInventory category', () => {
        const got = collectJdMustHaves(ti({
            tools: ['OpenAI API', 'ChatGPT'],
            languages: ['Python'],
            methodologies: ['incident response', 'root cause analysis'],
            infrastructure: ['AWS'],
            frameworks: ['React'],
        }));
        expect(got).toEqual(expect.arrayContaining([
            'OpenAI API', 'ChatGPT', 'Python', 'incident response', 'root cause analysis', 'AWS', 'React',
        ]));
    });

    it('dedupes case-insensitively and trims', () => {
        const got = collectJdMustHaves(ti({ tools: ['Python', ' python ', 'PYTHON'], languages: ['python'] }));
        expect(got).toEqual(['Python']);
    });

    it('caps output at 18 terms', () => {
        const many = Array.from({ length: 30 }, (_, i) => `term${i}`);
        expect(collectJdMustHaves(ti({ tools: many })).length).toBe(18);
    });

    it('empty inventory → empty list', () => {
        expect(collectJdMustHaves(ti())).toEqual([]);
    });
});
