# Provenance — forked stop-slop rules

- **Upstream:** https://github.com/hardikpandya/stop-slop
- **Pinned commit:** `8da1f030185bdfe8471220585162991eaeb970e9` (2026-03-17)
- **License:** MIT — retain upstream copyright/attribution.
- **Forked files:**
  - `references/phrases.md` → `rules/phrases.ts` (`PHRASE_RULES`)
  - `references/structures.md` → `rules/structures.ts` (`STRUCTURE_RULES`)
  - `SKILL.md` scoring rubric → `rules/rubric.ts` (`RUBRIC_RULES`, `PROSE_PASS_THRESHOLD`)

## Update protocol

1. Bump the pinned commit SHA above and re-fork the changed files.
2. Run the prose-quality eval suite (`bedrock-prose-linter.test.ts` + the gated
   live runner) and reconcile any diffs.
3. This fork is Tucaken's evolving prose style guide — local additions are allowed
   and expected. Record non-upstream additions in a `## Local additions` section here.
