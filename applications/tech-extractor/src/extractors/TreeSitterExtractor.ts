/** @format */
import type { Extractor, RawTechnologyEvidence } from './Extractor.js';
import patterns from '../config/sdkCallPatterns.json';

type Lang = 'python' | 'javascript' | 'typescript' | 'go' | 'rust' | 'java';

interface SdkPattern { language: string; callPattern: string; ecosystem: string; raw_name: string }

/**
 * Maps an AWS dependency/import module string to AWS service token(s).
 *
 * - `aws-cdk-lib/aws-<svc>`   → `['<svc>']`
 * - `@aws-sdk/client-<svc>`   → `['<svc>']` (hyphenated slug kept as-is)
 * - anything else             → `[]`
 */
export function awsModuleTokens(module: string): string[] {
    const cdkMatch = /^aws-cdk-lib\/aws-(.+)$/.exec(module);
    if (cdkMatch) return [cdkMatch[1]];
    const sdkMatch = /^@aws-sdk\/client-(.+)$/.exec(module);
    if (sdkMatch) return [sdkMatch[1]];
    return [];
}

/**
 * Regex import extraction (deterministic, unit-testable). The Tree-sitter AST
 * pass replaces this in Phase 2 behind the same interface.
 */
export function extractImportsByRegex(src: string, lang: Lang, filePath: string): RawTechnologyEvidence[] {
    const out: RawTechnologyEvidence[] = [];
    const push = (name: string, line: number) =>
        out.push({ raw_name: name, ecosystem: lang, source_layer: 'treesitter', file_path: filePath, line_start: line, line_end: line });
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (lang === 'python') {
            let m = /^\s*import\s+([a-zA-Z0-9_]+)/.exec(l);
            if (m) { push(m[1], i + 1); continue; }
            m = /^\s*from\s+([a-zA-Z0-9_]+)/.exec(l);
            if (m) push(m[1], i + 1);
        } else if (lang === 'javascript' || lang === 'typescript') {
            const m = /(?:import|require)\b[^'"]*['"]([^'"]+)['"]/.exec(l);
            if (m) {
                const rawModule = m[1];
                const mod = rawModule.startsWith('@') ? rawModule.split('/').slice(0, 2).join('/') : rawModule.split('/')[0];
                if (!mod.startsWith('.')) {
                    push(mod, i + 1);
                    // Also emit AWS service tokens for aws-cdk-lib/aws-* and @aws-sdk/client-* imports
                    for (const svcToken of awsModuleTokens(rawModule)) {
                        out.push({ raw_name: svcToken, ecosystem: lang, source_layer: 'treesitter', file_path: filePath, line_start: i + 1, line_end: i + 1 });
                    }
                }
            }
        }
    }
    return out;
}

/** Substring match of configured SDK-call patterns. */
export function matchSdkCalls(src: string, lang: Lang, filePath: string): RawTechnologyEvidence[] {
    const out: RawTechnologyEvidence[] = [];
    const lines = src.split('\n');
    for (const p of (patterns as SdkPattern[])) {
        if (p.language !== lang) continue;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(p.callPattern)) {
                out.push({ raw_name: p.raw_name, ecosystem: p.ecosystem, source_layer: 'treesitter', file_path: filePath, line_start: i + 1, line_end: i + 1 });
            }
        }
    }
    return out;
}

const EXT_LANG: Record<string, Lang> = {
    '.py': 'python', '.js': 'javascript', '.jsx': 'javascript',
    '.ts': 'typescript', '.tsx': 'typescript', '.go': 'go', '.rs': 'rust', '.java': 'java',
};

/** Maps a file extension to a supported language, or null. */
export function langForExt(ext: string): Lang | null {
    return EXT_LANG[ext] ?? null;
}

export class TreeSitterExtractor implements Extractor {
    readonly name = 'treesitter';
    constructor(
        private readonly readFile: (rel: string) => Promise<string>,
        private readonly files: string[],
    ) {}

    async extract(_rootDir: string): Promise<RawTechnologyEvidence[]> {
        const out: RawTechnologyEvidence[] = [];
        for (const rel of this.files) {
            const ext = rel.slice(rel.lastIndexOf('.'));
            const lang = langForExt(ext);
            if (!lang) continue;
            const src = await this.readFile(rel);
            out.push(...extractImportsByRegex(src, lang, rel));
            out.push(...matchSdkCalls(src, lang, rel));
        }
        return out;
    }
}
