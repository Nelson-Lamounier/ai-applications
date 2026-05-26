/** @format */
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

/**
 * Bootstrap tagger for technology_aliases.prose_safe.
 *
 * Used as a one-shot job to classify every alias as prose-safe or
 * structured-context-only. The result drives the ReadmeParser v2 prose-match
 * scope: only aliases tagged prose_safe=true are matched against free-form
 * English. Short / common-English aliases (go, react, rust, spark, swift,
 * next, ts, js, sh, tf, …) are tagged prose_safe=false and only matched in
 * structured contexts (imports, code blocks, list items).
 *
 * Calibration set is embedded in the system prompt as few-shot examples
 * (5 obviously-safe + 5 obviously-unsafe + 5 edge cases). Aliases are
 * presented one at a time via the Bedrock Converse API, model emits a
 * tag_alias tool call with `prose_safe: 'yes'|'no'|'maybe'` + reasoning.
 *
 * Maybe → null (stays unclassified, can be reviewed manually). Yes/no →
 * true/false written to technology_aliases.prose_safe.
 */

export const PROSE_SAFE_MODEL_DEFAULT = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

export interface AliasItem {
    alias: string;
    canonical: string;
    category: string;
}

export type ProseSafeVerdict = 'yes' | 'no' | 'maybe';

export interface ProseSafeResult {
    verdict: ProseSafeVerdict;
    reasoning: string;
}

const SYSTEM_TEXT = `You classify technology-name aliases for a developer-resume system that scans GitHub repos for tech evidence.

Goal: decide whether matching this alias against arbitrary English prose (READMEs, code comments, documentation) is SAFE — i.e. the alias is unambiguous enough that any sentence containing it almost certainly refers to the technology, not to a homonym, common English word, abbreviation, or unrelated meaning.

Tag prose_safe = "yes" when the alias is distinctive and rarely overlaps with non-technology meanings.
Tag prose_safe = "no" when the alias is a common English word, short abbreviation, or has homonym risk.
Tag prose_safe = "maybe" only when genuinely uncertain (rare — most aliases are clearly one or the other).

Calibration examples:
- "kubernetes"       → yes  (distinctive proper noun, only refers to the tech)
- "grafana"          → yes  (distinctive proper noun)
- "prometheus"       → yes  (distinctive — even mythology references are rare in tech-context prose)
- "terraform"        → yes  (distinctive; verb usage in sci-fi is negligible vs tech usage)
- "fastapi"          → yes  (compound word, no English meaning)
- "@aws-sdk/client-s3" → yes  (scoped path, unambiguous)
- "kube-prometheus-stack" → yes  (compound, unambiguous)
- "pgvector"         → yes  (compound, no English meaning)
- "argocd"           → yes  (distinctive)
- "cloudflare"       → yes  (proper noun)

- "go"               → no   (common verb, preposition — every sentence with "go" matches)
- "js"               → no   (2-char abbreviation, ambiguous)
- "ts"               → no   (2-char abbreviation; matches TypeScript, timestamp, transport stream)
- "py"               → no   (2-char abbreviation)
- "sh"               → no   (2-char abbreviation; matches shell, "shh", abbreviation)
- "tf"               → no   (2-char abbreviation; matches TensorFlow, Terraform, mathematical f)
- "s3"               → no   (matches "S3" the AWS service, but also any sentence with "s3" as label)
- "ec2"              → no   (short, ambiguous)
- "acm"              → no   (short, also Association for Computing Machinery)
- "alb"              → no   (3-char; albumin, name suffix)

Edge cases:
- "react"            → no   (common English verb; "users react to changes" matches falsely)
- "next"             → no   (common English word; "the next release..." matches falsely)
- "swift"            → no   (common English adjective; "swift response..." matches falsely)
- "rust"             → no   (common English noun; "memory safety prevents rust..." metaphor matches)
- "spark"            → no   (common English noun; "sparked an idea..." matches falsely)

For each alias, briefly state your reasoning (1 sentence) then emit the tag.`;

const TOOL = {
    name: 'tag_alias',
    description: 'Record the prose_safe classification for one alias.',
    input_schema: {
        type: 'object',
        properties: {
            prose_safe: { type: 'string', enum: ['yes', 'no', 'maybe'] },
            reasoning: { type: 'string', maxLength: 200 },
        },
        required: ['prose_safe', 'reasoning'],
        additionalProperties: false,
    },
};

/** Pure: build the Converse request body for a single alias. */
export function buildConverseRequest(item: AliasItem): {
    system: Array<{ text: string }>;
    messages: Array<{ role: 'user'; content: Array<{ text: string }> }>;
    toolConfig: { tools: Array<{ toolSpec: { name: string; description: string; inputSchema: { json: unknown } } }>; toolChoice: { tool: { name: string } } };
    inferenceConfig: { maxTokens: number; temperature: number };
} {
    const userText =
        `Alias: ${item.alias}\n` +
        `Canonical: ${item.canonical}\n` +
        `Category: ${item.category}`;
    return {
        system: [{ text: SYSTEM_TEXT }],
        messages: [{ role: 'user', content: [{ text: userText }] }],
        toolConfig: {
            tools: [{
                toolSpec: {
                    name: TOOL.name,
                    description: TOOL.description,
                    inputSchema: { json: TOOL.input_schema },
                },
            }],
            toolChoice: { tool: { name: TOOL.name } },
        },
        inferenceConfig: { maxTokens: 200, temperature: 0 },
    };
}

/** Pure: extract the tag_alias tool input from a Converse response. */
export function parseConverseResponse(resp: {
    output?: { message?: { content?: Array<{ toolUse?: { name?: string; input?: unknown } }> } };
}): ProseSafeResult {
    const blocks = resp.output?.message?.content ?? [];
    const tu = blocks.find((b) => b.toolUse?.name === 'tag_alias');
    if (!tu?.toolUse?.input) return { verdict: 'maybe', reasoning: 'no tool_use returned' };
    const i = tu.toolUse.input as { prose_safe?: string; reasoning?: string };
    const raw = (i.prose_safe ?? 'maybe').toLowerCase();
    const verdict: ProseSafeVerdict = raw === 'yes' || raw === 'no' || raw === 'maybe' ? raw : 'maybe';
    return { verdict, reasoning: i.reasoning ?? '' };
}

/** Coerce 'yes'/'no'/'maybe' → true/false/null for the prose_safe column. */
export function verdictToProseSafe(v: ProseSafeVerdict): boolean | null {
    if (v === 'yes') return true;
    if (v === 'no') return false;
    return null;
}

/** Thin SDK shell: calls Bedrock Converse, returns the parsed verdict.
 *  Mocked in tests via the pure functions above. */
export class ProseSafeTagger {
    private readonly client: BedrockRuntimeClient;
    constructor(private readonly cfg: { region: string; modelId: string }) {
        this.client = new BedrockRuntimeClient({ region: cfg.region });
    }

    async tag(item: AliasItem): Promise<ProseSafeResult> {
        const body = buildConverseRequest(item);
        const resp = await this.client.send(new ConverseCommand({
            modelId: this.cfg.modelId,
            system: body.system,
            messages: body.messages,
            toolConfig: body.toolConfig as never,
            inferenceConfig: body.inferenceConfig,
        }));
        return parseConverseResponse(resp as never);
    }
}
