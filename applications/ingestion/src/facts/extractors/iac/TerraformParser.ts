/** @format */
import type { RawTechnologyEvidence } from '../Extractor.js';

/** Extract `resource "<type>" "<name>"` declarations + a terraform token. */
export function parseTerraform(src: string, filePath: string): RawTechnologyEvidence[] {
    const out: RawTechnologyEvidence[] = [];
    const lines = src.split('\n');
    let matched = false;
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*resource\s+"([a-z0-9_]+)"/i.exec(lines[i]);
        if (!m) continue;
        matched = true;
        out.push({
            raw_name: m[1], ecosystem: 'terraform', source_layer: 'iac',
            file_path: filePath, line_start: i + 1, line_end: i + 1,
        });
    }
    if (matched) out.unshift({ raw_name: 'terraform', ecosystem: 'iac', source_layer: 'iac', file_path: filePath });
    return out;
}
