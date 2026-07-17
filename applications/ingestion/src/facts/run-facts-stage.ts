/** @format
 *
 * The reusable "facts" stage extracted from `run-tech-extract.ts` (P1 unified
 * ingestion, Task 3). Given an already-extracted repo tree, this runs the
 * tech/DSA/AI/story-mining lanes in the same order and with the same
 * per-lane idempotency gates as the standalone tech-extract Job.
 *
 * `writeMode`:
 *  - `'persist'`: exactly today's tech-extract behaviour — all lanes, all
 *    writes (technology_evidence, candidates, dsa_evidence, ai_evidence,
 *    story candidates, tech_stack reconciliation), same commit-SHA scan
 *    markers.
 *  - `'shadow'`: ONLY the tech-lane extractors + ontology resolution run
 *    (the deterministic, side-effect-free part). No writes of any kind —
 *    no evidence insertMany, no candidates, no DSA/AI lanes, no story
 *    mining, no reconciliation, no scan markers — and the per-lane
 *    idempotency gates are ignored (shadow always computes fresh rows,
 *    since the whole point is a fresh comparison against the persisted
 *    legacy rows). This is the seam `TechExtractOrchestrator.run({ dryRun })`
 *    provides.
 *
 * `EvidenceKey.canonicalId` is the LOWERCASED CANONICAL NAME, not the
 * internal `technology_ontology` UUID. `TechnologyEvidenceRow.technologyId`
 * (built by `TechExtractOrchestrator`) is a UUID — but the persisted-side
 * parity loader (Task 4) reads `technology_evidence` joined to
 * `technology_ontology.canonical_name`, so both sides of
 * `computeLayerParity` must compare on the same vocabulary. We resolve
 * `technologyId -> canonical_name` here via
 * `TechnologyOntologyRepository.loadIdToCanonicalMap()` before building
 * `EvidenceKey[]`. Rows whose `raw_name` never resolved (`technologyId ===
 * null`) are excluded — they have no canonical identity to compare by, and
 * the legacy loader's INNER JOIN excludes them too.
 */
import type { Pool } from 'pg';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
    OntologyResolver, TechnologyOntologyRepository, TechnologyEvidenceRepository,
    TechnologyCandidateRepository,
    DsaTopicResolver, RdsDsaEvidenceRepository, RdsDsaTopicRepository,
    AiTopicResolver, RdsAiEvidenceRepository, RdsAiTopicRepository,
    runStoryMining, jobLogger,
} from '@bedrock/shared';

import { reconcileTechStack } from './util/reconcileTechStack.js';
import { walkTextFiles } from './util/fileWalk.js';
import { isTestFile } from './util/isTestFile.js';
import { SyftExtractor } from './extractors/SyftExtractor.js';
import { GithubSbomExtractor } from './extractors/GithubSbomExtractor.js';
import { TreeSitterExtractor } from './extractors/TreeSitterExtractor.js';
import { DsaPatternExtractor } from './extractors/DsaPatternExtractor.js';
import { AiPatternExtractor } from './extractors/AiPatternExtractor.js';
import { parseDockerfile } from './extractors/iac/DockerfileParser.js';
import { parseK8sManifest, parseK8sManifestValues } from './extractors/iac/K8sManifestParser.js';
import { parseTerraform } from './extractors/iac/TerraformParser.js';
import { parseGithubActions } from './extractors/iac/GithubActionsParser.js';
import { parseReadme, parseReadmeProse, scanProseRanges } from './extractors/iac/ReadmeParser.js';
import { parseArgoApplication, parseHelmChart, parseHelmValues } from './extractors/iac/ArgoHelmParser.js';
import { extractProseRanges } from './extractors/CommentExtractor.js';
import type { Extractor, RawTechnologyEvidence } from './extractors/Extractor.js';
import { TechExtractOrchestrator } from './TechExtractOrchestrator.js';
import { collectDirectDeps } from './manifests/collectDirectDeps.js';
import type { EvidenceKey } from './parity/layer-parity.js';

