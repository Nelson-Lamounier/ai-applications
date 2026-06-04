/**
 * @format
 * Prose-linter system prompt assembly. Single phase, no branches: a stop-slop
 * critic role + the forked rule set + rubric, with a Bedrock cachePoint after the
 * static rules (they never vary per call, so they cache across coach runs).
 */
import type { SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';

import { PHRASE_RULES } from '../rules/phrases.js';
import { STRUCTURE_RULES } from '../rules/structures.js';
import { RUBRIC_RULES, PROSE_PASS_THRESHOLD } from '../rules/rubric.js';

const ROLE = `You are a prose-quality critic. You catch the linguistic patterns that mark
text as AI-generated, and you score how human the prose reads.

You receive a document of <section> elements. Each section has a "location"
attribute (echo it verbatim in every issue you raise for that section) and a
"register" attribute that tells you the intended voice:
- resume-prose / storytelling: hold to the rules strictly.
- advice / narrative: business-formal phrasing is acceptable; only flag genuine
  AI-tells, not normal professional language.

Apply the phrase rules and structure rules below. For every violation, emit one
issue: category (phrase|structure), the offending text (match), the section
location, a severity, and the rule name (the nearest "## " heading).

Then score the whole document across the five rubric dimensions (each 1-10), sum
to a total out of 50, set belowThreshold = (total < ${PROSE_PASS_THRESHOLD}), and
set status = belowThreshold ? "FAIL" : "PASS".

Call the emit_prose_quality tool with your verdict. Do not output prose.`;

export function assembleProseLinterSystemPrompt(): SystemContentBlock[] {
    const rules = [ROLE, PHRASE_RULES, STRUCTURE_RULES, RUBRIC_RULES].join('\n\n');
    return [
        { text: rules } as SystemContentBlock,
        { cachePoint: { type: 'default' } } as SystemContentBlock,
    ];
}
