/** @format */
import { capHighlights } from './experience-cap.js';

describe('capHighlights', () => {
	it('truncates a role to the first `max` highlights (default 5)', () => {
		const exp = [{ company: 'X', title: 't', period: 'p', highlights: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }];
		const out = capHighlights(exp);
		expect(out[0].highlights).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].slice(0, 5));
		expect(out[0].highlights).toHaveLength(5);
	});
	it('leaves a role with <= max highlights unchanged', () => {
		const exp = [{ company: 'X', title: 't', period: 'p', highlights: ['a', 'b', 'c'] }];
		expect(capHighlights(exp)[0].highlights).toEqual(['a', 'b', 'c']);
	});
	it('keeps relevance order (first N), not a reordering', () => {
		const exp = [{ company: 'X', title: 't', period: 'p', highlights: ['1', '2', '3', '4', '5', '6'] }];
		expect(capHighlights(exp, 3)[0].highlights).toEqual(['1', '2', '3']);
	});
	it('is safe when highlights is missing or empty', () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(capHighlights([{ company: 'X', title: 't', period: 'p' } as any])[0].highlights).toEqual([]);
		expect(capHighlights([{ company: 'X', title: 't', period: 'p', highlights: [] }])[0].highlights).toEqual([]);
	});
	it('does not mutate the input array entries', () => {
		const exp = [{ company: 'X', title: 't', period: 'p', highlights: ['a', 'b', 'c', 'd', 'e', 'f'] }];
		capHighlights(exp);
		expect(exp[0].highlights).toHaveLength(6);
	});
});