export interface FactsStageInput {
    pool:            Pool;
    userId:          string;
    repoFullName:    string;
    githubRepoId:    number | null;
    commitSha:       string;
    /** Already-extracted repo tree (tarball fetch/extract is the caller's job). */
    extractDir:      string;
    /** Bypass the tech-lane commit short-circuit (persist mode only). */
    forceReindex:    boolean;
    writeMode:       'persist' | 'shadow';
    githubSbomEnabled: boolean;
    /** Only needed when githubSbomEnabled. */
    githubToken:     string;
}

export interface FactsStageResult {
    /** Every computed row's (sourceLayer, canonicalId, filePath) — Task 1's shape. */
    evidenceKeys:      EvidenceKey[];
    failedExtractors:  string[];
    durationMs:        number;
}

const isYaml       = (rel: string): boolean => rel.endsWith('.yaml') || rel.endsWith('.yml');
const isTerraform  = (rel: string): boolean => rel.endsWith('.tf') || rel.endsWith('.hcl');
const isArgoApp    = (rel: string): boolean => rel.includes('argocd-apps/') && isYaml(rel);
// Helm values files: catches `image: <vendor>/<tool>:<tag>` declarations in umbrella
// charts (monitoring stacks etc.) that K8sManifestParser ignores because the doc has
// no `kind:`. Matches values.yaml / values-*.yaml / values.<env>.yaml.
const isValuesFile = (rel: string): boolean => /(^|\/)values(\.[\w-]+)?\.ya?ml$/i.test(rel);

/** Route one file to its structural IaC parser by shape (name/extension/path). */
function parseByFileShape(base: string, rel: string, src: string, proseSafeAliases: ReadonlySet<string>): RawTechnologyEvidence[] {
    if (base.startsWith('dockerfile')) return parseDockerfile(src, rel);
    if (rel.includes('.github/workflows/')) return parseGithubActions(src, rel);
    if (isTerraform(rel)) return parseTerraform(src, rel);
    if (base === 'chart.yaml') return parseHelmChart(src, rel);
    if (isArgoApp(rel)) return parseArgoApplication(src, rel);
    if (isValuesFile(rel)) return parseHelmValues(src, rel);
    if (isYaml(rel)) return parseK8sManifest(src, rel);
    if (base === 'readme.md') {
        // Two parsers, two failure modes — keep them independent. ReadmeParser v2's
        // prose-mention scan: caller pre-filtered to prose_safe=true (mitigation 1
        // from 2026-05-26 design review); parseReadmeProse adds mitigation 2 (length
        // floor default 4).
        return [...parseReadme(src, rel), ...parseReadmeProse(src, rel, proseSafeAliases)];
    }
    return [];
}

/**
 * ALWAYS run the value-scanner on any YAML file regardless of which structural
 * parser (if any) `parseByFileShape` also ran. ARN strings + ECR image URIs +
 * AWS-bound annotation keys can appear in argocd-apps/, values.yaml, chart.yaml,
 * and unstructured manifests alike — this runs by content, not by file shape.
 */
function scanYamlValues(rel: string, src: string, proseSafeAliases: ReadonlySet<string>): RawTechnologyEvidence[] {
    const out: RawTechnologyEvidence[] = [...parseK8sManifestValues(src, rel)];
    // F3: prose mentions in YAML comments (Helm template rationale, CDK-prerequisite
    // notes, `# Uses kubernetes for ...` style). Closes the (a2) sub-bucket from the
    // 2026-05-26 recount. Re-tag source_layer='iac' + ecosystem='yaml-comment' so the
    // existing CHECK constraint is honoured (no migration needed).
    if (proseSafeAliases.size === 0) return out;
    const ranges = extractProseRanges(src, 'yaml');
    const prose = scanProseRanges(ranges, rel, proseSafeAliases);
    for (const e of prose) out.push({ ...e, source_layer: 'iac', ecosystem: 'yaml-comment' });
    return out;
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
                out.push(...parseByFileShape(base, rel, src, proseSafeAliases));
                if (isYaml(rel)) out.push(...scanYamlValues(rel, src, proseSafeAliases));
            }
            return out;
        },
    };
}

/**
 * Best-effort tech_stack reconciliation: write the evidence-backed verified stack
 * + divergence onto the profile. Never fatal — a failure leaves the LLM stack.
 */
