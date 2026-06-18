/** @format */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Extractor, RawTechnologyEvidence } from './Extractor.js';

// execFile (NOT exec): array args, no shell — the repo path/binary cannot be
// shell-injected. The repo has no execFileNoThrow helper, so this is the safe
// primitive. Never switch this to exec().
const execFileAsync = promisify(execFile);

interface SyftArtifact { name?: string; version?: string; type?: string; locations?: { path?: string }[] }

/** Pure parser — unit-testable without invoking the syft binary. */
export function parseSyftJson(stdout: string): RawTechnologyEvidence[] {
    let doc: { artifacts?: SyftArtifact[] };
    try { doc = JSON.parse(stdout); } catch { return []; }
    const out: RawTechnologyEvidence[] = [];
    for (const a of doc.artifacts ?? []) {
        if (!a.name) continue;
        out.push({
            raw_name:     a.name,
            ecosystem:    a.type,
            source_layer: 'syft',
            file_path:    a.locations?.[0]?.path ?? '(unknown)',
            ...(a.version ? { version: a.version } : {}),
        });
    }
    return out;
}

export class SyftExtractor implements Extractor {
    readonly name = 'syft';
    constructor(private readonly syftBin = process.env.SYFT_BIN ?? 'syft') {}

    async extract(rootDir: string): Promise<RawTechnologyEvidence[]> {
        const { stdout } = await execFileAsync(
            this.syftBin,
            ['scan', `dir:${rootDir}`, '-o', 'syft-json', '-q'],
            { maxBuffer: 64 * 1024 * 1024 },
        );
        return parseSyftJson(stdout);
    }
}
