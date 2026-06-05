/**
 * @format
 * BedrockProseLinter — flag-only prose-quality critic via Converse forced-tool.
 *
 * Mirrors BedrockGroundingVerifier's slot (config → lint() → structured result +
 * cost ctx) but inverts the failure default: any parse/schema/transport error
 * fails OPEN (status PASS, no issues) so a broken style check never degrades a
 * working coach run. Never mutates input.
 */
import {
    BedrockRuntimeClient,
    ConverseCommand,
    type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType as __DocumentType } from '@smithy/types';
import type { Pool } from 'pg';

import { emitEmfMetric } from '../emf.js';
import { recordBedrockCost } from '../rds/bedrock-cost.js';
import { assembleProseLinterSystemPrompt } from './prompt/system-prompt.js';
import { PROSE_QUALITY_TOOL } from './prompt/tool-schema.js';
import type {
    IProseLinter,
    ProseLinterMode,
    ProseQualityInput,
    ProseQualityResult,
    ProseSection,
} from './prose-quality-types.js';

const METRIC_NAMESPACE = 'BedrockSharedSafety';

/** Per-call context for booking the linter's Sonnet spend. Optional. */
export interface ProseLinterCostContext {
    pool:   Pool;
    userId: string;
}

export interface BedrockProseLinterConfig {
    readonly mode: ProseLinterMode;       // only 'flag' in v1
    readonly modelId?: string;
    readonly client?: BedrockRuntimeClient;
}

/** Returns a fresh fail-open PASS result each time — never a shared mutable singleton. */
function passOpen(): ProseQualityResult {
    return {
        status: 'PASS',
        score: { directness: 0, rhythm: 0, trust: 0, authenticity: 0, density: 0, total: 0 },
        belowThreshold: false,
        issues: [],
    };
}

function renderUserMessage(sections: readonly ProseSection[]): string {
    return sections
        .map(s => `<section location="${s.location}" register="${s.register}">\n${s.text}\n</section>`)
        .join('\n');
}

function extractToolInput(response: ConverseCommandOutput): unknown {
    const blocks = response.output?.message?.content ?? [];
    const toolUse = blocks
        .map(b => (b as { toolUse?: { input?: unknown } }).toolUse)
        .find(t => t && t.input !== undefined);
    return toolUse?.input;
}

const VALID_CATEGORIES = new Set(['phrase', 'structure']);
const VALID_SEVERITIES  = new Set(['high', 'medium', 'low']);

function isValidIssue(item: unknown): item is ProseQualityResult['issues'][number] {
    if (typeof item !== 'object' || item === null) return false;
    const i = item as Record<string, unknown>;
    return (
        typeof i['category'] === 'string' && VALID_CATEGORIES.has(i['category']) &&
        typeof i['match']    === 'string' &&
        typeof i['location'] === 'string' &&
        typeof i['severity'] === 'string' && VALID_SEVERITIES.has(i['severity']) &&
        typeof i['rule']     === 'string'
    );
}

/** Validate the model payload into a ProseQualityResult, or null if malformed. */
function coerce(raw: unknown): ProseQualityResult | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    const s = o['score'] as Record<string, unknown> | undefined;
    const dims = ['directness', 'rhythm', 'trust', 'authenticity', 'density', 'total'] as const;
    if (!s || dims.some(d => !Number.isFinite(s[d]))) return null;
    if (o['status'] !== 'PASS' && o['status'] !== 'FAIL') return null;
    if (typeof o['belowThreshold'] !== 'boolean') return null;
    if (!Array.isArray(o['issues'])) return null;
    const issues: ProseQualityResult['issues'] = o['issues'].filter(isValidIssue);
    return {
        status: o['status'] as 'PASS' | 'FAIL',
        score: {
            directness:   s['directness'] as number,
            rhythm:       s['rhythm'] as number,
            trust:        s['trust'] as number,
            authenticity: s['authenticity'] as number,
            density:      s['density'] as number,
            total:        s['total'] as number,
        },
        belowThreshold: o['belowThreshold'] as boolean,
        issues,
    };
}

export class BedrockProseLinter implements IProseLinter {
    private readonly mode: ProseLinterMode;
    private readonly modelId: string;
    private readonly client: BedrockRuntimeClient;

    constructor(config: BedrockProseLinterConfig) {
        this.mode = config.mode;
        this.modelId =
            config.modelId ?? process.env.PROSE_LINTER_MODEL_ID ?? 'eu.anthropic.claude-sonnet-4-6';
        this.client = config.client ?? new BedrockRuntimeClient({});
    }

    async lint(input: ProseQualityInput, costCtx?: ProseLinterCostContext): Promise<ProseQualityResult> {
        if (input.sections.length === 0) return passOpen();

        let response: ConverseCommandOutput;
        try {
            const command = new ConverseCommand({
                modelId: this.modelId,
                system: assembleProseLinterSystemPrompt(),
                messages: [{ role: 'user', content: [{ text: renderUserMessage(input.sections) }] }],
                inferenceConfig: { maxTokens: 4096 },
                toolConfig: {
                    tools: [{
                        toolSpec: {
                            name: PROSE_QUALITY_TOOL.name,
                            description: PROSE_QUALITY_TOOL.description,
                            inputSchema: { json: PROSE_QUALITY_TOOL.inputSchema as unknown as __DocumentType },
                        },
                    }],
                    toolChoice: { tool: { name: PROSE_QUALITY_TOOL.name } },
                },
            });
            response = await this.client.send(command);
        } catch (err) {
            console.warn('[prose-linter] Bedrock call failed — failing open (PASS):', (err as Error).message);
            return passOpen();
        }

        if (costCtx?.userId) {
            // Awaited (not fire-and-forget): the INSERT must finish before the caller
            // returns, else a short-lived pool (run-coach) can close before the dangling
            // query runs ("Cannot use a pool after calling end on the pool"). Stays
            // fail-open via .catch.
            await recordBedrockCost(costCtx.pool, {
                userId:       costCtx.userId,
                modelId:      this.modelId,
                pipeline:     'prose-lint',
                inputTokens:  response.usage?.inputTokens  ?? 0,
                outputTokens: response.usage?.outputTokens ?? 0,
            }).catch(e => console.warn('[prose-linter] cost record failed (non-fatal)', e));
        }

        return this.resolveResult(coerce(extractToolInput(response)));
    }

    private resolveResult(result: ProseQualityResult | null): ProseQualityResult {
        if (!result) {
            console.warn('[prose-linter] unparseable model output — failing open (PASS).');
            emitEmfMetric(METRIC_NAMESPACE, { Module: 'prose-quality', Mode: this.mode }, [
                { name: 'ProseChecked', value: 1, unit: 'Count' },
                { name: 'ProseFailed', value: 0, unit: 'Count' },
            ]);
            return passOpen();
        }
        emitEmfMetric(METRIC_NAMESPACE, { Module: 'prose-quality', Mode: this.mode }, [
            { name: 'ProseChecked', value: 1, unit: 'Count' },
            { name: 'ProseFailed', value: result.status === 'FAIL' ? 1 : 0, unit: 'Count' },
        ]);
        return result;
    }
}
