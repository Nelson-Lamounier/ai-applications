/** @format */
import type { RawTechnologyEvidence } from '@bedrock/shared';

export type { RawTechnologyEvidence };

/** Every deterministic extractor implements this. Pure over a directory. */
export interface Extractor {
    readonly name: string;
    extract(rootDir: string): Promise<RawTechnologyEvidence[]>;
}
