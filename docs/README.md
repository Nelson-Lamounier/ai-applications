<!-- @format -->

# docs/

Documentation index for the ai-applications monorepo. See the root
[README.md](../README.md) for the project pitch and
[CONTEXT.md](../CONTEXT.md) for the domain glossary.

## Map — kb-doc taxonomy

| Folder | Count | Highlight |
| :- | -: | :- |
| [concepts/](concepts/) | 27 | [skill-evidence-ledger](concepts/skill-evidence-ledger.md), [jd-read-centralisation](concepts/jd-read-centralisation.md), [ats-resume-generation](concepts/ats-resume-generation.md), [case-study-generation](concepts/case-study-generation.md), [coach-stages](concepts/coach-stages.md), [filter-then-rank-retrieval](concepts/filter-then-rank-retrieval.md), [per-phase-evals](concepts/per-phase-evals.md), [profile-intelligence](concepts/profile-intelligence.md), [repository-profile-and-evidence-topology](concepts/repository-profile-and-evidence-topology.md), [project-clustering](concepts/project-clustering.md), [system-tour](concepts/system-tour.md), [source-lane-provenance](concepts/source-lane-provenance.md) |
| [decisions/](decisions/) | 6 | [ADR 0007 — assessment-only matcher](decisions/0007-assessment-only-matcher.md), [ADR 0001 — deterministic over LLM extraction](decisions/0001-deterministic-over-llm-extraction.md), [ADR 0004 — Bedrock Batch over realtime](decisions/0004-bedrock-batch-over-realtime.md) |
| [projects/](projects/) | 2 | [self-healing](projects/self-healing.md), [tech-extractor](projects/tech-extractor.md) |
| [runbooks/](runbooks/) | 5 | [run-live-evals](runbooks/run-live-evals.md), [self-healing-token-budget](runbooks/self-healing-token-budget.md), [bedrock-kb-reindex](runbooks/bedrock-kb-reindex.md), [redis-cache-eviction](runbooks/redis-cache-eviction.md) |
| [troubleshooting/](troubleshooting/) | 4 | [grounding-verifier-blocks-good-answer](troubleshooting/grounding-verifier-blocks-good-answer.md), [self-healing-stuck-remediation](troubleshooting/self-healing-stuck-remediation.md), [semantic-cache-stale-responses](troubleshooting/semantic-cache-stale-responses.md), [tech-extractor-stuck-extraction](troubleshooting/tech-extractor-stuck-extraction.md) |
| [tools/](tools/) | 0 | (planned — specific technology integration notes) |
| [patterns/](patterns/) | 7 | [anti-hallucination-guards](patterns/anti-hallucination-guards.md), [hexagonal-rds-architecture](patterns/hexagonal-rds-architecture.md), [zod-tool-use](patterns/zod-tool-use.md), [must-not-throw-orchestrator](patterns/must-not-throw-orchestrator.md), [fail-open-cache](patterns/fail-open-cache.md), [composition-root](patterns/composition-root.md), [per-transaction-rls](patterns/per-transaction-rls.md) |

## Map — legacy + adjacent

| Folder | Count | Contents |
| :- | -: | :- |
| [reviews/](reviews/) | 6 | Design and implementation reviews per subsystem (ingestion, RAG sub-projects, dataset/model) |
| [plans/](plans/) | 4 | RAG sub-project implementation plans + tier-2 ontology auto-import |
| [guides/](guides/) | 1 | Operator guides — KB source-repository setup |
| [checklists/](checklists/) | 2 | Deployment + structured-output checklists |
| [superpowers/](superpowers/) | 38 | Engineering-process artefacts — dated plans + design specs |
| [skills/](skills/) | 1 bundle | Skill bundles consumed by tooling ([self-healing-updater](skills/self-healing-updater/SKILL.md)) |
| [projects-migration/](projects-migration/) | 1 | Phase-0 audit snapshot for the `projects` table migration |
| [incoming/](incoming/) | 3 | Cross-repo docs awaiting `kb-doc create` integration — do not link from elsewhere |
| [repo-structure.md](repo-structure.md) | — | Generated repository tree snapshot |

## Adjacent (non-`docs/`) documentation surfaces

| Path | Role |
| :- | :- |
| [/CONTEXT.md](../CONTEXT.md) | Canonical domain glossary (`scope`, `kbTag`, cache types, etc.) |
| [/README.md](../README.md) | Recruiter-facing root README; full architecture diagram |
| [/AI_USAGE.md](../AI_USAGE.md) | Detailed AI-tool-usage disclosure |
| [/rag-checklist/](../rag-checklist/) | Per-service RAG deploy checklists (referenced by docs/plans + docs/reviews) |
| [/content/articles/](../content/articles/) | Long-form engineering write-ups |
| [/applications/tech-extractor/parity/](../applications/tech-extractor/parity/) | Measurement artefacts cited by ADR 0001 |

## Conventions

- Filenames: `kebab-case.md` (ADRs use `NNNN-kebab-case.md`).
- **New** content follows the kb-doc taxonomy (concepts/ decisions/
  projects/ runbooks/ troubleshooting/ tools/ patterns/). Legacy
  folders are kept for the artefacts they hold; new artefacts go
  under the taxonomy.
- Cross-repo migrations land in `incoming/` first; run the `kb-doc`
  skill (create mode) to integrate them under the correct subdir.
- Generated artefacts (`repo-structure.md`) note their generator
  in a header.
- Every concept / decision / runbook / troubleshooting doc ends
  with an `<!-- Evidence trail -->` HTML comment listing the
  source files read on the date of authorship.
