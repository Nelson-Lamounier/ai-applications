/**
 * @format
 * BedrockEvidenceAdjudicator — decides deterministic lint findings against the KB.
 *
 * The structural linter (lint/article-lint-rules.ts) DETECTS and ROUTES; this
 * adjudicator DECIDES. It consumes the findings whose truth depends on the
 * knowledge base — enumerated generalisations, dangling caveats, and title
 * claims — and, for each, asks Sonnet whether the KB actually supports it.
 *
 * Mirrors BedrockProseLinter's slot (config -> adjudicate() -> structured
 * result via forced tool) but inverts the failure default like the grounding
 * verifier: any Bedrock/parse error marks every routed finding a DEFECT.
 * Hedged fabrication is still fabrication — on doubt, do not clear.
 *
 * Flag/record mode: the caller folds the verdicts into pipeline_runs.metadata;
 * nothing here blocks a run.
 */
import {
    BedrockRuntimeClient,
    ConverseCommand,
    type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType as __DocumentType } from '@smithy/types';
import type { Pool } from 'pg';

import { emitEmfMetric, recordBedrockCost } from '@bedrock/shared';
import type { Finding } from '../lint/article-lint-rules.js';

const METRIC_NAMESPACE = 'BedrockSharedSafety';

/** Lint rules whose truth is a KB-evidence question — these route here. */
export const EVIDENCE_TRIGGER_RULES: ReadonlySet<string> = new Set([
    'enumerated-generalisation',
    'dangling-reference',
    'title-coverage',
]);

export type EvidenceDecision = 'DEFECT' | 'CLEARED';

export interface EvidenceVerdict {
    readonly rule: string;
    readonly finding: string;
    readonly decision: EvidenceDecision;
    readonly reason: string;
}

export interface EvidenceAdjudicationResult {
    readonly verdicts: readonly EvidenceVerdict[];
    readonly defects: number;
}

export interface EvidenceAdjudicationInput {
    readonly findings: readonly Finding[];
    readonly contextChunks: readonly string[];
    readonly draft: string;
}

export interface EvidenceAdjudicatorConfig {
    readonly modelId?: string;
    readonly client?: BedrockRuntimeClient;
}

export interface EvidenceCostContext {
    readonly pool: Pool;
    readonly userId: string;
}

const EVIDENCE_TOOL = {
    name: 'emit_evidence_verdicts',
    description: 'For each routed finding, decide DEFECT (KB does not support it) or CLEARED.',
    inputSchema: {
        type: 'object',
        properties: {
            verdicts: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        index:    { type: 'integer', minimum: 0 },
                        decision: { type: 'string', enum: ['DEFECT', 'CLEARED'] },
                        reason:   { type: 'string' },
                    },
                    required: ['index', 'decision', 'reason'],
                    additionalProperties: false,
                },
            },
        },
        required: ['verdicts'],
        additionalProperties: false,
    },
} as const;

const SYSTEM_PROMPT = [
    'You are an evidence adjudicator for a technical article pipeline. A deterministic',
    'linter has flagged claims whose truth depends on the knowledge base (KB). For each',
    'flagged finding, decide against the KB chunks ONLY:',
    '',
    '- enumerated-generalisation: "A, B and C all share property P" passes (CLEARED) only',
    '  if the KB contains evidence of P for EVERY member independently. Evidence for one',
    '  member plus plausible analogy for the others is a DEFECT.',
    '- dangling-reference: a named caveat/limitation passes only if the KB contains its',
    '  substance AND the draft explains it in at least two sentences. A name-only mention',
    '  is a DEFECT even when the underlying fact is true — a claim the reader cannot use',
    '  is a groundedness defect.',
    '- title-coverage: a title concept passes only if the body develops it with KB-grounded',
    '  content. A title phrase absent from the body is a DEFECT.',
    '',
    'Never soften to "likely" — hedged fabrication is still fabrication. On doubt, DEFECT.',
    'Return one verdict per finding, addressed by its index.',
].join('\n');

function renderUserMessage(input: EvidenceAdjudicationInput, routed: readonly Finding[]): string {
    const chunks = input.contextChunks.map((c, n) => `[KB ${n + 1}] ${c}`).join('\n');
    const findings = routed
        .map((f, i) => `#${i} (${f.rule}): ${f.message}`)
        .join('\n');
    return [
        'KNOWLEDGE BASE CHUNKS:',
        chunks || '(none)',
        '',
        'FLAGGED FINDINGS:',
        findings,
        '',
        'DRAFT:',
        input.draft.slice(0, 20_000),
    ].join('\n');
}

function extractToolInput(response: ConverseCommandOutput): unknown {
    const blocks = response.output?.message?.content ?? [];
    const toolUse = blocks
        .map(b => (b as { toolUse?: { input?: unknown } }).toolUse)
        .find(t => t?.input !== undefined);
    return toolUse?.input;
}

