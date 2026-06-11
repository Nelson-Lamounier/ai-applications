/** @format */
jest.mock('@bedrock/shared', () => ({ runAgent: jest.fn(), log: () => undefined }));
import { runAgent } from '@bedrock/shared';
import { parsePeriod, unionYears, parseRequiredYears } from './years-gap.js';
import { buildYearsGap } from './years-gap.js';

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
