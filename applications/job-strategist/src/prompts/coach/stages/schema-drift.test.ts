/**
 * @format
 * Coach delta ↔ tool-schema drift guard.
 *
 * The stage deltas are prose that NAMES contract fields ("ALSO emit these
 * fields: careerArcSummary, jdTalkingPoints {point, evidence, matchedSkills}").
 * The field names' single source of truth is the coach tool schema in
 * coach-agent.ts; this suite fails when the two drift:
 *
 *  1. a schema field is renamed while a delta still instructs the old name
 *     (every camelCase token in delta prose must exist in the schema), and
 *  2. a stage's REQUIRED fields stop being mentioned by that stage's delta
 *     (the model is never told about a field the tool forces it to emit).
 *
 * This is the contracts-stay-in-typed-code caveat, enforced — a precondition
 * for ever migrating the delta prose to content/*.md.
 */
import { describe, it, expect } from '@jest/globals';
import { coachToolForStage } from '../../../agents/coach/coach-agent.js';
import { COACH_BASE_TEXT } from '../base.js';
import { PHONE_SCREEN_DELTA } from './phone-screen.js';
import { TECHNICAL_DELTA } from './technical.js';
import { BEHAVIOURAL_DELTA } from './behavioural.js';
import { SYSTEM_DESIGN_DELTA } from './system-design.js';
import { BAR_RAISER_DELTA } from './bar-raiser.js';
import { FINAL_DELTA } from './final.js';

const DELTAS: Record<string, string> = {
    'phone-screen':  PHONE_SCREEN_DELTA,
    'technical-1':   TECHNICAL_DELTA,
    'behavioural':   BEHAVIOURAL_DELTA,
    'system-design': SYSTEM_DESIGN_DELTA,
    'bar-raiser':    BAR_RAISER_DELTA,
    'final':         FINAL_DELTA,
};

/** Every property name reachable in a JSON-schema subtree. */
function collectPropertyNames(node: unknown, out: Set<string>): Set<string> {
    if (typeof node !== 'object' || node === null) return out;
    const n = node as Record<string, unknown>;
    if (typeof n['properties'] === 'object' && n['properties'] !== null) {
        for (const [key, child] of Object.entries(n['properties'] as Record<string, unknown>)) {
            out.add(key);
            collectPropertyNames(child, out);
        }
    }
    if (n['items']) collectPropertyNames(n['items'], out);
    return out;
}

const baseTool = coachToolForStage('general');
const SCHEMA_FIELDS = collectPropertyNames(baseTool.inputSchema, new Set<string>());

/** Non-field camelCase vocabulary the prose legitimately uses. */
const PROSE_ALLOWLIST = new Set<string>([]);

const camelTokens = (text: string): string[] =>
    [...new Set(text.match(/\b[a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g) ?? [])];

describe('coach delta prose names only real schema fields', () => {
    it.each(Object.entries({ base: COACH_BASE_TEXT, ...DELTAS }))(
        '%s — every camelCase token resolves to a coach tool schema property',
        (_name, text) => {
            const unknown = camelTokens(text).filter((t) => !SCHEMA_FIELDS.has(t) && !PROSE_ALLOWLIST.has(t));
            expect(unknown).toEqual([]);
        },
    );
});

describe('stage-required fields are instructed by that stage delta', () => {
    const stages = ['phone-screen', 'system-design', 'bar-raiser', 'final'] as const;

    it.each(stages)('%s — delta mentions every field its tool variant requires', (stage) => {
        const extraRequired = coachToolForStage(stage).inputSchema.required
            .filter((f: string) => !baseTool.inputSchema.required.includes(f));
        expect(extraRequired.length).toBeGreaterThan(0);
        const delta = DELTAS[stage === 'phone-screen' ? 'phone-screen' : stage]!;
        const missing = extraRequired.filter((f: string) => !delta.includes(f));
        expect(missing).toEqual([]);
    });
});
