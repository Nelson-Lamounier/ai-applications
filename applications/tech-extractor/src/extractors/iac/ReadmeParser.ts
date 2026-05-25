/** @format */
import type { RawTechnologyEvidence } from '../Extractor.js';

/** Pull the subject of shields.io badges (`/badge/<subject>-<status>-<color>`). */
export function parseReadme(src: string, filePath: string): RawTechnologyEvidence[] {
    const out: RawTechnologyEvidence[] = [];
    const re = /img\.shields\.io\/badge\/([^-/)]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
        const subject = decodeURIComponent(m[1]).trim();
        if (subject) out.push({ raw_name: subject, ecosystem: 'readme', source_layer: 'readme', file_path: filePath });
    }
    return out;
}