async function runTechStackReconciliation(pool: Pool, userId: string, repoFullName: string): Promise<void> {
    const log = jobLogger();
    try {
        const recon = await reconcileTechStack(pool, userId, repoFullName);
        if (recon) {
            log.info({
                repo: repoFullName, verified: recon.reconciled.length,
                llmOnly: recon.llmOnly.length, evidenceOnly: recon.evidenceOnly.length,
            }, 'tech-extract.reconciled');
        }
    } catch (e) {
        log.warn({ err: String(e) }, 'tech_stack reconciliation skipped (non-fatal)');
    }
}

interface TechLaneOpts {
    userId: string; repoFullName: string; githubRepoId: number | null; commitSha: string;
    extractDir: string; files: string[]; readFile: (rel: string) => Promise<string>;
    writeMode: 'persist' | 'shadow'; dryRun: boolean; githubSbomEnabled: boolean; githubToken: string;
    ontologyRepo: TechnologyOntologyRepository;
    evidenceRepo: TechnologyEvidenceRepository;
    candidateRepo: TechnologyCandidateRepository;
    startedAt: number;
}

interface TechLaneResult { evidenceKeys: EvidenceKey[]; failedExtractors: string[] }

/** Tech lane: syft/treesitter/iac extractors -> resolved evidence + parity keys. */
async function runTechLane(opts: TechLaneOpts): Promise<TechLaneResult> {
    const log = jobLogger();
    const {
        userId, repoFullName, githubRepoId, commitSha, extractDir, files, readFile,
        writeMode, dryRun, githubSbomEnabled, githubToken, ontologyRepo, evidenceRepo, candidateRepo, startedAt,
    } = opts;

    const ontologyVersion = await ontologyRepo.currentVersion();
    const resolver = new OntologyResolver(await ontologyRepo.loadAliasMap());
    const idToCanonical = await ontologyRepo.loadIdToCanonicalMap();
    const proseSafeAliases = await ontologyRepo.loadProseSafeAliases();
    log.info({ proseSafe: proseSafeAliases.size }, 'prose-safe-aliases.loaded');

    const directByEcosystem = await collectDirectDeps(files, readFile);
    log.info({ ecosystems: [...directByEcosystem.keys()] }, 'direct-deps.collected');

    const extractors: Extractor[] = [
        new SyftExtractor(undefined, directByEcosystem),
        new TreeSitterExtractor(readFile, files, proseSafeAliases),
        iacExtractor(extractDir, files, proseSafeAliases),
        // Optional cross-check/fallback lane: GitHub's dependency-graph
        // SBOM (zero local compute), gated and off by default. Best-effort
        // — a fetch failure is a failed lane, never fails the run.
        ...(githubSbomEnabled ? [new GithubSbomExtractor(repoFullName, githubToken)] : []),
    ];

    const orch = new TechExtractOrchestrator(resolver, evidenceRepo, candidateRepo);
    const result = await orch.run({
        userId, repoFullName, commitSha, rootDir: extractDir, ontologyVersion, extractors,
        githubRepoId, dryRun,
    });

    // NOTE: the L1-vs-LLM parity comparison was removed. It read the LLM
    // enricher's per-chunk `document_embeddings.technologies`, but that
    // extraction was decommissioned 2026-05-27 (the enricher now emits
    // `technologies: []` — tech is owned by this deterministic pipeline).
    // The recall metric therefore measured against a permanently-empty
    // set, producing a misleading `tech_extractor_layer1_recall` gauge and
    // meaningless parity rows. Removed rather than left to emit noise.

    if (writeMode === 'persist') {
        log.info({
            repo: repoFullName, sha: commitSha, matched: result.matched, unmatched: result.unmatched,
            failed: result.failedExtractors, durationMs: Date.now() - startedAt,
        }, 'tech-extract.complete');
    }

    const evidenceKeys = result.rows
        // Unresolved rows (technologyId null) have no canonical identity to compare
        // by, and the legacy parity loader's INNER JOIN excludes them too.
        .filter((row) => row.technologyId && idToCanonical.has(row.technologyId))
        .map((row) => ({
            sourceLayer: row.sourceLayer,
            canonicalId: idToCanonical.get(row.technologyId as string) as string,
            filePath: row.filePath,
        }));

    return { evidenceKeys, failedExtractors: result.failedExtractors };
}

