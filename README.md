<!-- @format -->

# ai-applications

Production multi-service AI/ML platform on AWS Bedrock. Powers the article
pipeline, job strategist, chatbot, self-healing agent, ingestion, and tech
extractor that back [nelsonlamounier.com](https://nelsonlamounier.com).

> Domain glossary lives in [CONTEXT.md](CONTEXT.md). Architecture deep-dives
> and design reviews live in [docs/](docs/).

---

## Architecture at a glance

```text
api/public-api          ← Fastify HTTP layer (Lambda + Docker)
applications/
  article-pipeline      ← Research → Writer → QA agents (Bedrock)
  job-strategist        ← Resume-aware job-fit + case-study generation
  chatbot               ← Public + authenticated RAG chat
  ingestion             ← KB source ingestion (chunk, embed, persist)
  tech-extractor        ← Deterministic tech-stack extraction (3-layer)
  ontology-importer     ← Tier-2 tech ontology auto-import
  self-healing          ← Drift detection + auto-remediation agent
  synthetic-monitor     ← E2E probe runner
  platform-job-watcher  ← Cross-platform job-source poller
  shared                ← RDS interfaces, observability, security primitives
infra/                  ← AWS CDK (aspects, constructs, factories, stacks)
packages/script-utils   ← Shared CLI tooling
scripts/smoke           ← E2E smoke tests against deployed dev env
content/articles        ← Long-form engineering write-ups
```

## Stack

- **AWS Bedrock** (Claude Sonnet / Haiku) for generation, embeddings, guardrails
- **Aurora Postgres + pgvector** for KB store and semantic cache
- **Redis** (cluster) for exact AI-gen cache + read cache
- **TypeScript** end-to-end, Yarn 4 workspaces, Jest
- **AWS CDK** for infra (hexagonal: `shared/rds/interfaces/` ↔ `implementations/`)
- **Lambda + Fargate** for service runtime, Step Functions for orchestration
- **EKS** for long-running jobs (tech-extractor Layer 1, ontology importer)

## Production patterns

- Hexagonal architecture (`applications/shared/rds/{interfaces,implementations}`)
- Per-service Dockerfiles, jest configs, env contracts (`env.ts`)
- Numbered SQL migrations (`infra/.../migrations/`) with `ROLLBACK.md`
- Observability factored into `shared/observability/` (metrics, tracing, logs)
- Security primitives in `shared/security/` (input/output sanitisers, PII scrubber)
- Contract tests (`*.contract.test.ts`) for cross-service boundaries
- Smoke tests gated by `just smoke-e2e`

## Local dev

```bash
yarn install
yarn typecheck         # all workspaces
yarn test              # all workspaces
yarn lint
just                   # task index (justfile)
just smoke-e2e         # deployed-env smoke (requires .env.smoke)
```

## Documentation

- [docs/repo-structure.md](docs/repo-structure.md) — full directory tree
- [docs/reviews/](docs/reviews/) — design + implementation reviews per subsystem
- [docs/plans/](docs/plans/) — RAG sub-project plans, tier-2 ontology import
- [docs/guides/](docs/guides/) — knowledge-base source-repository guide
- [docs/checklists/](docs/checklists/) — deployment + structured-output checklists
- [docs/superpowers/](docs/superpowers/) — agent skills, specs, plans
- [docs/projects-migration/](docs/projects-migration/) — projects migration notes
- [docs/skills/](docs/skills/) — skill definitions

## License

Proprietary — all rights reserved. See [LICENSE](LICENSE). Repository is
public-for-review; no usage rights are granted.

## Disclosure

Built with Claude Code (Anthropic). Architecture, prompts, infra design, and
review decisions are authored; code is co-produced with the assistant under
human review.
