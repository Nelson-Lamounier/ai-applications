/** @format */
import { parsePeriod, unionYears, parseRequiredYears } from './years-gap.js';

describe('parsePeriod', () => {
    it('parses year ranges, month-year, Present, and suffixes', () => {
        expect(parsePeriod('2021 - 2022', 2026)).toEqual({ startYear: 2021, endYear: 2022 });
        expect(parsePeriod('2022 - Present', 2026)).toEqual({ startYear: 2022, endYear: 2026 });
        expect(parsePeriod('September 2022 - September 2024', 2026)).toEqual({ startYear: 2022, endYear: 2024 });
        expect(parsePeriod('2022 - Present (Part-time)', 2026)).toEqual({ startYear: 2022, endYear: 2026 });
    });
    it('returns null when unparseable', () => {
        expect(parsePeriod('whenever', 2026)).toBeNull();
    });
});

describe('unionYears', () => {
    it('merges overlapping intervals (no double count) and rounds to 1 dp', () => {
        expect(unionYears([{ startYear: 2022, endYear: 2026 }, { startYear: 2022, endYear: 2026 }, { startYear: 2021, endYear: 2022 }])).toBe(5);
    });
    it('sums disjoint intervals', () => {
        expect(unionYears([{ startYear: 2016, endYear: 2018 }, { startYear: 2021, endYear: 2024 }])).toBe(5);
    });
    it('returns 0 for empty', () => { expect(unionYears([])).toBe(0); });
});

describe('parseRequiredYears', () => {
    it('takes the lower bound / explicit floor', () => {
        expect(parseRequiredYears('8+')).toBe(8);
        expect(parseRequiredYears('3-5')).toBe(3);
        expect(parseRequiredYears('5')).toBe(5);
        expect(parseRequiredYears('5+ years')).toBe(5);
    });
    it('returns null when absent/unparseable', () => {
        expect(parseRequiredYears('')).toBeNull();
        expect(parseRequiredYears('senior')).toBeNull();
    });
});
