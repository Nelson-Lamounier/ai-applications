/** @format */
import type { RawTechnologyEvidence } from '../Extractor.js';

const ECR_RE = /\b(\d{12})\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-zA-Z0-9_\-./]+/g;
const PLACEHOLDER_ACCOUNTS = new Set(['000000000000', '123456789012']);

export function scanEcrUris(src: string, filePath: string): RawTechnologyEvidence[] {
    let m: RegExpExecArray | null;
    ECR_RE.lastIndex = 0;
    while ((m = ECR_RE.exec(src)) !== null) {
        if (PLACEHOLDER_ACCOUNTS.has(m[1])) continue;
        return [
            {
                raw_name: 'aws_ecr',
                ecosystem: 'image-uri',
                source_layer: 'iac',
                file_path: filePath,
            },
        ];
    }
    return [];
}
