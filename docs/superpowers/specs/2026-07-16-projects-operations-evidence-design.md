# Projects Operations-Angle Evidence Enrichment -- Design

**Date:** 2026-07-16
**Status:** Approved design -- pending implementation plan
**Driver:** MongoDB TSE JD analysis of runs 1eda06eb/976403b3/295e86b4: the
projects pool is strong for AI-product storytelling and structurally weak
for operations storytelling. The evidence MongoDB-class JDs want (pgbouncer
pooling, RDS operations, 12k+-chunk pgvector query work, the migration
ledger as recovery/change-audit discipline, RLS hardening, EKS cluster
operations) exists in the synced KB and reaches neither pool lane: curated
bullets are case-study-angled (what was built), repo-current facts are
skill-shaped (what was verified), and nothing captures HOW the systems are
OPERATED. User framing: "the design captures what you used, not how the
database is used."

**User decisions (locked):**
- Run-time enrichment only (the multi-angle case-study pool is a follow-on
  loop, out of scope here).
- Themes from a FIXED, hand-curated ontology matched deterministically
  against the JD extraction (no LLM theme derivation).
- Component-kind scoping (user proposal, verified live): retrieval scopes
  to member repos whose `project_components.kind` maps to the theme --
  e.g. the MongoDB JD resolves to kubernetes-bootstrap + tucaken-infra
  (infra) + tucaken-app (backend), deprioritising the ml repo.
- NO new LLM calls: retrieval-only supply; the existing Sonnet projects
  agent composes from the facts under the existing citation rules.

## Component 1 -- Theme ontology + activation (new module
agents/evidence/operations-themes.ts)

- `OPERATIONS_THEMES`: seven entries, each
  `{ key, label, queryTerms, matchTerms, kinds }`:
  - database-operations | "database operations" | query "database
    operations connection pooling migrations schema backup production" |
    matchTerms [database, databases, rdbms, nosql, mongodb, postgresql,
    sql] | kinds [backend, infra]
  - performance-tuning | query "performance tuning latency memory profiling
    optimisation benchmark" | matchTerms [performance, tuning, latency,
    scalability, benchmarking] | kinds [backend, infra, ml]
  - storage | query "storage volumes disks persistence caching multipath" |
    matchTerms [storage, nas, san, ssd, caching, multi-pathing, volumes] |
    kinds [infra]
  - networking-protocols | query "networking dns tcp tls certificates
    ingress load balancer" | matchTerms [networking, dns, tcp, tls, ssl,
    protocols] | kinds [infra, backend]
  - security-hardening | query "security hardening authentication
    authorization rls iam policies" | matchTerms [security, authentication,
    authorization, hardening, ldap, kerberos, iam] | kinds [infra, backend]
  - backup-recovery | query "backup restore recovery disaster failover
    snapshot" | matchTerms [backup, recovery, restore, failover,
    disaster] | kinds [infra, backend]
  - cluster-orchestration | query "kubernetes cluster orchestration
    autoscaling operators nodes" | matchTerms [kubernetes, cluster,
    clusters, orchestration, operators] | kinds [infra]
- `activateThemes(jd: JdSignal): OperationsTheme[]` -- a theme activates
  when ANY of its matchTerms `experienceTermMatch`-es ANY of the JD's
  hardRequirements/preferred/concepts strings (reusing the shared
  predicate; no new matching logic). Sorted by number of distinct JD
  strings hit, capped at 3. Zero activations => the whole feature is a
  no-op for the run (fail-closed to today's behaviour).

## Component 2 -- Kind-scoped retrieval feeding lane 2 through the
existing gate (new module agents/evidence/operations-evidence.ts +
loader/wiring touches)

- `project_components.kind` joins into the loader: `loadProjectAgentInputs`
  SELECT gains per-repo kind (project_repositories ->
  project_components.kind), threaded into `ProjectAgentMeta` as
  `repoKinds: ReadonlyMap<fullName, kind>` (shape at implementer's
  discretion, but per-repo kind must be available per project).
- `gatherOperationsEvidence(themes, projects, retrieve)`: per (active
  project x active theme), ONE retrieval call
  (`retrieve(theme.queryTerms, k)`, the same injected
  `querySingleRds`-style function the corrective stage uses), then
  deterministic post-filtering:
  - keep chunks whose file path resolves (repoOfFile) to a member repo of
    the project whose kind is in `theme.kinds`;
  - prefer docs-lane chunks (path heuristic: .md/.mdx/docs/ paths first);
  - cap 2 facts per (project, theme), 6 per project total;
  - each kept chunk becomes a `VerifiedMatch`:
    `{ skill: theme.label, sourceCitation: cleaned one-line snippet
    (<= 200 chars, markdown stripped), evidenceFiles: [chunk file path] }`.
- The gathered matches are APPENDED to the research verifiedMatches BEFORE
  `buildProjectPool` -- the pool builder, fail-closed repo attribution,
  `[p{i}.r{k}]` ids, and provenance validation apply UNCHANGED (zero edits
  to the safety machinery). Retrieval error or zero hits => no theme facts
  (fail-open); themes with no kind-matching repos skip retrieval entirely.

## Component 3 -- Message + persona

- `projects-message.ts`: repo-current facts whose skill is a theme label
  render under an "operations evidence" grouping (theme label shown), so
  the agent sees the operations angle distinctly.
- Persona `projects-agent.md` gains one rule: when operations evidence is
  present and the JD's targets are operations-flavoured, prefer composing
  highlights from it over product-angle curated bullets -- describe how
  the system is OPERATED (pooling, tuning, recovery, security), citing the
  fact ids. Version bump + manifest regeneration via the
  prompt-content-integrity suite.

## Component 4 -- Observability + evals

- Diag (`projectsAgent` metadata block) gains
  `themes: { activated: string[], factCounts: Record<themeKey, number> }`
  (bounded: theme keys from the fixed ontology). Loki event
  `projects_theme_evidence` emitted when any facts were gathered
  (theme -> repo fullName -> count).
- Evals: (a) the MongoDB TSE JD extraction activates database-operations +
  backup-recovery (+ one more) and NOT storage-only themes a frontend JD
  would miss; (b) a pgbouncer/RDS-style docs chunk from an infra repo
  becomes a citable `[p.r]` fact and a composed bullet citing it passes
  provenance; (c) a themeless JD leaves the pool byte-identical
  (regression); (d) a theme fact whose file resolves to a repo OUTSIDE the
  project attributes nowhere (fail-closed reuse proof); (e) kind scoping:
  an ml-only chunk is NOT admitted for a [backend, infra] theme.

## Error handling

Everything fails open to today's behaviour: no activated themes, retrieval
failure, no kind-matching repos, or empty snippets all yield an unchanged
pool. No new throw can kill a run.

## Testing

Unit per module (ontology activation incl. cap + ordering; evidence
gathering incl. kind filter, docs preference, caps, snippet cleaning;
loader kind threading); evals (a)-(e); gates: full suite green (growth only
from the current baseline), tsc, ROOT eslint, ASCII, UK English; persona
bump + manifest. Live validation: next JD run's `projects_theme_evidence`
event + composed operations bullets.

## Consequences

- For operations-flavoured JDs the projects agent finally has operations
  facts to compose from -- "how the database is used", cited, honest.
- Cost: <= 6 retrieval queries per run (embedding + pgvector), no new
  agent.
- The component-kind taxonomy (already code-grounded and refreshed by the
  case-study pipeline) becomes load-bearing for resume generation --
  documented as such.
