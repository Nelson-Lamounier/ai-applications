import { describe, it, expect, beforeEach } from '@jest/globals';
import { parseCoachEnv } from './env-coach.js';

const REQUIRED = {
    COACH_PIPELINE_RUN_ID: 'c', STRATEGIST_PIPELINE_RUN_ID: 's', APPLICATION_ID: 'a',
    APPLICATION_SLUG: 'slug', USER_ID: 'u', TARGET_COMPANY: 'Acme', TARGET_ROLE: 'Senior Backend',
    JOB_DESCRIPTION: 'jd', INTERVIEW_STAGE: 'phone-screen',
    PG_HOST: 'h', PG_DATABASE: 'd', PG_USER: 'pu', PG_PASSWORD: 'pw',
};

describe('parseCoachEnv', () => {
    beforeEach(() => {
        for (const k of Object.keys(process.env)) {
            if (k.startsWith('PG_') || REQUIRED[k as keyof typeof REQUIRED] !== undefined ||
                k === 'COMPENSATION_TARGET' || k === 'REGION') delete process.env[k];
        }
        Object.assign(process.env, REQUIRED);
    });

    it('defaults region to eu-remote and compTarget to null', () => {
        const env = parseCoachEnv();
        expect(env.region).toBe('eu-remote');
        expect(env.compTarget).toBeNull();
    });

    it('parses COMPENSATION_TARGET and REGION when present', () => {
        process.env.COMPENSATION_TARGET = '95000';
        process.env.REGION = 'uk';
        const env = parseCoachEnv();
        expect(env.compTarget).toBe('95000');
        expect(env.region).toBe('uk');
    });
});
