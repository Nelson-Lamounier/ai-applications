/** @format */
import type { RawTechnologyEvidence } from '../Extractor.js';
import { awsCanonicalForSlug } from './awsServiceMap.js';

const ARN_RE = /arn:aws:([a-z0-9-]+):([a-z0-9-]*):(\d{0,12}):/g;
const PLACEHOLDER_ACCOUNTS = new Set(['000000000000', '123456789012']);

export function scanArns(src: string, filePath: string): RawTechnologyEvidence[] {
    const seen = new Set<string>();
    const out: RawTechnologyEvidence[] = [];
    let m: RegExpExecArray | null;
    ARN_RE.lastIndex = 0;
    while ((m = ARN_RE.exec(src)) !== null) {
        const [, slug, , account] = m;
        if (PLACEHOLDER_ACCOUNTS.has(account)) continue;
        const canonical = awsCanonicalForSlug(slug);
        if (!canonical || seen.has(canonical)) continue;
        seen.add(canonical);
        out.push({
            raw_name: canonical,
            ecosystem: 'aws-arn',
            source_layer: 'iac',
            file_path: filePath,
        });
    }
    return out;
}