/** DSA real-work pattern lane (fail-open: never breaks the facts stage). */
async function runDsaLane(
    pool: Pool, userId: string, repoFullName: string, commitSha: string,
    patternFiles: string[], readFile: (rel: string) => Promise<string>,
): Promise<void> {
    const log = jobLogger();
    const dsaEvidenceRepo = new RdsDsaEvidenceRepository(pool);
    try {
        const dsaTopics = await new RdsDsaTopicRepository(pool).listTopics();
        const dsaResolver = new DsaTopicResolver(new Set(dsaTopics.map((t) => t.canonicalName)));
        const raw = await new DsaPatternExtractor(readFile, patternFiles).extract();
        const dsaRows = raw
            .map((e) => ({ canonical: dsaResolver.resolve(e.topic_hint), e }))
            .filter((x) => x.canonical !== null)
            .map((x) => ({
                repoFullName, commitSha, dsaTopic: x.canonical as string,
                signal: x.e.signal, rawName: x.e.raw_name, filePath: x.e.file_path,
                lineStart: x.e.line_start, confidence: x.e.confidence,
            }));
        await dsaEvidenceRepo.insertMany(userId, dsaRows);
        // Marker last: records "scanned" even when 0 matches, so no-DSA repos are not
        // re-downloaded on every re-sync. On insert failure we skip the marker → retry next run.
        await dsaEvidenceRepo.recordDsaScan(userId, repoFullName, commitSha, dsaRows.length);
        log.info({ repo: repoFullName, sha: commitSha, inserted: dsaRows.length, raw: raw.length }, 'dsa.evidence.persisted');
    } catch (err) {
        log.warn({ err: String(err) }, 'dsa.extraction.failed (non-fatal)');
    }
}

/** AI real-work practice lane (fail-open; own scan marker). */
async function runAiLane(
    pool: Pool, userId: string, repoFullName: string, commitSha: string,
    patternFiles: string[], readFile: (rel: string) => Promise<string>,
): Promise<void> {
    const log = jobLogger();
    const aiEvidenceRepo = new RdsAiEvidenceRepository(pool);
    try {
        const aiTopics = await new RdsAiTopicRepository(pool).listCanonicalNames();
        const aiResolver = new AiTopicResolver(new Set(aiTopics));
        const raw = await new AiPatternExtractor(readFile, patternFiles).extract();
        const aiRows = raw
            .map((e) => ({ canonical: aiResolver.resolve(e.topic_hint), e }))
            .filter((x) => x.canonical !== null)
            .map((x) => ({
                repoFullName, commitSha, aiTopic: x.canonical as string,
                signal: x.e.signal, rawName: x.e.raw_name, filePath: x.e.file_path,
                lineStart: x.e.line_start, confidence: x.e.confidence,
            }));
        await aiEvidenceRepo.insertMany(userId, aiRows);
        // Marker last: records "scanned" even when 0 matches, so no-AI repos are not
        // re-downloaded on every re-sync. On insert failure we skip the marker → retry next run.
        await aiEvidenceRepo.recordAiScan(userId, repoFullName, commitSha, aiRows.length);
        log.info({ repo: repoFullName, sha: commitSha, inserted: aiRows.length, raw: raw.length }, 'ai.evidence.persisted');
    } catch (err) {
        log.warn({ err: String(err) }, 'ai.extraction.failed (non-fatal)');
    }
}

interface LaneGates { readonly techDone: boolean; readonly dsaDone: boolean; readonly aiDone: boolean }

/**
 * Per-lane commit-SHA idempotency gates (tech/DSA/AI each own their own
 * marker, so adding a lane never inherits another lane's cache gate).
 * Shadow mode always returns all-false — parity needs fresh rows every run,
 * never a cached skip.
 */
async function computeLaneGates(
    pool: Pool, dryRun: boolean, userId: string, repoFullName: string, commitSha: string,
    evidenceRepo: TechnologyEvidenceRepository,
): Promise<LaneGates> {
    if (dryRun || !commitSha) return { techDone: false, dsaDone: false, aiDone: false };
    const techDone = await evidenceRepo.hasEvidenceForCommit(userId, repoFullName, commitSha);
    const dsaDone = await new RdsDsaEvidenceRepository(pool).hasDsaScanForCommit(userId, repoFullName, commitSha);
    const aiDone = await new RdsAiEvidenceRepository(pool).hasAiScanForCommit(userId, repoFullName, commitSha);
    return { techDone, dsaDone, aiDone };
}

