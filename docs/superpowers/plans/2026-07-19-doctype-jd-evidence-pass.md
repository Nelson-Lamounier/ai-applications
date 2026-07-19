<!-- @format -->

# JD-Driven docType Evidence Pass Implementation Plan

**Goal:** Wire the docType retrieval filter into the JD flow as an *additive* supplementary evidence pass, so an architecture-heavy JD additionally surfaces ADR (decision) evidence and an ops/SRE-heavy JD surfaces runbook/troubleshooting evidence — without touching the main filter-then-rank retrieval.

**Design (grounded in research):** A pure `deriveEvidenceDocTypes(jdExtraction)` maps JD signals to a docType set; when non-empty, a `buildOperationsRetrieve`-style closure over the existing `querySingleRds` runs ONE narrow retrieval with a `{ docTypes }`-only prefilter (hard gate, no skills/tech), formatted into a `## Design & Operational Evidence` block and threaded into the research agent exactly like `repoFactsContext`. Main retrieval untouched (its `retrievalPrefilter` never sets docTypes). Env kill-switch + fail-open.

## Global Constraints

- Relevance keys on PRE-research JD signals only: `jdExtraction.dimensionMix.{supportOps,monitoring}` (numeric ~sum-100) + keyword scans of `concepts`/`responsibilities`/`retrievalKeywords`. NOT `pillarClassification` (a research-agent OUTPUT, unavailable pre-research).
- docType values from the canonical `DOC_TYPES`: only `'adr'`, `'runbook'`, `'troubleshooting'` are used. `deriveEvidenceDocTypes` returns `[]` (→ no pass, no block) when the JD is neither arch- nor ops-heavy.
- The supplementary prefilter sets ONLY `docTypes` (+ `skills:[]`,`tech:[]`,`minResults:K`) so the soft widener is bypassed and only the hard docType gate applies. Never mutate the main `retrievalPrefilter`.
- Additive + fail-open: env kill-switch `DOCTYPE_EVIDENCE=off` disables it; any error yields `''` and never fails the pipeline. Empty block never pushes a section.
- Prompt-injection discipline: the block renders only chunk source paths + trimmed text already returned by `querySingleRds` (same surface the main evidence uses) — no new untrusted fields.
- Zero new LLM calls beyond the one retrieval's Titan query-embed (already how querySingleRds works; no Bedrock generation). UK English; no AI trailers; ESLint clean; ESM `.js`.
- Branch `feat/doctype-jd-evidence`; per-task gate `tsc -b shared ingestion job-strategist` + shared + job-strategist jest (4 documented pre-existing failures only).

---

### Task 1: `deriveEvidenceDocTypes` (pure) + relevance rules

**Files:** Create `applications/job-strategist/src/ats/context/evidence-doctype-select.ts` + `__tests__`.

Export `deriveEvidenceDocTypes(jd: JdSignal): { docTypes: string[]; angle: 'architecture' | 'operations' | 'both' | null }`:

- **operations** when `dimensionMix.supportOps + dimensionMix.monitoring >= 25` OR any of `concepts`/`responsibilities`/`retrievalKeywords` (lowercased) contains: `incident`, `on-call`/`on call`, `observability`, `reliability`, `sre`, `runbook`, `monitoring`, `postmortem`/`post-mortem`, `sla`/`slo`. → include `'runbook'`, `'troubleshooting'`.
- **architecture** when any contains: `system design`, `architecture`, `architect`, `design decision`, `trade-off`/`tradeoff`, `scalability`, `distributed system`, `technical direction`, `rfc`, `adr`. → include `'adr'`.
- both → union + angle `'both'`; neither → `{ docTypes: [], angle: null }`.
- Dedupe; stable order `['adr','runbook','troubleshooting']` filtered to selected.

TDD: an ops JD (high supportOps) → runbook+troubleshooting/operations; an arch JD (system-design concepts) → adr/architecture; a plain frontend JD → []/null; both-signals JD → union/both; keyword-only (dimensionMix zero but concept 'incident response') → operations.

