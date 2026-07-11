/**
 * @format
 * Prompt-content integrity — the version bump is enforced, not honour-system.
 *
 * The frontmatter `version` feeds the prompt_invocations ledger; an edited
 * body with an unbumped version silently poisons every version-keyed A/B
 * comparison (the persona v6-v10 writer-duration bisect of 2026-07-09 was
 * only possible because versions were honest). This suite pins every
 * content/**\/*.md body hash to prompt-manifest.json:
 *
 *   Editing a prompt body =
 *     1. bump `version:` in the file's frontmatter, AND
 *     2. update its entry in prompt-manifest.json (version + sha256 — the
 *        failure message below prints the new hash).
 *
 * The manifest change makes every prompt edit visible as a two-line diff in
 * review, pairing the new hash with the new version.
 */
import { describe, it, expect } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadPrompt } from './prompt-loader.js';

const CONTENT_DIR = join(__dirname, 'content');
const manifest = JSON.parse(readFileSync(join(__dirname, 'prompt-manifest.json'), 'utf8')) as Record<string, { version: string; sha256: string }>;

/** Every .md under content/, as loader names (posix-relative, no extension). */
function discoverPromptNames(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true, recursive: true })
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => relative(CONTENT_DIR, join(e.parentPath, e.name)).replace(/\.md$/, '').split('\\').join('/'))
        .sort();
}

const names = discoverPromptNames(CONTENT_DIR);
const entries = manifest;

describe('prompt-content integrity manifest', () => {
    it('covers at least the known prompt set (discovery is not silently broken)', () => {
        expect(names.length).toBeGreaterThanOrEqual(9);
    });

    it.each(names)('%s — manifest entry exists and pairs version with body hash', (name) => {
        const { meta, body } = loadPrompt(name);
        const sha256 = createHash('sha256').update(body).digest('hex');
        const entry = entries[name];

        if (!entry) {
            throw new Error(`content/${name}.md has no prompt-manifest.json entry — add: "${name}": { "version": "${meta.version}", "sha256": "${sha256}" }`);
        }
        if (entry.sha256 !== sha256) {
            const versionBumped = entry.version !== meta.version;
            throw new Error(
                `content/${name}.md body changed (new sha256 ${sha256})` +
                (versionBumped
                    ? ` — frontmatter version bumped to ${meta.version}; update its prompt-manifest.json entry to match.`
                    : ` WITHOUT a version bump (still ${meta.version}) — bump \`version:\` in the frontmatter AND update prompt-manifest.json.`),
            );
        }
        if (entry.version !== meta.version) {
            throw new Error(`content/${name}.md version ${meta.version} disagrees with manifest ${entry.version} — update prompt-manifest.json.`);
        }
    });

    it('has no stale manifest entries for deleted/renamed prompt files', () => {
        const stale = Object.keys(entries).filter((k) => !names.includes(k));
        expect(stale).toEqual([]);
    });
});
