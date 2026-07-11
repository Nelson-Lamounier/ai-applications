/** @format */
/**
 * Prompt content loader — content lives as markdown data, contracts stay in
 * typed code.
 *
 * Six prompt-content changes in 48 hours each required a TS edit, full CI,
 * image build and SSM rollover — and SonarCloud's CPD gate failed on every
 * persona edit because the template-literal personas structurally duplicate
 * each other. Prompt PROSE now lives in `content/*.md` with YAML frontmatter
 * (id, version, cachePoint); this loader parses, validates (Zod), splits
 * cache blocks, and exposes the version for the prompt_invocations ledger.
 *
 * What stays in TypeScript, by design: tool JSON schemas, Zod output
 * validation, deterministic guards, and helper repair prompts (they
 * interpolate run context heavily) — those are contracts, not content.
 *
 * Runtime delivery: tsc does NOT copy .md — the package build has an explicit
 * `cp -R src/prompts/content dist/prompts/` step. `__dirname` resolves to
 * src/prompts under ts-jest and dist/prompts in the built image, so the same
 * relative path works in both.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';

const FrontmatterSchema = z.object({
    id:         z.string().min(1),
    version:    z.union([z.string(), z.number()]).transform((v) => String(v)),
    cachePoint: z.enum(['default', 'none']).default('none'),
});

export interface PromptMeta {
    readonly id: string;
    readonly version: string;
    readonly cachePoint: 'default' | 'none';
}

export interface LoadedPrompt {
    readonly meta: PromptMeta;
    /** The markdown body, frontmatter stripped, verbatim. */
    readonly body: string;
}

const FENCE = '---\n';
const CACHE_POINT_MARKER = /\n?<!-- cache-point -->\n?/;

/** Parse `key: value` lines of the frontmatter block (flat YAML subset only). */
function parseFrontmatter(raw: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key) out[key] = value;
    }
    return out;
}

const cache = new Map<string, LoadedPrompt>();

/**
 * Load `content/<name>.md` (memoised). Throws on missing file or invalid
 * frontmatter — a prompt that cannot load must fail the Job at startup, not
 * silently run with empty instructions.
 */
export function loadPrompt(name: string): LoadedPrompt {
    const hit = cache.get(name);
    if (hit) return hit;

    const raw = readFileSync(join(__dirname, 'content', `${name}.md`), 'utf8');
    if (!raw.startsWith(FENCE)) throw new Error(`prompt '${name}': missing frontmatter fence`);
    const end = raw.indexOf(`\n${FENCE}`, FENCE.length);
    if (end === -1) throw new Error(`prompt '${name}': unterminated frontmatter`);

    const meta = FrontmatterSchema.parse(parseFrontmatter(raw.slice(FENCE.length, end)));
    const body = raw.slice(end + 1 + FENCE.length);
    const loaded: LoadedPrompt = { meta, body };
    cache.set(name, loaded);
    return loaded;
}

/**
 * Bedrock system blocks: the body split on `<!-- cache-point -->` markers
 * (each split boundary becomes a cachePoint block), plus a trailing
 * cachePoint when the frontmatter declares `cachePoint: default`. Preserving
 * these boundaries is what keeps Bedrock prompt caching alive after the
 * markdown migration.
 */
export function toSystemBlocks(prompt: LoadedPrompt): SystemContentBlock[] {
    const segments = prompt.body.split(CACHE_POINT_MARKER);
    const blocks: SystemContentBlock[] = [];
    segments.forEach((segment, i) => {
        blocks.push({ text: segment });
        if (i < segments.length - 1) blocks.push({ cachePoint: { type: 'default' } });
    });
    if (prompt.meta.cachePoint === 'default') blocks.push({ cachePoint: { type: 'default' } });
    return blocks;
}

/**
 * Strict mustache-lite: replaces `{{name}}` from `vars`; throws on a
 * placeholder with no value (a silently blank instruction is how the
 * third-person framingLine class of bug ships) and on unused vars (a typo'd
 * key would otherwise no-op).
 */
export function renderTemplate(body: string, vars: Record<string, string>): string {
    const used = new Set<string>();
    const out = body.replaceAll(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
        const value = vars[key];
        if (value === undefined) throw new Error(`prompt template: no value for '{{${key}}}'`);
        used.add(key);
        return value;
    });
    const unused = Object.keys(vars).filter((k) => !used.has(k));
    if (unused.length > 0) throw new Error(`prompt template: unused vars ${unused.join(', ')} (typo in placeholder?)`);
    return out;
}

/** Convenience: load + block-split in one call (the persona module pattern). */
export function loadPersona(name: string): { meta: PromptMeta; blocks: SystemContentBlock[] } {
    const prompt = loadPrompt(name);
    return { meta: prompt.meta, blocks: toSystemBlocks(prompt) };
}