/**
 * Runs the tech/DSA/AI/story-mining lanes over an already-extracted repo
 * tree. See the module header for `writeMode` semantics.
 */
export async function runFactsStage(input: FactsStageInput): Promise<FactsStageResult> {
    const start = Date.now();
    const log = jobLogger();
    const {
        pool, userId, repoFullName, githubRepoId, commitSha, extractDir,
        forceReindex, writeMode, githubSbomEnabled, githubToken,
    } = input;
    const dryRun = writeMode === 'shadow';

    const ontologyRepo = new TechnologyOntologyRepository(pool);
    const evidenceRepo = new TechnologyEvidenceRepository(pool);
    const candidateRepo = new TechnologyCandidateRepository(pool);

    const { techDone, dsaDone, aiDone } = await computeLaneGates(pool, dryRun, userId, repoFullName, commitSha, evidenceRepo);
    if (!dryRun && forceReindex) {
        log.info({ repo: repoFullName, sha: commitSha }, 'force re-index: bypassing commit short-circuit');
    }

    const files = await walkTextFiles(extractDir);
    // DSA + AI "real-work" lanes must not score test fixtures (a test's `class TreeNode`
    // / `.sort((a,b)=>…)` / `cmp_to_key` is not real-work evidence). The tech/IaC lane
    // keeps the full list — a real import in a test is still valid "uses X" evidence.
    const patternFiles = files.filter((f) => !isTestFile(f));
    const readFile = (rel: string) => fs.readFile(path.join(extractDir, rel), 'utf-8');

    // ── Tech lane (syft/treesitter/iac → technology_evidence + parity) ──
    let evidenceKeys: EvidenceKey[] = [];
    let failedExtractors: string[] = [];
    if (!techDone) {
        const laneResult = await runTechLane({
            userId, repoFullName, githubRepoId, commitSha, extractDir, files, readFile,
            writeMode, dryRun, githubSbomEnabled, githubToken, ontologyRepo, evidenceRepo, candidateRepo,
            startedAt: start,
        });
        evidenceKeys = laneResult.evidenceKeys;
        failedExtractors = laneResult.failedExtractors;
    } else {
        log.info({ repo: repoFullName, sha: commitSha }, 'tech lane: evidence exists, skipped (dsa backfill run)');
    }

    if (dryRun) {
        // Shadow: tech-lane-only, no writes at all — stop here.
        return { evidenceKeys, failedExtractors, durationMs: Date.now() - start };
    }

    // Reconcile the profile's LLM tech_stack against the file-cited
    // technology_evidence. Runs OUTSIDE the !techDone gate: the reconciliation
    // depends on the profile's (freshly re-extracted) tech_stack + EXISTING
    // evidence, not on whether evidence was just written — so a resync of an
    // unchanged commit (techDone=true, evidence already present) must still
    // reconcile. reconcileTechStack is a no-op when no evidence exists.
    await runTechStackReconciliation(pool, userId, repoFullName);

    // ── DSA real-work pattern lane (fail-open: never breaks tech-extract) ──
    // Own idempotency via the scan marker, so it backfills commits tech already scanned.
    if (!dsaDone) await runDsaLane(pool, userId, repoFullName, commitSha, patternFiles, readFile);

    // ── AI real-work practice lane (fail-open; own scan marker) ──
    // Own idempotency via the scan marker, so it backfills commits tech/dsa already scanned.
    if (!aiDone) await runAiLane(pool, userId, repoFullName, commitSha, patternFiles, readFile);

    // ── Story-mining lane (fail-open: never breaks tech-extract) ──
    // Reads the already-ingested repo_commits / repo_pull_requests rows (no tarball
    // needed) and mines two-artifact story candidates deterministically.
    try {
        const n = await runStoryMining(pool, userId, repoFullName);
        log.info({ repo: repoFullName, sha: commitSha, candidates: n }, 'story.candidates.persisted');
    } catch (err) {
        log.warn({ err: String(err) }, 'story.mining.failed (non-fatal)');
    }

    return { evidenceKeys, failedExtractors, durationMs: Date.now() - start };
}
