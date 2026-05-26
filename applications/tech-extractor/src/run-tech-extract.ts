/** @format */
import { Pool } from 'pg';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
    OntologyResolver, TechnologyOntologyRepository, TechnologyEvidenceRepository,
    TechnologyCandidateRepository, TechnologyParityRunRepository,
    bootstrapK8sObservability, pushFinalMetrics,
} from '@bedrock/shared';
import { Counter, Gauge } from 'prom-client';

import { parseEnv } from './env.js';
import { fetchTarball } from './tarball/fetchTarball.js';
import { safeExtract } from './tarball/safeExtract.js';
import { walkTextFiles } from './util/fileWalk.js';
import { SyftExtractor } from './extractors/SyftExtractor.js';
import { TreeSitterExtractor } from './extractors/TreeSitterExtractor.js';
import { parseDockerfile } from './extractors/iac/DockerfileParser.js';
import { parseK8sManifest } from './extractors/iac/K8sManifestParser.js';
import { parseTerraform } from './extractors/iac/TerraformParser.js';
import { parseGithubActions } from './extractors/iac/GithubActionsParser.js';
import { parseReadme, parseReadmeProse } from './extractors/iac/ReadmeParser.js';
import { parseArgoApplication, parseHelmChart, parseHelmValues } from './extractors/iac/ArgoHelmParser.js';
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
            }
            return out;
        },
    };
}

async function main(): Promise<void> {
    const env = parseEnv();
    const sha = env.commitSha ?? 'HEAD';
    log.info({ userId: env.userId, repo: env.repoFullName, sha }, 'tech-extract.start');

    const pool = new Pool({ ...env.pg, max: 3 });
    const ontologyRepo  = new TechnologyOntologyRepository(pool);
    const evidenceRepo  = new TechnologyEvidenceRepository(pool);
    const candidateRepo = new TechnologyCandidateRepository(pool);
    const parityRepo    = new TechnologyParityRunRepository(pool);

    try {
        if (env.commitSha && await evidenceRepo.hasEvidenceForCommit(env.userId, env.repoFullName, env.commitSha)) {
            log.info({ repo: env.repoFullName, sha }, 'short-circuit: evidence exists');
            return;
        }

        const tarPath = path.join(env.workDir, 'repo.tar.gz');
        const extractDir = path.join(env.workDir, 'tree');
        await fs.mkdir(extractDir, { recursive: true });
        try {
            await fetchTarball(env.repoFullName, env.commitSha, env.githubToken, tarPath, MAX_TARBALL_BYTES);
        } catch (e) {
            if (String(e).includes('repo_too_large')) { log.warn({ repo: env.repoFullName }, 'repo_too_large'); return; }
            throw e;
        }
        await safeExtract(tarPath, extractDir);

        const files = await walkTextFiles(extractDir);
        const readFile = (rel: string) => fs.readFile(path.join(extractDir, rel), 'utf-8');

        const ontologyVersion = await ontologyRepo.currentVersion();
        const resolver = new OntologyResolver(await ontologyRepo.loadAliasMap());
        const proseSafeAliases = await ontologyRepo.loadProseSafeAliases();
        log.info({ proseSafe: proseSafeAliases.size }, 'prose-safe-aliases.loaded');

        const extractors: Extractor[] = [
            new SyftExtractor(),
            new TreeSitterExtractor(readFile, files),
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
