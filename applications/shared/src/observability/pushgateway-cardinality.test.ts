/**
 * @format
 * Guard test — makes the Pushgateway cardinality leak un-mergeable.
 *
 * Pushgateway retains every distinct {job, instance} group in memory forever.
 * A per-run instance key (pipelineRunId, importId, `Date.now()`) therefore
 * leaks one group per execution and eventually OOM-kills the gateway (which is
 * exactly what happened: 1,132 orphaned `ontology-importer-followup` groups).
 *
 * This test statically scans EVERY `pushFinalMetrics(...)` call site across all
 * applications and fails if any of them passes an ephemeral identifier as the
 * instance key. Instance keys must be bounded/stable — a business identifier
 * (userId, `userId_repo`) or a constant ('global') for singleton jobs.
 *
 * It is a source scan, not a runtime test, precisely because a per-run UUID
 * (pipelineRunId) is indistinguishable from a stable UUID (userId) at runtime —
 * only the identifier NAME reveals the intent, and only at the call site.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';

import { EPHEMERAL_INSTANCE_TOKENS } from './pushgateway';

/** Walk up from this file until we reach the monorepo `applications/` dir. */
function findApplicationsDir(): string {
    let dir = __dirname;
    for (let i = 0; i < 12; i++) {
        if (basename(dir) === 'applications') return dir;
        const parent = resolve(dir, '..');
        if (parent === dir) break;
        dir = parent;
    }
    throw new Error(`could not locate applications/ from ${__dirname}`);
}

/** Recursively collect .ts source files under a dir (skipping dist/node_modules/tests). */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
            collectSourceFiles(full, acc);
        } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.test.ts')) {
            acc.push(full);
        }
    }
    return acc;
}

interface CallSite {
    file: string;
    instanceArg: string;
}

/**
 * Extract the 3rd argument (instance key) of every `pushFinalMetrics(a, b, c)`
 * call. The call is always single-line in this codebase; the regex stops the
 * 3rd arg at the matching close paren of pushFinalMetrics itself.
 */
function findPushFinalMetricsCallSites(files: string[]): CallSite[] {
    const sites: CallSite[] = [];
    const call = /pushFinalMetrics\s*\(\s*[^,]+,\s*[^,]+,\s*([^)]+?)\)/g;
    for (const file of files) {
        const src = readFileSync(file, 'utf8');
        // Skip the helper's own definition file — its docstring carries
        // illustrative example calls that are not real call sites.
        if (src.includes('export async function pushFinalMetrics')) continue;
        let m: RegExpExecArray | null;
        while ((m = call.exec(src)) !== null) {
            sites.push({ file, instanceArg: m[1].trim() });
        }
    }
    return sites;
}

describe('pushgateway instance-key cardinality guard', () => {
    const appsDir = findApplicationsDir();
    const appDirs = readdirSync(appsDir)
        .map((d) => join(appsDir, d))
        .filter((p) => {
            try { return statSync(join(p, 'src')).isDirectory(); } catch { return false; }
        });
    const sourceFiles = appDirs.flatMap((app) => collectSourceFiles(join(app, 'src')));
    const callSites = findPushFinalMetricsCallSites(sourceFiles);

    it('finds the pushFinalMetrics call sites (regex sanity — guards against a false pass)', () => {
        // If this drops to ~0 the scan silently stopped working; there are many
        // batch jobs pushing metrics, so assert a healthy floor.
        expect(callSites.length).toBeGreaterThanOrEqual(10);
    });

    it.each(EPHEMERAL_INSTANCE_TOKENS)(
        'no call site uses the ephemeral instance token "%s"',
        (token) => {
            const needle = token.toLowerCase();
            const offenders = callSites.filter((s) =>
                s.instanceArg.toLowerCase().includes(needle),
            );
            if (offenders.length > 0) {
                throw new Error(
                    `pushFinalMetrics instance key must be bounded/stable (userId / "global"), not "${token}". Offenders:\n` +
                        offenders.map((o) => `  ${o.file}: ${o.instanceArg}`).join('\n'),
                );
            }
            expect(offenders).toHaveLength(0);
        },
    );
});
