/** @format */
import type { ProjectEvidenceInput } from './skill-transfer-types.js';
import type {
  SystemDesignConcern, ConcernCoverage, DetectedConcern, ConcernEvidenceRef, ConcernStrength,
} from './system-design-concerns-types.js';

// Local tokenizer — intentionally does NOT strip 'system'/'design' (unlike skill-transfer's),
// since those are meaningful here. Lowercase alphanumeric tokens length >= 3.
function tok(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s.toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 3) out.add(t);
  return out;
}
function signalTokens(signals: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const sig of signals) for (const t of tok(sig)) out.add(t);
  return out;
}
function overlaps(sig: Set<string>, label: string): boolean {
  for (const t of tok(label)) if (sig.has(t)) return true;
  return false;
}

type Hit = { ref: ConcernEvidenceRef; tier: 'strong' | 'weak' };

function componentHits(sig: Set<string>, ev: ProjectEvidenceInput): Hit[] {
  const hits: Hit[] = [];
  for (const c of ev.components) if (overlaps(sig, c.name))
    hits.push({ ref: { source: 'component', id: c.id, label: c.name }, tier: 'strong' });
  return hits;
}
function decisionHits(sig: Set<string>, ev: ProjectEvidenceInput): Hit[] {
  const hits: Hit[] = [];
  for (const d of ev.decisions) if (overlaps(sig, d.title) || (d.decision != null && overlaps(sig, d.decision)))
    hits.push({ ref: { source: 'decision', id: d.id, label: d.title }, tier: 'strong' });
  return hits;
}
function stackHits(sig: Set<string>, ev: ProjectEvidenceInput): Hit[] {
  const hits: Hit[] = [];
  for (const s of ev.stackItems) if (overlaps(sig, s.name))
    hits.push({ ref: { source: 'stack_item', id: s.id, label: s.name }, tier: 'weak' });
  return hits;
}
function tagHits(sig: Set<string>, ev: ProjectEvidenceInput): Hit[] {
  const hits: Hit[] = [];
  for (const t of ev.tags) if (overlaps(sig, t.tag))
    hits.push({ ref: { source: 'tag', id: `${t.projectId}:${t.tag}`, label: t.tag }, tier: 'weak' });
  return hits;
}
function repoHits(sig: Set<string>, ev: ProjectEvidenceInput): Hit[] {
  const hits: Hit[] = [];
  for (const e of ev.repoEvidence) if (overlaps(sig, e.rawName))
    hits.push({ ref: { source: e.source, id: e.id, label: e.rawName, fileLine: e.fileLine }, tier: 'weak' });
  return hits;
}

function hitsFor(concern: SystemDesignConcern, ev: ProjectEvidenceInput): Hit[] {
  const sig = signalTokens(concern.detectionSignals);
  if (sig.size === 0) return [];
  return [
    ...componentHits(sig, ev),
    ...decisionHits(sig, ev),
    ...stackHits(sig, ev),
    ...tagHits(sig, ev),
    ...repoHits(sig, ev),
  ];
}

function strengthOf(hits: Hit[]): ConcernStrength {
  if (hits.some(h => h.tier === 'strong')) return 'strong';
  return hits.length > 0 ? 'partial' : 'none';
}

function isRelevant(concern: SystemDesignConcern, jdTokens: Set<string>): boolean {
  if (jdTokens.size === 0) return true;
  return signalTokens(concern.jdSignalKeywords).size === 0
    ? true
    : [...signalTokens(concern.jdSignalKeywords)].some(t => jdTokens.has(t));
}

/**
 * Deterministically detect which concerns the project addresses and how strongly.
 * Pure: evidence refs come only from real project rows, so the result is grounded
 * by construction. `jdText` filters/flags relevance (empty → all relevant).
 */
export function detectConcernEvidence(
  concerns: readonly SystemDesignConcern[],
  evidence: ProjectEvidenceInput,
  jdText: string,
): ConcernCoverage {
  const jdTokens = tok(jdText);
  const detected: DetectedConcern[] = concerns.map((concern) => {
    const hits = hitsFor(concern, evidence);
    return {
      concernId: concern.concernId,
      category: concern.category,
      strength: strengthOf(hits),
      evidenceRefs: hits.map(h => h.ref),
      relevantToJd: isRelevant(concern, jdTokens),
    };
  });
  const relevant = detected.filter(d => d.relevantToJd);
  return {
    detected,
    relevantTotal: relevant.length,
    relevantAddressed: relevant.filter(d => d.strength !== 'none').length,
  };
}
