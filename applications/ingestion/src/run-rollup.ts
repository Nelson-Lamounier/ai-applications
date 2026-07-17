/**
 * @format
 * Rollup-refresh K8s Job entrypoint — recomputes a user's profile rollup +
 * LLM synthesis WITHOUT re-ingesting any repo.
 *
 * Why this exists: run-ingestion.ts is the only place that calls
 * refreshUserProfileRollup, so the only way to (re)generate the Mirror/Reveal,
 * Direction, Reconciliation and Diagnostic outputs was a full re-embed
 * (~minutes per repo). This lightweight entrypoint re-reads the user's existing
 * repository_profiles and runs synthesis only — the cheap backfill for users
 * whose synthesis columns are NULL (e.g. ingested before the model env vars
 * were injected), and the basis for a future "Regenerate profile" action.
 *
 * Env vars:
 *   USER_ID                                          — required
 *   PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD
 *   AWS_REGION (or AWS_DEFAULT_REGION)               — Bedrock via IRSA
 *   PROFILE_EXTRACTOR_MODEL_ID + MIRROR_REVEAL_MODEL_ID / DIRECTION_MODEL_ID /
 *   RECONCILIATION_MODEL_ID / DIAGNOSTIC_MODEL_ID    — synthesis models
 *
 * Exit codes: 0 = rollup refreshed (best-effort; synthesis failures are logged
 * but do not fail the Job), 1 = fatal (bad env / DB unreachable).
 */

import {
    RdsUserProfileRollupRepository,
    RdsCareerHistoryReadRepository,
    RdsDiagnosticInputsReadRepository,
    bootstrapK8sObservability,
    pushFinalMetrics,
} from '@bedrock/shared';
import { Pool } from 'pg';

import { MirrorRevealSynthesizer } from './narrative/MirrorRevealSynthesizer.js';
import { DirectionSynthesizer } from './narrative/DirectionSynthesizer.js';
import { ReconciliationSynthesizer } from './narrative/ReconciliationSynthesizer.js';
import { DiagnosticNarrator } from './narrative/DiagnosticNarrator.js';
import { refreshUserProfileRollup } from './util/refreshUserProfileRollup.js';

const obs = bootstrapK8sObservability({ serviceName: 'rollup-refresh' });
const log = obs.logger;

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

async function main(): Promise<void> {
    const userId = requireEnv('USER_ID');

    const pgPool = new Pool({
        host:     requireEnv('PG_HOST'),
        port:     Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
        database: requireEnv('PG_DATABASE'),
        user:     requireEnv('PG_USER'),
        password: requireEnv('PG_PASSWORD'),
        max:      3,
    });

    log.info({ userId }, 'rollup_refresh.start');

    try {
        const rollupRepo           = new RdsUserProfileRollupRepository(pgPool);
        const mirrorSynth          = MirrorRevealSynthesizer.fromEnvironment(pgPool, userId);
        const directionSynth       = DirectionSynthesizer.fromEnvironment(pgPool, userId);
        const careerRepo           = new RdsCareerHistoryReadRepository(pgPool);
        const reconciliationSynth  = ReconciliationSynthesizer.fromEnvironment(pgPool, userId);
        const diagnosticInputsRepo = new RdsDiagnosticInputsReadRepository(pgPool);
        const diagnosticNarrator   = DiagnosticNarrator.fromEnvironment(pgPool, userId);

        const disabled = [
            !mirrorSynth         && 'mirror',
            !directionSynth      && 'direction',
            !reconciliationSynth && 'reconciliation',
        ].filter(Boolean);
        if (disabled.length > 0) {
            log.warn({
                event:  'synthesizer_disabled',
                stages: disabled,
                reason: 'model id env var unset (PROFILE_EXTRACTOR_MODEL_ID / per-stage *_MODEL_ID)',
                userId,
            }, 'profile synthesizers disabled — rollup synthesis will be skipped');
        }

        await refreshUserProfileRollup(
            rollupRepo, userId, mirrorSynth, directionSynth, reconciliationSynth,
            careerRepo, diagnosticNarrator, diagnosticInputsRepo,
        );

        log.info({ event: 'rollup_refresh.complete', userId }, 'rollup refreshed');
    } finally {
        await pgPool.end().catch(() => { /* best-effort drain */ });
        await pushFinalMetrics(obs.registry, 'rollup-refresh', userId).catch(() => { /* best-effort */ });
        await obs.shutdown().catch(() => { /* flush spans */ });
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        log.error({ err }, 'rollup_refresh.failed');
        process.exit(1);
    });
