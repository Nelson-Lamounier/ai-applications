/** @format */
import type { RawTechnologyEvidence } from '../Extractor.js';

/** Pull base-image names from FROM lines. `node:22-alpine` -> `node`. */
export function parseDockerfile(src: string, filePath: string): RawTechnologyEvidence[] {
    const out: RawTechnologyEvidence[] = [];
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*FROM\s+([^\s]+)/i.exec(lines[i]);
        if (!m) continue;
        const image = m[1].split('@')[0].split(':')[0].split('/').pop()!;
        out.push({
            raw_name: image, ecosystem: 'docker', source_layer: 'dockerfile',
            file_path: filePath, line_start: i + 1, line_end: i + 1,
        });
    }
    return out;
}
