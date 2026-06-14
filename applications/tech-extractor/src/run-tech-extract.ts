/** @format */
import { Pool } from 'pg';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
    OntologyResolver, TechnologyOntologyRepository, TechnologyEvidenceRepository,
    TechnologyCandidateRepository, TechnologyParityRunRepository,
    bootstrapK8sObservability, pushFinalMetrics,
    DsaTopicResolver, RdsDsaEvidenceRepository, RdsDsaTopicRepository,
    AiTopicResolver, RdsAiEvidenceRepository, RdsAiTopicRepository,
    runStoryMining,
} from '@bedrock/shared';
import { DsaPatternExtractor } from './extractors/DsaPatternExtractor.js';
import { AiPatternExtractor } from './extractors/AiPatternExtractor.js';
import { Counter, Gauge } from 'prom-client';

import { parseEnv } from './env.js';
import { fetchTarball } from './tarball/fetchTarball.js';
import { safeExtract } from './tarball/safeExtract.js';
import { walkTextFiles } from './util/fileWalk.js';
import { isTestFile } from './util/isTestFile.js';
import { SyftExtractor } from './extractors/SyftExtractor.js';
import { TreeSitterExtractor } from './extractors/TreeSitterExtractor.js';
import { parseDockerfile } from './extractors/iac/DockerfileParser.js';
import { parseK8sManifest, parseK8sManifestValues } from './extractors/iac/K8sManifestParser.js';
import { parseTerraform } from './extractors/iac/TerraformParser.js';
import { parseGithubActions } from './extractors/iac/GithubActionsParser.js';
import { parseReadme, parseReadmeProse } from './extractors/iac/ReadmeParser.js';
import { parseArgoApplication, parseHelmChart, parseHelmValues } from './extractors/iac/ArgoHelmParser.js';
import { extractProseRanges } from './extractors/CommentExtractor.js';
import { scanProseRanges } from './extractors/iac/ReadmeParser.js';
import type { Extractor, RawTechnologyEvidence } from './extractors/Extractor.js';
import { TechExtractOrchestrator } from './orchestrator/TechExtractOrchestrator.js';
import { computeParity } from './parity/ParityReporter.js';

const MAX_TARBALL_BYTES = Number(process.env.MAX_TARBALL_BYTES ?? 200 * 1024 * 1024);

const obs = bootstrapK8sObservability({ serviceName: 'tech-extractor' });
const log = obs.logger;

const recallGauge = new Gauge({
    name: 'tech_extractor_layer1_recall', help: 'L1 vs LLM technology recall.',
    labelNames: ['repo'] as const, registers: [obs.registry],
});
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

/** All IaC parsers as one fault-isolation unit over walked files. */
function iacExtractor(rootDir: string, files: string[], proseSafeAliases: ReadonlySet<string>): Extractor {
    return {
        name: 'iac',
        async extract(): Promise<RawTechnologyEvidence[]> {
            const out: RawTechnologyEvidence[] = [];
            for (const rel of files) {
                const base = path.basename(rel).toLowerCase();
                const src = await fs.readFile(path.join(rootDir, rel), 'utf-8');
                if (base.startsWith('dockerfile')) out.push(...parseDockerfile(src, rel));
                else if (rel.includes('.github/workflows/')) out.push(...parseGithubActions(src, rel));
                else if (rel.endsWith('.tf') || rel.endsWith('.hcl')) out.push(...parseTerraform(src, rel));
                else if (base === 'chart.yaml') out.push(...parseHelmChart(src, rel));
                else if (rel.includes('argocd-apps/') && (rel.endsWith('.yaml') || rel.endsWith('.yml'))) out.push(...parseArgoApplication(src, rel));
                // Helm values files: catches `image: <vendor>/<tool>:<tag>` declarations in
                // umbrella charts (monitoring stacks etc.) that K8sManifestParser ignores
                // because the doc has no `kind:`. Match values.yaml / values-*.yaml / values.<env>.yaml.
                else if (/(^|\/)values(\.[\w-]+)?\.ya?ml$/i.test(rel)) out.push(...parseHelmValues(src, rel));
                else if (rel.endsWith('.yaml') || rel.endsWith('.yml')) out.push(...parseK8sManifest(src, rel));
                else if (base === 'readme.md') {
                    // Two parsers, two failure modes — keep them independent.
                    out.push(...parseReadme(src, rel));
                    // ReadmeParser v2: prose-mention scan. Caller pre-filtered to
                    // prose_safe=true (mitigation 1 from 2026-05-26 design review);
                    // parseReadmeProse adds mitigation 2 (length floor default 4).
                    out.push(...parseReadmeProse(src, rel, proseSafeAliases));
                }

                // ALWAYS run the value-scanner on any YAML file regardless of which
                // structural parser also handled it above. ARN strings + ECR image
                // URIs + AWS-bound annotation keys can appear in argocd-apps/,
                // values.yaml, chart.yaml, and unstructured manifests alike — the
                // if/else above routes by file shape, this runs by content.
                if (rel.endsWith('.yaml') || rel.endsWith('.yml')) {
                    out.push(...parseK8sManifestValues(src, rel));
                    // F3: prose mentions in YAML comments (Helm template rationale,
                    // CDK-prerequisite notes, `# Uses kubernetes for ...` style).
                    // Closes the (a2) sub-bucket from the 2026-05-26 recount.
                    // Re-tag source_layer='iac' + ecosystem='yaml-comment' so the
                    // existing CHECK constraint is honoured (no migration needed).
                    if (proseSafeAliases.size > 0) {
                        const ranges = extractProseRanges(src, 'yaml');
                        const prose = scanProseRanges(ranges, rel, proseSafeAliases);
                        for (const e of prose) out.push({ ...e, source_layer: 'iac', ecosystem: 'yaml-comment' });
                    }
                }
            }
            return out;
        },
    };
}

