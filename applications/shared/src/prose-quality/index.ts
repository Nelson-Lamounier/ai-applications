/**
 * @format
 * Prose-quality — Public API. A flag-only prose critic that scores LLM prose
 * output against the forked stop-slop rules and lists AI-tell issues. Runs in the
 * same pipeline slot as the grounding verifier; never mutates persisted output.
 */
export { BedrockProseLinter } from './bedrock-prose-linter.js';
export { normalizeProse } from './normalize-prose.js';
export type {
    BedrockProseLinterConfig,
    ProseLinterCostContext,
} from './bedrock-prose-linter.js';
export { PROSE_PASS_THRESHOLD } from './rules/rubric.js';
export type {
    IProseLinter,
    ProseIssue,
    ProseLinterMode,
    ProseQualityInput,
    ProseQualityResult,
    ProseRegister,
    ProseScore,
    ProseSection,
} from './prose-quality-types.js';
