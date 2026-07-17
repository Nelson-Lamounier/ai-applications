/** @format */
import type { RawTechnologyEvidence } from '../Extractor.js';

/** Extract `uses: owner/action@ref` references from a workflow file. */
export function parseGithubActions(src: string, filePath: string): RawTechnologyEvidence[] {
    const out: RawTechnologyEvidence[] = [];
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*-?\s*uses:\s*([^@\s]+)/.exec(lines[i]);
        if (!m) continue;
        out.push({
            raw_name: m[1], ecosystem: 'github_actions', source_layer: 'iac',
            file_path: filePath, line_start: i + 1, line_end: i + 1,
        });
    }
    if (out.length > 0) out.unshift({ raw_name: 'github_actions', ecosystem: 'iac', source_layer: 'iac', file_path: filePath });
    return out;
}
