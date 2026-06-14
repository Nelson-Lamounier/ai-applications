/** @format */
import type { Pool } from 'pg';
import { RdsUserProfileRollupRepository, formatProfileIntelligence, log } from '@bedrock/shared';

/**
 * Load + format the candidate's "Profile Intelligence" (the code-grounded
 * synthesis written to user_profile_rollup on repo sync) into a prompt block for
 * the research + strategist agents: code-demonstrated direction/seniority,
 * under-represented strengths to surface, and unsupported résumé claims to avoid
 * leaning on.
 *
 * Fail-open: profile intelligence is additive, so any failure (or a user with no
 * synthesised profile yet) returns '' and the pipeline proceeds on KB + career +
 * project evidence as before. Kill-switch: PROFILE_INTELLIGENCE_DISABLE=true.
 */
export async function loadProfileIntelligenceBlock(pool: Pool, userId: string): Promise<string> {
    if (process.env['PROFILE_INTELLIGENCE_DISABLE'] === 'true') return '';
    try {
        const row = await new RdsUserProfileRollupRepository(pool).getRollup(userId);
        if (!row) return '';
        const block = formatProfileIntelligence({ direction: row.direction, reconciliation: row.reconciliation });
        log('INFO', 'Profile intelligence loaded', {
            agent: 'strategist',
            hasDirection: row.direction != null,
            hasReconciliation: row.reconciliation != null,
            blockKb: block.length > 0 ? (block.length / 1024).toFixed(1) : 'empty',
        });
        return block;
    } catch (e) {
        log('WARN', 'profile intelligence load failed (non-fatal)', { agent: 'strategist', error: (e as Error).message });
        return '';
    }
}