- [ ] TDD → implement → tsc + jest → commit `feat(job-strategist): deriveEvidenceDocTypes - JD-driven docType relevance`

---

### Task 2: Supplementary retrieval + formatted block

**Files:** Create `applications/job-strategist/src/ats/context/decision-evidence-context.ts` + `__tests__`.

- `buildDecisionEvidenceContext(retrieve, jd, docTypes, angle): Promise<string>` where `retrieve: (query: string, k: number) => Promise<string[]>` is a closure the caller supplies (mirrors `buildOperationsRetrieve`). Query string = a compact NL phrase from the JD, e.g. `\`${jd.targetRole} — ${(jd.concepts.slice(0,6)).join(', ')}\``. K = `DOCTYPE_EVIDENCE_K` env default 6. On empty results or any throw → `''`.
- Format: `## Design & Operational Evidence` header + a one-line intent sentence keyed on `angle` (architecture → "Architecture-decision records (ADRs) evidencing the candidate's design reasoning:"; operations → "Runbooks and troubleshooting guides evidencing operational ownership:"; both → a combined sentence), then the returned evidence strings as bullet items. Cap total length defensively (e.g. first K items). `''` when no items.
- Pure formatter unit-tested with a stub `retrieve`; assert empty-safe, angle sentences, item rendering, injection surface (only source+text passed through).

- [ ] TDD → implement → tsc + jest → commit `feat(job-strategist): decision-evidence context block from docType-scoped retrieval`

---

### Task 3: Wire into run-pipeline + research agent

**Files:** Modify `applications/job-strategist/src/run-pipeline.ts`, `applications/job-strategist/src/agents/research/research-agent.ts` (+ threading test).

- In `run-pipeline.ts` `main()`, after `repoFactsContext` is built (~:2342) and gated by `process.env['DOCTYPE_EVIDENCE'] !== 'off'`: `const { docTypes, angle } = deriveEvidenceDocTypes(jdExtraction)`; if `docTypes.length`, construct a store (`RdsVectorStore.fromEnvironment()`, the established pattern) and a `retrieve` closure `(q,k) => querySingleRds(q, env.userId, store, k, { skills: [], tech: [], minResults: k, docTypes })` (querySingleRds already imported ~:22), then `decisionEvidenceContext = await buildDecisionEvidenceContext(retrieve, jdExtraction, docTypes, angle)` inside try/catch → `''`. Default `''`.
- Thread `decisionEvidenceContext` as the new trailing positional arg to `executeResearchAgent` (~:2357).
- In `research-agent.ts`: add param `decisionEvidenceContext = ''` after `repoFactsContext` (~:836); add `decisionEvidenceContext?: string` to the buildResearchMessage opts interface (~:401); forward it (~:968-981); add a guarded `if (decisionEvidenceContext) sections.push(decisionEvidenceContext, '')` immediately after the repoFactsContext push (~:522). No persona/manifest change.
- Threading test: extend the research-agent section-order test to assert `repoFactsContext < decisionEvidenceContext` order and empty-omission.

- [ ] Implement → tsc + shared + job-strategist jest → commit `feat(job-strategist): thread decision/ops evidence into JD research (docType-driven)`

---

### Task 4: Verify + PR + live end-to-end note

- [ ] Full gates; PR `feat(job-strategist): JD-driven docType evidence pass (ADRs for architecture JDs, runbooks for ops JDs)`; CI; merge.
- [ ] The next real JD run through the UI is the end-to-end test: an architecture-leaning JD should show a `## Design & Operational Evidence` block citing ADR chunks in the research prompt; an ops JD should cite runbooks/troubleshooting. Note this completes the docType feature: stamped at ingestion → filterable in both readers → backfilled → now consumed by the JD flow.

## Self-review notes

- The hard docType gate is correct HERE because the supplementary prefilter is a separate object scoped to a dedicated query — it restricts only this pass, never the main retrieval.
- Relevance is deterministic + pre-research (dimensionMix + keywords), avoiding the pillarClassification ordering trap.
- Fully additive + kill-switched: `DOCTYPE_EVIDENCE=off` or a non-arch/non-ops JD yields exactly today's behaviour.
