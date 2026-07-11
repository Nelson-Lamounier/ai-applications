/** @format */
jest.mock('@bedrock/shared', () => ({ runAgent: jest.fn(), log: () => undefined }));
import { runAgent } from '@bedrock/shared';
import { parsePeriod, unionYears, parseRequiredYears, reconcileFramingYears, buildYearsGap } from '../years-gap.js';

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

describe('reconcileFramingYears (anti-undersell)', () => {
    it('replaces an undersold number with the true union', () => {
        expect(reconcileFramingYears('approximately 3 years across user operations and support', 5))
            .toBe('approximately 5 years across user operations and support');
    });
    it('leaves the line unchanged when it already states the true union', () => {
        expect(reconcileFramingYears('5 years across X', 5)).toBe('5 years across X');
    });
    it('leaves the line unchanged when it states MORE than the union', () => {
        expect(reconcileFramingYears('7 years across X', 5)).toBe('7 years across X');
    });
    it('handles a "N+ years" form, preserving the plus', () => {
        expect(reconcileFramingYears('3+ years of relevant work', 5)).toBe('5+ years of relevant work');
    });
    it('prefixes the true count when the line has no number', () => {
        expect(reconcileFramingYears('relevant breadth across support and QA', 5))
            .toBe('5 years — relevant breadth across support and QA');
    });
    it('returns empty for an empty line', () => {
        expect(reconcileFramingYears('', 5)).toBe('');
    });
});

const mockRun = runAgent as jest.Mock;
const ROLES = [
    { title: 'Technical Customer Service Associate', company: 'AWS', period: '2022 - Present', family: 'technical-support', roleClass: 'customer_facing' },
    { title: 'Quality Assurance Analyst', company: 'Meta', period: '2021 - 2022', family: 'qa-engineering', roleClass: 'hybrid' },
    { title: 'Digital Marketer', company: 'X', period: '2016 - 2020', family: 'marketing', roleClass: 'hybrid' },
];

describe('buildYearsGap', () => {
    it('uses the agent-selected relevant roles for the union + framing, and computes the gap', async () => {
        mockRun.mockResolvedValue({ data: { relevantTitles: ['Technical Customer Service Associate', 'Quality Assurance Analyst'], framingLine: '5 years across user operations, technical support, and content operations' } });
        const yg = await buildYearsGap(ROLES, '8+', false, 2026);
        expect(yg?.relevantYears).toBe(5);
        expect(yg?.requiredYears).toBe(8);
        expect(yg?.gapYears).toBe(3);
        expect(yg?.framingLine).toMatch(/5 years/);
        expect(yg?.relevantRoleTitles).toEqual(['Technical Customer Service Associate', 'Quality Assurance Analyst']);
    });
    it('corrects an undersold framing line up to the deterministic union', async () => {
        mockRun.mockResolvedValue({ data: { relevantTitles: ['Technical Customer Service Associate', 'Quality Assurance Analyst'], framingLine: 'approximately 3 years across support and QA' } });
        const yg = await buildYearsGap(ROLES, '8+', false, 2026);
        expect(yg?.relevantYears).toBe(5);
        expect(yg?.framingLine).toBe('approximately 5 years across support and QA');
    });
    it('leaves a framing line that already states the union untouched', async () => {
        mockRun.mockResolvedValue({ data: { relevantTitles: ['Technical Customer Service Associate', 'Quality Assurance Analyst'], framingLine: '5 years across support and QA' } });
        const yg = await buildYearsGap(ROLES, '8+', false, 2026);
        expect(yg?.framingLine).toBe('5 years across support and QA');
    });
    it('disqualifying only when the JD years bar is flagged AND still short', async () => {
        mockRun.mockResolvedValue({ data: { relevantTitles: ['Technical Customer Service Associate'], framingLine: '4 years in support' } });
        const yg = await buildYearsGap(ROLES, '8+', true, 2026);
        expect(yg?.disqualifying).toBe(true);
    });
    it('agent failure → falls back to ALL parseable roles + a plain framing line', async () => {
        mockRun.mockRejectedValue(new Error('bedrock down'));
        const yg = await buildYearsGap(ROLES, '8+', false, 2026);
        expect(yg?.relevantYears).toBeGreaterThan(0);
        expect(yg?.framingLine).toMatch(/years/);
    });
    it('returns null when there are no parseable roles', async () => {
        mockRun.mockResolvedValue({ data: { relevantTitles: [], framingLine: '' } });
        expect(await buildYearsGap([{ title: 'X', company: 'Y', period: 'whenever', family: null, roleClass: null }], '8+', false, 2026)).toBeNull();
    });
});
