/** @format */
import { Pool } from 'pg';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
    TechnologyEvidenceRepository,
    bootstrapK8sObservability, pushFinalMetrics,
    RdsDsaEvidenceRepository, RdsAiEvidenceRepository,
} from '@bedrock/shared';
import { Counter } from 'prom-client';

import { parseEnv, type TechExtractEnv } from './env-tech-extract.js';
import { fetchTarball } from './acquisition/tarball/fetchTarball.js';
import { safeExtract } from './acquisition/tarball/safeExtract.js';
import { runFactsStage, type LaneGates } from './facts/run-facts-stage.js';

const MAX_TARBALL_BYTES = Number(process.env.MAX_TARBALL_BYTES ?? 200 * 1024 * 1024);

const obs = bootstrapK8sObservability({ serviceName: 'tech-extractor' });
const log = obs.logger;

const extractorFailed = new Counter({
    name: 'tech_extractor_extractor_failed_total', help: 'Extractor failures by name.',
    labelNames: ['extractor'] as const, registers: [obs.registry],
});

async function withTimeout(p: Promise<unknown>, ms: number, label: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(() => { log.warn({ label }, 'teardown timed out'); resolve(); }, ms); });
    try { await Promise.race([p.then(() => undefined).catch(() => undefined), timeout]); }
    finally { if (timer) clearTimeout(timer); }
}

/**
 * Per-lane idempotency: tech and DSA each own their own commit short-circuit, so
 * adding the DSA lane does not inherit tech's cache gate (and vice versa).
 * Computed ONCE, from the RAW env commit sha — in HEAD mode (COMMIT_SHA unset)
 * all gates are false, so the lanes always re-run even when the tarball later
 * resolves to an already-scanned sha (pre-refactor behaviour). These same gates
 * are passed into runFactsStage; it never recomputes them.
 */
async function computeLaneGates(
    env: TechExtractEnv, evidenceRepo: TechnologyEvidenceRepository,
    dsaEvidenceRepo: RdsDsaEvidenceRepository, aiEvidenceRepo: RdsAiEvidenceRepository,
): Promise<LaneGates> {
    if (!env.commitSha) return { techDone: false, dsaDone: false, aiDone: false };
    const techDone = await evidenceRepo.hasEvidenceForCommit(env.userId, env.repoFullName, env.commitSha);
    const dsaDone = await dsaEvidenceRepo.hasDsaScanForCommit(env.userId, env.repoFullName, env.commitSha);
    const aiDone = await aiEvidenceRepo.hasAiScanForCommit(env.userId, env.repoFullName, env.commitSha);
    return { techDone, dsaDone, aiDone };
}

/** Only skip the whole job — and the tarball download — when ALL THREE lanes are done. */
function allLanesDone(gates: LaneGates): boolean {
    return gates.techDone && gates.dsaDone && gates.aiDone;
}

type TarballResult = { readonly tooLarge: true } | { readonly tooLarge: false; readonly resolvedSha: string | undefined };

/**
 * Fetch + extract the tarball. `resolvedSha` is the real HEAD sha the
 * redirect resolved to (only meaningful when `env.commitSha` was unset —
 * evidence is NEVER persisted under the literal 'HEAD'). `tooLarge: true`
 * when the repo exceeds `MAX_TARBALL_BYTES` (fail-open: caller returns
 * without extracting).
 */
async function fetchAndExtractTarball(env: TechExtractEnv, tarPath: string, extractDir: string): Promise<TarballResult> {
    let resolvedSha: string | undefined;
    try {
        resolvedSha = await fetchTarball(env.repoFullName, env.commitSha, env.githubToken, tarPath, MAX_TARBALL_BYTES);
    } catch (e) {
        if (!String(e).includes('repo_too_large')) throw e;
        log.warn({ repo: env.repoFullName }, 'repo_too_large');
        return { tooLarge: true };
    }
    await safeExtract(tarPath, extractDir);
    return { tooLarge: false, resolvedSha };
}

async function main(): Promise<void> {
    const env = parseEnv();
    // Provisional until the tarball fetch resolves the real HEAD SHA (below). Evidence
    // is NEVER persisted under the literal 'HEAD' — that placeholder, being the newest
    // by created_at, would shadow real per-commit evidence in the code-truth loaders.
    let sha = env.commitSha ?? 'HEAD';
    log.info({ userId: env.userId, repo: env.repoFullName, sha }, 'tech-extract.start');

    const pool = new Pool({ ...env.pg, max: 3 });
    const evidenceRepo = new TechnologyEvidenceRepository(pool);
    const dsaEvidenceRepo = new RdsDsaEvidenceRepository(pool);
    const aiEvidenceRepo = new RdsAiEvidenceRepository(pool);

    try {
        const laneGates = await computeLaneGates(env, evidenceRepo, dsaEvidenceRepo, aiEvidenceRepo);
        if (!env.forceReindex && allLanesDone(laneGates)) {
            log.info({ repo: env.repoFullName, sha }, 'short-circuit: tech + dsa + ai evidence exist');
            return;
        }
        if (env.forceReindex) {
            log.info({ repo: env.repoFullName, sha }, 'force re-index: bypassing commit short-circuit');
        }

        const tarPath = path.join(env.workDir, 'repo.tar.gz');
        const extractDir = path.join(env.workDir, 'tree');
        await fs.mkdir(extractDir, { recursive: true });
        const tarball = await fetchAndExtractTarball(env, tarPath, extractDir);
        if (tarball.tooLarge) return;
        // Persist under the real SHA the redirect resolved to, never 'HEAD'.
        if (!env.commitSha && tarball.resolvedSha) {
            sha = tarball.resolvedSha;
            log.info({ repo: env.repoFullName, sha }, 'tech-extract.resolved-head-sha');
        }

        const result = await runFactsStage({
            pool, userId: env.userId, repoFullName: env.repoFullName,
            githubRepoId: env.githubRepoId ?? null, commitSha: sha,
            extractDir, laneGates,
            writeMode: 'persist',
            githubSbomEnabled: process.env['GITHUB_SBOM_ENABLED'] === '1',
            githubToken: env.githubToken,
        });

        for (const name of result.failedExtractors) extractorFailed.inc({ extractor: name });
    } finally {
        await withTimeout(pool.end(), 10_000, 'pg-pool');
        await withTimeout(
            pushFinalMetrics(obs.registry, 'tech-extractor', `${env.userId}_${env.repoFullName.replace('/', '_')}`),
            8_000, 'pushgateway',
        );
        await withTimeout(obs.shutdown(), 10_000, 'otel-shutdown');
    }
}

main().then(() => process.exit(0)).catch((err) => { log.error({ err }, 'failed'); process.exit(1); });
