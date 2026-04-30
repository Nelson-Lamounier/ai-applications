/**
 * Smoke-test: GitHubAdapter — no RDS, no Bedrock, no Kubernetes.
 *
 * Usage:
 *   GITHUB_TOKEN=<token> REPO_FULL_NAME=owner/repo npx tsx scripts/smoke-test-github-adapter.ts
 *
 * Optional:
 *   FETCH_PATH=docs/README.md   (specific file to fetch; defaults to first listed)
 *   MAX_COMMITS=50              (commits to pull; default 50)
 */

import { GitHubAdapter } from '../applications/shared/src/ingestion/implementations/GitHubAdapter.js';

async function main(): Promise<void> {
    const token = process.env['GITHUB_TOKEN'];
    const repo  = process.env['REPO_FULL_NAME'];

    if (!token) { console.error('GITHUB_TOKEN required'); process.exit(1); }
    if (!repo)  { console.error('REPO_FULL_NAME required (e.g. nelson-lamounier/cdk-monitoring)'); process.exit(1); }

    const adapter = new GitHubAdapter(token);

    // ── Step 1: listFiles ────────────────────────────────────────────────────
    console.log(`\n[1/3] listFiles → ${repo}`);
    const files = await adapter.listFiles(repo);
    console.log(`  ✓ ${files.length} files found`);

    const mdFiles = files.filter(f => f.path.endsWith('.md'));
    console.log(`  ✓ ${mdFiles.length} markdown files:`);
    mdFiles.forEach(f => console.log(`      ${f.path}  (${f.sizeBytes} bytes)`));

    // ── Step 2: fetchFile ────────────────────────────────────────────────────
    const targetPath = process.env['FETCH_PATH'] ?? files[0]?.path;
    if (!targetPath) { console.log('\n[2/3] fetchFile — no files to fetch, skipping'); }
    else {
        console.log(`\n[2/3] fetchFile → ${targetPath}`);
        const content = await adapter.fetchFile(repo, targetPath);
        const preview = content.slice(0, 300).replace(/\n/g, '\n  ');
        console.log(`  ✓ ${content.length} chars fetched\n  Preview:\n  ${preview}${content.length > 300 ? '\n  ...' : ''}`);
    }

    // ── Step 3: listCommits ──────────────────────────────────────────────────
    const maxCommits = parseInt(process.env['MAX_COMMITS'] ?? '50', 10);
    console.log(`\n[3/3] listCommits → ${repo} (max ${maxCommits})`);
    const commits = await adapter.listCommits(repo, { maxCommits });
    console.log(`  ✓ ${commits.length} commits`);
    commits.slice(0, 5).forEach(c => {
        const short = c.sha.slice(0, 7);
        const msg   = c.message.split('\n')[0].slice(0, 72);
        console.log(`      ${short}  ${c.authoredAt.slice(0, 10)}  ${msg}`);
    });
    if (commits.length > 5) console.log(`      … (${commits.length - 5} more)`);

    console.log('\n✓ GitHubAdapter smoke test passed\n');
}

main().catch(err => { console.error(err); process.exit(1); });
