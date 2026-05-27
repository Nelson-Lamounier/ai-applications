# AI Usage

This project was built with significant AI-coding-tool assistance (Claude
Code primarily). In 2026 the credibility move is transparent disclosure
rather than denial — this document is that disclosure.

## Where AI was used

- **Scaffolding** of new services in `applications/*` followed by manual
  review and integration into the shared CDK constructs.
- **Boilerplate** for repository / mapper / DTO layers across services
  using the shared hexagonal pattern in `shared/rds/interfaces/` and
  `shared/rds/implementations/`.
- **Documentation drafts** (this file included, plus the per-app README
  intros and stack diagrams), then edited for accuracy against the
  actual deployed system.
- **SQL migration boilerplate** in `applications/platform-rds-bootstrap/migrations/`
  — the structure was AI-drafted, the actual schema decisions are mine.
- **Test fixtures and smoke-test runners** under `applications/*/tests/`.

## Where AI suggestions were overridden

- **CDK infrastructure topology.** The decision to ship per-app CDK
  stacks under a shared base (rather than one monolithic stack) was
  mine after several AI suggestions to consolidate. Constraint:
  per-app blast radius for deploys.
- **Database choice.** Postgres + the hexagonal repository pattern is
  a deliberate decision over the AI-suggested document-store
  alternative. Reason: relational queries dominate the workload and
  the migration history is canonical state.
- **Authentication / authorization paths.** Reviewed and rewritten
  manually because the AI's first pass was too permissive on
  cross-service token reuse.
- **Observability instrumentation.** OTLP + custom span names were
  added by hand to make the trace graph readable in Grafana.

## What was manually verified

- All security-sensitive paths: auth, secrets handling, token storage.
- Every SQL migration in `applications/platform-rds-bootstrap/migrations/`
  before it reached the bootstrap pipeline (reviewed locally + via
  parity-report tooling).
- All production deployment configuration in `infra/`.
- Smoke tests + parity reports that run post-deploy.

## How to interpret this disclosure

AI-assisted does not mean AI-authored. Every architectural decision in
this codebase — the hexagonal split in `shared/rds/`, the per-app CDK
stack layout, the choice to use AWS Bedrock for LLM calls, the
multi-service orchestration pattern — was made by me. The AI assisted
with making those decisions easier to express in code.

If you want to interrogate the depth of any specific module, ask. The
architecture is consistent because it was designed before any AI was
asked to scaffold inside it.

---

*Disclosure generated 2026-05-27 with tucaken-signal as a regression
test for the feedback loop. Edit / extend as the project evolves.*