/** Build the fail-safe result: every routed finding is a DEFECT. */
function allDefects(routed: readonly Finding[], reason: string): EvidenceAdjudicationResult {
    const verdicts = routed.map((f) => ({
        rule: f.rule, finding: f.message, decision: 'DEFECT' as const, reason,
    }));
    return { verdicts, defects: verdicts.length };
}

/** Parse one model verdict item, or null if malformed. */
function parseVerdictItem(item: unknown): { index: number; decision: EvidenceDecision; reason: string } | null {
    const o = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : undefined;
    const index = o?.['index'];
    const decision = o?.['decision'];
    if (typeof index !== 'number' || (decision !== 'DEFECT' && decision !== 'CLEARED')) return null;
    return { index, decision, reason: typeof o?.['reason'] === 'string' ? (o['reason'] as string) : '' };
}

/** Index the model's verdict list by `index`, dropping malformed entries. */
function indexVerdicts(list: readonly unknown[]): Map<number, { decision: EvidenceDecision; reason: string }> {
    const byIndex = new Map<number, { decision: EvidenceDecision; reason: string }>();
    for (const item of list) {
        const p = parseVerdictItem(item);
        if (p) byIndex.set(p.index, { decision: p.decision, reason: p.reason });
    }
    return byIndex;
}

/** Coerce the model payload into verdicts keyed to `routed`, or null if malformed. */
function coerce(raw: unknown, routed: readonly Finding[]): EvidenceAdjudicationResult | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const list = (raw as Record<string, unknown>)['verdicts'];
    if (!Array.isArray(list)) return null;

    const byIndex = indexVerdicts(list);

    // Every routed finding must have a verdict; missing → fail-safe DEFECT for it.
    const verdicts = routed.map((f, i) => {
        const v = byIndex.get(i) ?? { decision: 'DEFECT' as const, reason: 'no verdict returned' };
        return { rule: f.rule, finding: f.message, decision: v.decision, reason: v.reason };
    });
    return { verdicts, defects: verdicts.filter((v) => v.decision === 'DEFECT').length };
}

export class BedrockEvidenceAdjudicator {
    private readonly modelId: string;
    private readonly client: BedrockRuntimeClient;

    constructor(config: EvidenceAdjudicatorConfig = {}) {
        this.modelId =
            config.modelId ?? process.env.EVIDENCE_ADJUDICATOR_MODEL_ID ?? 'eu.anthropic.claude-sonnet-4-6';
        this.client = config.client ?? new BedrockRuntimeClient({});
    }

    async adjudicate(
        input: EvidenceAdjudicationInput,
        costCtx?: EvidenceCostContext,
    ): Promise<EvidenceAdjudicationResult> {
        const routed = input.findings.filter((f) => EVIDENCE_TRIGGER_RULES.has(f.rule));
        if (routed.length === 0) return { verdicts: [], defects: 0 };

        let response: ConverseCommandOutput;
        try {
            response = await this.client.send(new ConverseCommand({
                modelId: this.modelId,
                system: [{ text: SYSTEM_PROMPT }],
                messages: [{ role: 'user', content: [{ text: renderUserMessage(input, routed) }] }],
                inferenceConfig: { maxTokens: 4096 },
                toolConfig: {
                    tools: [{
                        toolSpec: {
                            name: EVIDENCE_TOOL.name,
                            description: EVIDENCE_TOOL.description,
                            inputSchema: { json: EVIDENCE_TOOL.inputSchema as unknown as __DocumentType },
                        },
                    }],
                    toolChoice: { tool: { name: EVIDENCE_TOOL.name } },
                },
            }));
        } catch (err) {
            console.warn('[evidence-adjudicator] Bedrock call failed — failing safe (DEFECT):', (err as Error).message);
            return this.emit(allDefects(routed, `adjudication error: ${(err as Error).message}`));
        }

        if (costCtx?.userId) {
            await recordBedrockCost(costCtx.pool, {
                userId:       costCtx.userId,
                modelId:      this.modelId,
                pipeline:     'grounding-verify',
                agent:        'evidence-adjudicator',
                inputTokens:  response.usage?.inputTokens  ?? 0,
                outputTokens: response.usage?.outputTokens ?? 0,
            }).catch(e => console.warn('[evidence-adjudicator] cost record failed (non-fatal)', e));
        }

        const result = coerce(extractToolInput(response), routed);
        if (!result) {
            console.warn('[evidence-adjudicator] unparseable model output — failing safe (DEFECT).');
            return this.emit(allDefects(routed, 'unparseable adjudication output'));
        }
        return this.emit(result);
    }

    private emit(result: EvidenceAdjudicationResult): EvidenceAdjudicationResult {
        emitEmfMetric(METRIC_NAMESPACE, { Module: 'evidence-adjudication' }, [
            { name: 'EvidenceChecked', value: 1,              unit: 'Count' },
            { name: 'EvidenceDefects', value: result.defects, unit: 'Count' },
        ]);
        return result;
    }
}
