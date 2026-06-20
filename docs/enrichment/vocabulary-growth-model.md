# Vocabulary growth — proprietary, usage-grown (no external registry)

**Date**: 2026-06-20

The controlled vocabulary (`skill_ontology`) is NOT seeded from O*NET or an
external registry. It is grown from the application's own usage, so it becomes a
living, proprietary map of the skills *this product's* market actually trades in —
and it compounds with every user.

## Why JDs are the primary growth source (decided)
The vocabulary exists to serve `repo.skills && jd.skills` matching, which tells you
which side defines it:
- **JDs are the demand side** — the matching target. A skill no JD names is evidence
  with no buyer; a skill JDs ask for MUST be in the vocabulary or repos can never
  match it. Anchor the vocabulary to demand.
- **JDs are already canonical** — human-authored, concise, market-standard ("kubernetes",
  "infrastructure as code", "ci/cd"), the opposite of the 16,482 LLM phrasings repos
  produce.
- **Repos are the noisy supply** — coverage (implementation skills) but in endless
  variations that must be canonicalised *to* the JD vocabulary.

**Verdict: JDs improve the vocabulary most.** Repos grow it second, via the `NEW:`
queue (a repo capability recurring across users that no JD has named yet).

## The flywheel
```
user submits JD  ->  jd-extractor canonical skills  ->  added to skill_ontology (demand)
                                                              |
repo sync -> controlled-vocab enricher (emits ONLY vocabulary + NEW: gaps)
                                                              |
       NEW: gaps recurring across users  ->  promoted to skill_ontology (supply)
                                                              |
        corpus + query both canonical  ->  d.skills && query.skills overlaps -> better matching
                                                              |
                              better matching -> more users -> more JDs -> richer vocabulary
```
More repositories + JDs → richer vocabulary → sharper matching → more users. The
vocabulary is the moat; it cannot be bought, only grown from traffic.

## Mechanics (this build)
- **Shared vocabulary**: the enricher's controlled vocabulary IS `skill_ontology`
  (`SkillOntologyRepository.loadCanonicalNames`) — the SAME table the JD extractor
  canonicalises into. One vocabulary, both sides → the overlap lane fires.
- **Controlled-vocab enrichment** (`enrichTextCanonical`): the model emits ONLY
  vocabulary terms; anything off-vocabulary (explicit `NEW:` or an unrecognised
  string) is routed to the growth queue, never written to the corpus as a raw skill.
- **The golden set** grows the same way — as users run JDs, the JD-anchored chunks +
  labels extend the hand-truth (the user's note); it is not a one-off fixture.

## Growth queue (next increment — not in this PR)
A `skill_growth_queue` (term, occurrences, first_seen, source: jd|repo) accumulates
JD skills + repo `NEW:` items; a term promotes into `skill_ontology` once it recurs
across N distinct users/repos (frequency gate avoids one-off noise). Until then the
`NEW:` stream is logged by `run-canonical-eval` (the `NEW:`/chunk rate + samples).
