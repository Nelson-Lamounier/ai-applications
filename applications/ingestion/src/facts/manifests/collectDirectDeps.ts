/** @format */
import { PARSER_SPECS } from './manifest-parsers.js';

const EXCLUDED_DIRS = /(^|\/)(node_modules|vendor|dist|build|\.git|\.next|target)\//;

/**
 * Walk the repo file list, parse every recognised manifest, and build a
 * per-syft-ecosystem set of DIRECT dependency names (normalised per ecosystem).
 * Monorepo workspaces merge into one set per ecosystem. An ecosystem key is
 * present ONLY when at least one manifest produced >= 1 name -- that absence is
 * what makes the downstream filter fail-open. Never throws.
 */
export async function collectDirectDeps(
    files: readonly string[],
    readFile: (rel: string) => Promise<string>,
): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    for (const path of files) {
        if (EXCLUDED_DIRS.test(path)) continue;
        const spec = PARSER_SPECS.find((s) => s.matches(path));
        if (!spec) continue;
        let content: string;
        try {
            content = await readFile(path);
        } catch {
            continue; // unreadable manifest -> skip (fail-open)
        }
        let names: string[];
        try {
            names = spec.parse(content);
        } catch {
            continue; // parse error -> skip (fail-open)
        }
        if (names.length === 0) continue;
        for (const eco of spec.syftEcosystems) {
            let set = out.get(eco);
            if (!set) { set = new Set<string>(); out.set(eco, set); }
            for (const n of names) set.add(spec.normalise(n));
        }
    }
    return out;
}
