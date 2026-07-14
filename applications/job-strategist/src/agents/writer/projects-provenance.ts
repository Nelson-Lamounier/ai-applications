/** @format */
import type { ProjectPoolEntry } from '../evidence/project-agent-inputs.js';
import { isCurated, type ProjectsAgentEntry, type ProjectsAgentOutput } from './projects-schema.js';

const MAX_BULLETS = 6;
const MAX_COMPOSED = 2;
const MAX_DESCRIPTION_WORDS = 40;
const MIN_PITCH_OVERLAP = 0.3;

/** Lowercase alnum tokens, length > 3 -- same bar as checkProjectPitchAlignment's
 *  token approach, restated locally so this validator has no cross-module coupling. */
function distinctiveTokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter((t) => t.length > 3),
  );
}

/** id -> owning project name, across every pool entry's curated bullets and
 *  repo-current facts -- the single source of truth for cross-project citation. */
function buildGlobalIndex(pool: readonly ProjectPoolEntry[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const p of pool) {
    for (const c of p.curated) index.set(c.id, p.name);
    for (const r of p.repoCurrent) index.set(r.id, p.name);
  }
  return index;
}

/** Validates one citation id against the global index: unknown (nowhere in the
 *  pool), cross_project (owned by a different project), or duplicate (already
 *  cited by this same entry). Returns whether the id is a valid same-project
 *  citation -- callers use this to detect composed bullets with zero valid sources. */
function checkCitation(
  id: string,
  entryName: string,
  globalIndex: ReadonlyMap<string, string>,
  seen: Set<string>,
  violations: string[],
): boolean {
  const owner = globalIndex.get(id);
  if (owner === undefined) {
    violations.push(`unknown_bullet:${entryName}:${id}`);
    return false;
  }
  if (owner !== entryName) {
    violations.push(`cross_project_citation:${entryName}:${id}`);
    return false;
  }
  if (seen.has(id)) violations.push(`duplicate_bullet:${entryName}:${id}`);
  seen.add(id);
  return true;
}

/** Per-highlight citation pass: curated bulletIds and composed sources both run
 *  through checkCitation; a composed bullet with zero valid sources is re-flagged
 *  here even though the schema already requires a non-empty sources array. */
function validateHighlights(
  entry: ProjectsAgentEntry,
  globalIndex: ReadonlyMap<string, string>,
  violations: string[],
): number {
  const seen = new Set<string>();
  let composedCount = 0;
  entry.highlights.forEach((h, idx) => {
    if (isCurated(h)) {
      checkCitation(h.bulletId, entry.name, globalIndex, seen, violations);
      return;
    }
    composedCount++;
    const validSources = h.sources.filter((s) => checkCitation(s, entry.name, globalIndex, seen, violations));
    if (validSources.length === 0) violations.push(`uncited_composed:${entry.name}:${idx}`);
  });
  return composedCount;
}

function pitchOverlapViolation(entry: ProjectsAgentEntry, poolEntry: ProjectPoolEntry): string[] {
  const pitchTokens = distinctiveTokens(poolEntry.pitch);
  if (pitchTokens.size === 0) return [];
  const descTokens = distinctiveTokens(entry.description);
  let hit = 0;
  for (const t of pitchTokens) if (descTokens.has(t)) hit++;
  if (hit / pitchTokens.size < MIN_PITCH_OVERLAP) return [`pitch_overlap:${entry.name}`];
  return [];
}

/** Full validation for one output entry against its matching pool entry. */
function validateEntry(
  entry: ProjectsAgentEntry,
  poolEntry: ProjectPoolEntry,
  globalIndex: ReadonlyMap<string, string>,
): string[] {
  const violations: string[] = [];
  const composedCount = validateHighlights(entry, globalIndex, violations);

  const poolSize = poolEntry.curated.length + poolEntry.repoCurrent.length;
  const min = Math.min(3, poolSize);
  if (entry.highlights.length < min || entry.highlights.length > MAX_BULLETS) {
    violations.push(`bullet_count:${entry.name}:${entry.highlights.length}`);
  }
  if (composedCount > MAX_COMPOSED) violations.push(`composed_cap:${entry.name}:${composedCount}`);
  if (entry.github !== '' && !poolEntry.repoUrls.includes(entry.github)) {
    violations.push(`github_mismatch:${entry.name}`);
  }
  const words = entry.description.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length > MAX_DESCRIPTION_WORDS) violations.push(`description_words:${entry.name}:${words.length}`);
  violations.push(...pitchOverlapViolation(entry, poolEntry));

  return violations;
}

/**
 * Deterministic provenance rules for the Projects agent: every curated id and
 * composed source must resolve, via the global id index, to its OWN project's
 * pool (never another project's); documented projects with a non-empty curated
 * pool must appear in the output; bullet counts, github, description length and
 * pitch-opening overlap are all re-checked against the pool, never trusted from
 * the model's own emission. Returns machine-readable violation tokens; empty
 * array = valid.
 */
export function validateProjectsProvenance(
  out: ProjectsAgentOutput,
  pool: readonly ProjectPoolEntry[],
): string[] {
  const violations: string[] = [];
  const poolByName = new Map(pool.map((p) => [p.name, p]));
  const globalIndex = buildGlobalIndex(pool);

  const seenNames = new Set<string>();
  for (const entry of out.entries) {
    if (seenNames.has(entry.name)) violations.push(`duplicate_project:${entry.name}`);
    seenNames.add(entry.name);

    const poolEntry = poolByName.get(entry.name);
    if (!poolEntry) {
      violations.push(`unknown_project:${entry.name}`);
      continue;
    }
    violations.push(...validateEntry(entry, poolEntry, globalIndex));
  }

  for (const p of pool) {
    if (p.curated.length > 0 && !seenNames.has(p.name)) violations.push(`missing_project:${p.name}`);
  }

  return violations;
}

/** Thrown by the run-pipeline splice when the first projects-agent draft fails
 *  deterministic provenance validation -- mirrors ExperienceProvenanceError. */
export class ProjectsProvenanceError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(`projects provenance violated: ${violations.join(', ')}`);
    this.name = 'ProjectsProvenanceError';
    this.violations = violations;
  }
}

/** The SYSTEM assembles the final section -- the model never emits final
 *  strings unchecked. Curated highlights resolve to the pool bullet's VERBATIM
 *  text; composed highlights use their own text. `github` is the emitted value
 *  only when it is one of the project's known repo URLs, else the project's
 *  first repo URL; only projects present in the output are emitted (the
 *  validator's `missing_project` gate runs first, upstream of this call). */
export function assembleProjects(
  out: ProjectsAgentOutput,
  pool: readonly ProjectPoolEntry[],
): Array<{ name: string; description: string; github?: string; highlights: string[] }> {
  const poolByName = new Map(pool.map((p) => [p.name, p]));
  return out.entries.map((entry) => {
    const poolEntry = poolByName.get(entry.name);
    const curatedById = new Map((poolEntry?.curated ?? []).map((c) => [c.id, c.text]));
    const highlights = entry.highlights.map((h) => (isCurated(h) ? curatedById.get(h.bulletId) ?? '' : h.text));
    const validGithub = entry.github !== '' && poolEntry?.repoUrls.includes(entry.github) ? entry.github : undefined;
    const github = validGithub ?? poolEntry?.repoUrls[0];
    return {
      name: entry.name,
      description: entry.description,
      ...(github !== undefined ? { github } : {}),
      highlights,
    };
  });
}
