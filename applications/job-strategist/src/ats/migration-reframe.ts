/**
 * @format
 * Migration reframe — the career/bullet-level half of doc-vs-code drift.
 *
 * The code-truth guard (code-truth.ts) catches stale tech in research verified
 * MATCHES. But the drift also surfaces in the strategist's experience BULLETS,
 * rendered verbatim from authored career_history (e.g. "self-hosted Kubernetes via
 * kubeadm") even after the repos migrated to managed EKS. This guard closes that
 * last mile.
 *
 * DETECTION is deterministic: a bullet names a predecessor `P` (kubeadm /
 * self_hosted_kubernetes) that has a `succeeds`-successor present in the candidate's
 * CURRENT code (aws_eks), while `P` itself is absent from all code → the bullet
 * describes a superseded state. REFRAME is a single grounded Haiku rewrite that
 * turns each flagged bullet into an honest MIGRATION narrative ("built a
 * self-managed kubeadm cluster, later migrating to managed EKS"), keeping the real
 * achievement and presenting the successor as current. No new facts; fail-open.
 */

import { runAgent, log } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext, StructuredResumeData } from '@bedrock/shared';
import { buildReverseAliasMap, mentionsCanonical } from './keyword-match.js';
import { ResumeRewriteSchema, buildEmitResumeTool } from '../agents/resume-tool-schema.js';

const MODEL_ID = process.env['MIGRATION_REFRAME_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

/** Space-pad a phrase to a lowercased alnum token stream for whole-word containment. */
function padded(text: string): string {
    return ' ' + text.toLowerCase().replaceAll(/[^a-z0-9]+/g, ' ').trim() + ' ';
}

export interface StaleMigration {
    /** The experience highlight that describes the superseded state. */
    readonly highlight: string;
    /** The predecessor canonical the bullet names (e.g. self_hosted_kubernetes). */
    readonly predecessor: string;
    /** The successor canonical(s) present in the candidate's current code (e.g. aws_eks). */
    readonly successors: string[];
}

export interface MigrationDeps {
    /** predecessor canonical -> successor canonicals (from `succeeds` edges). */
    readonly succeedsEdges: ReadonlyMap<string, ReadonlySet<string>>;
    /** repoFullName -> current code technologies (lowercased canonicals). */
    readonly codeTechByRepo: ReadonlyMap<string, ReadonlySet<string>>;
    /** alias(lower) -> canonical(lower), to recognise a predecessor in bullet prose. */
    readonly aliasToCanonical: ReadonlyMap<string, string>;
}

/** Union of every repo's current code tech — the candidate's overall current stack. */
function allCodeTech(codeTechByRepo: MigrationDeps['codeTechByRepo']): Set<string> {
    const all = new Set<string>();
    for (const set of codeTechByRepo.values()) for (const t of set) all.add(t);
    return all;
}

/**
 * Predecessors genuinely superseded by the code: a successor is in code, the
 * predecessor is not, and no PEER predecessor (one sharing a successor — e.g.
 * kubeadm vs self_hosted_kubernetes, both → aws_eks) is still in code. The peer
 * check avoids false-flagging a non-code-detectable bootstrap tool (kubeadm) when
 * the family's primary approach (self-hosted) is genuinely current.
 */
function supersededPredecessors(
    succeedsEdges: MigrationDeps['succeedsEdges'],
    code: ReadonlySet<string>,
): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [predecessor, successors] of succeedsEdges) {
        if (code.has(predecessor)) continue;
        const present = [...successors].filter((s) => code.has(s));
        if (present.length === 0) continue;
        const peerCurrent = [...succeedsEdges].some(([peer, peerSucc]) =>
            peer !== predecessor && code.has(peer) && [...peerSucc].some((s) => successors.has(s)));
        if (!peerCurrent) out.set(predecessor, present);
    }
    return out;
}

/** Flag each highlight that names a superseded predecessor (one flag per highlight). */
function flagHighlight(
    highlight: string,
    superseded: ReadonlyMap<string, string[]>,
    reverse: Map<string, string[]>,
): StaleMigration | null {
    const hay = padded(highlight);
    for (const [predecessor, successors] of superseded) {
        if (mentionsCanonical(predecessor, hay, reverse)) return { highlight, predecessor, successors };
    }
    return null;
}

/**
 * Detect experience bullets that describe a tech the candidate's code has since
 * superseded. Deterministic + pure. Empty when no `succeeds` edges / no code.
 */
