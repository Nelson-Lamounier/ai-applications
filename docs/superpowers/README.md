<!-- @format -->

# Superpowers — design archive

This directory holds **dated design artifacts** produced by the planning
workflow: `plans/` (step-by-step build plans) and `specs/` (per-feature design
specs). They are **point-in-time records**, not current documentation.

## Treat these as an archive

- They reflect what was intended and true **at the date in the filename**, and
  may reference renamed repositories (e.g. `cdk-monitoring` → `tucaken-infra`) or
  superseded architecture (e.g. Aurora → RDS PostgreSQL, self-managed Kubernetes →
  managed EKS) that has since changed.
- Do **not** edit them to match current reality — that would falsify the record.
- Do **not** treat them as authoritative for how the system works today.

## Where the source of truth lives

| Question | Authoritative source |
| :- | :- |
| How does the system work now? | the code, plus [`docs/concepts/`](../concepts/) |
| Why was a choice made? | [`docs/decisions/`](../decisions/) (ADRs) |
| How do I operate it? | [`docs/runbooks/`](../runbooks/) |
| What is a service? | [`docs/projects/`](../projects/) |

When a plan or spec produced a durable decision that isn't captured elsewhere,
distil it into an ADR or concept doc and link back — rather than mining the
archive directly. See [ADR 0006](../decisions/0006-bedrock-only-no-vendor-direct-llm.md)
for an example distilled from `specs/2026-05-25-ontology-importer-bedrock-batch-design.md`.
