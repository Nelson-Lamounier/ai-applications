/**
 * @format
 */

import { describe, it, expect } from '@jest/globals';
import { COACH_PERSONA_SYSTEM_PROMPT } from './coach-persona.js';

describe('COACH_PERSONA_SYSTEM_PROMPT', () => {
    it('instructs the phone-screen extra fields', () => {
        const text = COACH_PERSONA_SYSTEM_PROMPT.map(b => (b as { text?: string }).text ?? '').join('\n');
        expect(text).toContain('careerArcSummary');
        expect(text).toContain('jdTalkingPoints');
        expect(text).toContain('compScript');
        expect(text).toContain('do NOT invent');
    });
});