export function detectStaleMigrations(resume: StructuredResumeData, deps: MigrationDeps): StaleMigration[] {
    if (deps.succeedsEdges.size === 0 || deps.codeTechByRepo.size === 0) return [];
    const superseded = supersededPredecessors(deps.succeedsEdges, allCodeTech(deps.codeTechByRepo));
    if (superseded.size === 0) return [];

    const reverse = buildReverseAliasMap(deps.aliasToCanonical);
    const out: StaleMigration[] = [];
    const experience = Array.isArray(resume.experience) ? resume.experience : [];
    for (const exp of experience) {
        const highlights = Array.isArray(exp.highlights) ? exp.highlights : [];
        for (const highlight of highlights) {
            const flag = flagHighlight(highlight, superseded, reverse);
            if (flag) out.push(flag);
        }
    }
    return out;
}

const CTX: BasePipelineContext = {
    pipelineId: 'migration-reframe',
    environment: process.env['DEPLOY_ENV'] ?? 'dev',
    cumulativeTokens: { input: 0, output: 0, thinking: 0 },
    cumulativeCostUsd: 0,
};

const TOOL = buildEmitResumeTool('Return the resume as structured JSON with the flagged bullets reframed as migration narratives (plain text, NO markdown).');

function display(canonical: string): string {
    return canonical.replaceAll('_', ' ');
}

/**
 * Reframe the flagged bullets into honest migration narratives via one grounded
 * Haiku call. Changes ONLY the flagged bullets; no new facts. FAIL-OPEN: empty
 * input or any error → the input resume unchanged.
 */
export async function reframeStaleMigrations(
    resume: StructuredResumeData,
    migrations: ReadonlyArray<StaleMigration>,
): Promise<StructuredResumeData> {
    if (migrations.length === 0) return resume;

    const facts = migrations.map((m) =>
        `- A bullet describes "${display(m.predecessor)}", but the candidate's CURRENT code uses ${m.successors.map(display).join(', ')} (a later migration).`,
    ).join('\n');

    const system = [
        'You reframe specific resume experience bullets that describe a SUPERSEDED technology, using ONLY',
        'the migration facts provided. Call emit_resume with the FULL resume JSON. Rules:',
        '1. MIGRATION NARRATIVE — for each flagged bullet, reframe it as an honest migration: keep the REAL',
        '   work the candidate did with the older technology, then state they LATER MIGRATED to the current',
        '   technology. Example: "Built and solo-operated a self-managed Kubernetes cluster via kubeadm on',
        '   AWS EC2 …" → "Built and operated Kubernetes on AWS — bootstrapping a self-managed kubeadm cluster',
        '   and later migrating it to managed AWS EKS …". Present the CURRENT (successor) technology as the',
        '   current state; never present the superseded technology as current.',
        '2. GROUNDED — use ONLY the migration facts + the existing bullet text. Do NOT invent metrics,',
        '   dates, or any detail not already present. The migration direction (old → new) is the only new',
        '   information you may add, and only from the facts below.',
        '3. SURGICAL — change ONLY the flagged bullets. Every other bullet, section, company, title, period,',
        '   skill, and the profile MUST be returned byte-for-byte unchanged.',
        '',
        'Output plain text only: no markdown, no em-dashes.',
    ].join('\n');

    const config: AgentConfig = {
        agentName: 'migration-reframe',
        modelId: MODEL_ID,
        maxTokens: 8000,
        thinkingBudget: 0,
        systemPrompt: [{ text: system }],
        pipeline: 'job-strategist',
        tool: { name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema },
    };

    const userMessage =
        `<migration_facts>\n${facts}\n</migration_facts>\n` +
        `<flagged_bullets>${JSON.stringify(migrations.map((m) => m.highlight))}</flagged_bullets>\n` +
        `<resume>${JSON.stringify(resume)}</resume>`;

    try {
        const result = await runAgent<StructuredResumeData>({
            config, userMessage, pipelineContext: CTX,
            parseResponse: (s) => {
                const parsed = ResumeRewriteSchema.safeParse(JSON.parse(s));
                if (!parsed.success) throw new Error(`migration-reframe: ${parsed.error.message}`);
                return parsed.data as unknown as StructuredResumeData;
            },
        });
        return result.data;
    } catch (e) {
        log('WARN', 'migration-reframe failed — keeping original resume', { error: e instanceof Error ? e.message : String(e) });
        return resume;
    }
}