async function main(): Promise<void> {
    const env = parseEnv();
    // Provisional until the tarball fetch resolves the real HEAD SHA (below). Evidence
    // is NEVER persisted under the literal 'HEAD' — that placeholder, being the newest
    // by created_at, would shadow real per-commit evidence in the code-truth loaders.
    let sha = env.commitSha ?? 'HEAD';
    log.info({ userId: env.userId, repo: env.repoFullName, sha }, 'tech-extract.start');

    const pool = new Pool({ ...env.pg, max: 3 });
    const ontologyRepo  = new TechnologyOntologyRepository(pool);
    const evidenceRepo  = new TechnologyEvidenceRepository(pool);
    const candidateRepo = new TechnologyCandidateRepository(pool);
    const parityRepo    = new TechnologyParityRunRepository(pool);

    const dsaEvidenceRepo = new RdsDsaEvidenceRepository(pool);
    const aiEvidenceRepo = new RdsAiEvidenceRepository(pool);

    try {
        // Per-lane idempotency: tech and DSA each own their own commit short-circuit, so
        // adding the DSA lane does not inherit tech's cache gate (and vice versa). Only skip
        // the whole job — and the tarball download — when BOTH lanes are already done.
        const techDone = !!env.commitSha
            && await evidenceRepo.hasEvidenceForCommit(env.userId, env.repoFullName, env.commitSha);
        const dsaDone = !!env.commitSha
            && await dsaEvidenceRepo.hasDsaScanForCommit(env.userId, env.repoFullName, env.commitSha);
        const aiDone = !!env.commitSha
            && await aiEvidenceRepo.hasAiScanForCommit(env.userId, env.repoFullName, env.commitSha);
        if (techDone && dsaDone && aiDone) {
            log.info({ repo: env.repoFullName, sha }, 'short-circuit: tech + dsa + ai evidence exist');
            return;
        }

        const tarPath = path.join(env.workDir, 'repo.tar.gz');
        const extractDir = path.join(env.workDir, 'tree');
        await fs.mkdir(extractDir, { recursive: true });
        try {
            const resolvedSha = await fetchTarball(env.repoFullName, env.commitSha, env.githubToken, tarPath, MAX_TARBALL_BYTES);
            // Persist under the real SHA the redirect resolved to, never 'HEAD'.
            if (!env.commitSha && resolvedSha) {
                sha = resolvedSha;
                log.info({ repo: env.repoFullName, sha }, 'tech-extract.resolved-head-sha');
            }
        } catch (e) {
            if (String(e).includes('repo_too_large')) { log.warn({ repo: env.repoFullName }, 'repo_too_large'); return; }
            throw e;
        }
        await safeExtract(tarPath, extractDir);

        const files = await walkTextFiles(extractDir);
        // DSA + AI "real-work" lanes must not score test fixtures (a test's `class TreeNode`
        // / `.sort((a,b)=>…)` / `cmp_to_key` is not real-work evidence). The tech/IaC lane
        // keeps the full list — a real import in a test is still valid "uses X" evidence.
        const patternFiles = files.filter((f) => !isTestFile(f));
        const readFile = (rel: string) => fs.readFile(path.join(extractDir, rel), 'utf-8');

        // ── Tech lane (syft/treesitter/iac → technology_evidence + parity) ──
        if (!techDone) {
            const ontologyVersion = await ontologyRepo.currentVersion();
            const resolver = new OntologyResolver(await ontologyRepo.loadAliasMap());
            const proseSafeAliases = await ontologyRepo.loadProseSafeAliases();
            log.info({ proseSafe: proseSafeAliases.size }, 'prose-safe-aliases.loaded');

            const extractors: Extractor[] = [
                new SyftExtractor(),
                new TreeSitterExtractor(readFile, files, proseSafeAliases),
                iacExtractor(extractDir, files, proseSafeAliases),
            ];

            const orch = new TechExtractOrchestrator(resolver, evidenceRepo, candidateRepo);
            const result = await orch.run({
                userId: env.userId, repoFullName: env.repoFullName, commitSha: sha,
                rootDir: extractDir, ontologyVersion, extractors,
            });
            for (const name of result.failedExtractors) extractorFailed.inc({ extractor: name });

            // Parity vs the LLM enricher's per-chunk technologies (GIN-indexed TEXT[]).
            let llmTechs: string[] = [];
            try {
                const { rows } = await pool.query<{ tech: string }>(
                    `SELECT DISTINCT unnest(technologies) AS tech
                     FROM document_embeddings WHERE user_id = $1::uuid AND repo_full_name = $2`,
                    [env.userId, env.repoFullName],
                );
                llmTechs = rows.map((r) => r.tech);
            } catch (e) {
                log.warn({ err: String(e) }, 'parity: failed to read document_embeddings.technologies');
            }

            const parity = computeParity(resolver, result.canonicalIds, llmTechs);
            recallGauge.set({ repo: env.repoFullName }, parity.recall);
            await parityRepo.insert({
                userId: env.userId, repoFullName: env.repoFullName, commitSha: sha, ontologyVersion,
                l1CanonicalCount: parity.l1CanonicalCount, llmCanonicalCount: parity.llmCanonicalCount,
                llmUnresolvableCount: parity.llmUnresolvableCount, intersectionCount: parity.intersectionCount,
                recall: parity.recall, l1OnlyExamples: parity.l1OnlyExamples, llmOnlyExamples: parity.llmOnlyExamples,
            });

            log.info({
                repo: env.repoFullName, sha, matched: result.matched, unmatched: result.unmatched,
                recall: parity.recall, failed: result.failedExtractors, llm_only: parity.llmOnlyExamples,
            }, 'tech-extract.complete');
        } else {
            log.info({ repo: env.repoFullName, sha }, 'tech lane: evidence exists, skipped (dsa backfill run)');
        }

        // ── DSA real-work pattern lane (fail-open: never breaks tech-extract) ──
        // Own idempotency via the scan marker, so it backfills commits tech already scanned.
        if (!dsaDone) {
            try {
                const dsaTopics = await new RdsDsaTopicRepository(pool).listTopics();
                const dsaResolver = new DsaTopicResolver(new Set(dsaTopics.map((t) => t.canonicalName)));
                const raw = await new DsaPatternExtractor(readFile, patternFiles).extract();
                const dsaRows = raw
                    .map((e) => ({ canonical: dsaResolver.resolve(e.topic_hint), e }))
                    .filter((x) => x.canonical !== null)
                    .map((x) => ({
                        repoFullName: env.repoFullName, commitSha: sha, dsaTopic: x.canonical as string,
                        signal: x.e.signal, rawName: x.e.raw_name, filePath: x.e.file_path,
                        lineStart: x.e.line_start, confidence: x.e.confidence,
                    }));
                await dsaEvidenceRepo.insertMany(env.userId, dsaRows);
                // Marker last: records "scanned" even when 0 matches, so no-DSA repos are not
                // re-downloaded on every re-sync. On insert failure we skip the marker → retry next run.
                await dsaEvidenceRepo.recordDsaScan(env.userId, env.repoFullName, sha, dsaRows.length);
                log.info({ repo: env.repoFullName, sha, inserted: dsaRows.length, raw: raw.length }, 'dsa.evidence.persisted');
            } catch (err) {
                log.warn({ err: String(err) }, 'dsa.extraction.failed (non-fatal)');
            }
        }

        // ── AI real-work practice lane (fail-open; own scan marker) ──
        // Own idempotency via the scan marker, so it backfills commits tech/dsa already scanned.
        if (!aiDone) {
            try {
                const aiTopics = await new RdsAiTopicRepository(pool).listCanonicalNames();
                const aiResolver = new AiTopicResolver(new Set(aiTopics));
                const raw = await new AiPatternExtractor(readFile, patternFiles).extract();
                const aiRows = raw
                    .map((e) => ({ canonical: aiResolver.resolve(e.topic_hint), e }))
                    .filter((x) => x.canonical !== null)
                    .map((x) => ({
                        repoFullName: env.repoFullName, commitSha: sha, aiTopic: x.canonical as string,
                        signal: x.e.signal, rawName: x.e.raw_name, filePath: x.e.file_path,
                        lineStart: x.e.line_start, confidence: x.e.confidence,
                    }));
                await aiEvidenceRepo.insertMany(env.userId, aiRows);
                // Marker last: records "scanned" even when 0 matches, so no-AI repos are not
                // re-downloaded on every re-sync. On insert failure we skip the marker → retry next run.
                await aiEvidenceRepo.recordAiScan(env.userId, env.repoFullName, sha, aiRows.length);
                log.info({ repo: env.repoFullName, sha, inserted: aiRows.length, raw: raw.length }, 'ai.evidence.persisted');
            } catch (err) {
                log.warn({ err: String(err) }, 'ai.extraction.failed (non-fatal)');
            }
        }

        // ── Story-mining lane (fail-open: never breaks tech-extract) ──
        // Reads the already-ingested repo_commits / repo_pull_requests rows (no tarball
        // needed) and mines two-artifact story candidates deterministically.
        try {
            const n = await runStoryMining(pool, env.userId, env.repoFullName);
            log.info({ repo: env.repoFullName, sha, candidates: n }, 'story.candidates.persisted');
        } catch (err) {
            log.warn({ err: String(err) }, 'story.mining.failed (non-fatal)');
        }
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
