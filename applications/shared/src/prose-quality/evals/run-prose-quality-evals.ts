/** @format */
/**
 * Tier-2 live eval for the prose linter. Gated behind RUN_LIVE_EVALS=1 so default
 * jest/CI never call Bedrock. Run before any prompt/rule change:
 *   RUN_LIVE_EVALS=1 npx tsx src/prose-quality/evals/run-prose-quality-evals.ts
 *
 * Asserts: clean fixture scores >= minTotal with no high-severity issues; slop
 * fixture returns FAIL and catches each `mustMatch` phrase (by issue.match).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BedrockProseLinter } from '../bedrock-prose-linter.js';
import type { ProseQualityInput } from '../prose-quality-types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadFixture(name: string): any {
    // __dirname is available in CJS context (shared package type=commonjs).
    // tsx resolves it correctly when running this script directly.
    return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clean: any = loadFixture('clean.json');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const slop: any = loadFixture('slop.json');

const LIVE_ENABLED = process.env['RUN_LIVE_EVALS'] === '1';

async function main(): Promise<void> {
    if (!LIVE_ENABLED) {
        // eslint-disable-next-line no-console
        console.log('RUN_LIVE_EVALS not set — skipping prose-quality live evals.');
        return;
    }
    const linter = new BedrockProseLinter({ mode: 'flag' });
    const failures: string[] = [];

    const cleanRes = await linter.lint({ sections: clean.sections, stage: clean.stage } as ProseQualityInput);
    if (cleanRes.score.total < clean.expect.minTotal) {
        failures.push(`clean: total ${cleanRes.score.total} < ${clean.expect.minTotal}`);
    }
    if (clean.expect.noHighSeverity && cleanRes.issues.some(i => i.severity === 'high')) {
        failures.push(`clean: unexpected high-severity issue(s): ${JSON.stringify(cleanRes.issues)}`);
    }

    const slopRes = await linter.lint({ sections: slop.sections, stage: slop.stage } as ProseQualityInput);
    if (slopRes.status !== 'FAIL') failures.push(`slop: expected FAIL, got ${slopRes.status}`);
    for (const phrase of slop.expect.mustMatch) {
        if (!slopRes.issues.some(i => i.match.includes(phrase))) {
            failures.push(`slop: did not catch "${phrase}"`);
        }
    }

    if (failures.length) {
        // eslint-disable-next-line no-console
        console.error('PROSE EVAL FAILURES:\n' + failures.join('\n'));
        process.exitCode = 1;
    } else {
        // eslint-disable-next-line no-console
        console.log('Prose-quality live evals PASSED (clean + slop).');
    }
}

void main();
