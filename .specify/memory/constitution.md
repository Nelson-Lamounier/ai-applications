<!--
Sync Impact Report
==================
Version change: (template) → 1.0.0
Bump rationale: Initial ratification — first concrete constitution derived from
  the repository's standing CLAUDE.md rules. MAJOR baseline (1.0.0).
Modified principles: all placeholders replaced with six ratified principles:
  - [PRINCIPLE_1] → I. ESLint Gate (NON-NEGOTIABLE)
  - [PRINCIPLE_2] → II. Branch Workflow
  - [PRINCIPLE_3] → III. Language & Verified-Fact Discipline
  - [PRINCIPLE_4] → IV. README as Ground Truth
  - [PRINCIPLE_5] → V. Security & Processing Guardrails
  - (added)       → VI. LLM / Bedrock Workflow Design
Added sections: Quality Gates; Governance (amendment + versioning policy).
Removed sections: none (template placeholders SECTION_2/SECTION_3 repurposed).
Templates requiring updates:
  - .specify/templates/plan-template.md ⚠ pending (Constitution Check gate is
    generic; aligns with these principles, no token edits required)
  - .specify/templates/spec-template.md ✅ no change required
  - .specify/templates/tasks-template.md ✅ no change required
Follow-up TODOs: none — all dates and version concrete.
-->

# Tucaken AI Applications Constitution

## Core Principles

### I. ESLint Gate (NON-NEGOTIABLE)

No code change is complete until ESLint passes. Linting MUST run and be clean
before any change is considered done, committed, or proposed for review.
Rationale: a green linter is the cheapest enforceable correctness and
consistency floor; treating it as optional lets drift accumulate silently.

### II. Branch Workflow

All feature work MUST happen on a dedicated branch off `develop`. Feature work
MUST NOT be committed directly to `develop` or `main`. Merged feature branches
MUST be deleted (local and remote head). Before deleting any branch, confirm
nothing is lost: `git rev-list --count <branch> --not --remotes` MUST be `0`;
unpushed commits MUST be pushed to a same-named remote branch first. Git
worktrees MUST be removed (`git worktree remove` + `prune`) after their PR
merges. The only long-lived local branches are `develop` and `main`.
Rationale: keeps trunk releasable, prevents branch sprawl, and guarantees no
work is destroyed on cleanup.

### III. Language & Verified-Fact Discipline

All prose — docs, READMEs, comments, commit bodies, PR descriptions, user-facing
copy — MUST be English (UK): `-ise`/`-isation`, `-our`, `-re`, doubled `-ll-`.
No non-ASCII diacritics in prose or identifiers (`resume`, not the accented
form). The generated job document is termed `resume` to match the codebase.
A technical fact MUST NOT be asserted unless verified: check the code, and for
infrastructure claims (DB engine, cluster type, vector store, region, resource
names) check the live AWS account. Stale claims MUST NOT be copied forward.
Rationale: a single misstated stack fact poisons every downstream artefact the
generator produces from it.

### IV. README as Ground Truth

Each repo's root `README.md` is ground-truth `productContext` for the
case-study generator, which reads only the first ~1,400 characters top-down.
The first ~800 characters MUST answer what the product is, who it is for, the
problem it solves, and this repo's role in the product. Stack, decisions, and
architecture detail go below the fold. In multi-repo projects each member
repo's README head MUST state that repo's role in the product. Every claim in a
README MUST be verified against code and the live account.
Rationale: position beats completeness — the head of the README is what becomes
the public case study, so it must be product-first and accurate.

### V. Security & Processing Guardrails

The following MUST hold:

- `DRY_RUN` is enforced at the tool-dispatch boundary; every write tool is
  listed in `WRITE_TOOLS` and blocked before the MCP Gateway is called. Prompt
  wording is not a safety control.
- Authenticated handlers derive `userId` from verified authorizer claims
  (`custom:user_id`, `user_id`, or `sub`) and fail closed when the claim is
  missing or invalid. `PORTFOLIO_OWNER_USER_ID` is used only for owner-only jobs.
- Postgres RLS context is set inside the transaction with
  `SELECT set_config('app.current_user_id', $1, true)` — never parameterized
  `SET LOCAL`.
- File intake enforces allowlisted content types and byte caps before
  buffering, comparing stored metadata and upstream object size when both exist.
- Retryable import persistence is transactional and idempotent, tracking every
  created row when a schema field promises created IDs.
- Tarball and repository processing caps compressed size, extracted size,
  per-file extracted size, and text-read size.
- Numbered SQL migration runners use a checksum ledger and reject changed
  historical migrations.
- Network adapters that buffer responses set request timeouts and
  response-size caps.

Rationale: these are the load-bearing controls against privilege escalation,
resource exhaustion, and silent data corruption; they are guardrails, not
guidelines.

### VI. LLM / Bedrock Workflow Design

Any LLM-backed workflow MUST follow these design principles: assemble
phase-specific prompts from a shared base plus per-phase deltas, not a fat
persona full of conditional branches; organise per-phase instructions as
self-contained Skills/modules; give each phase one tight output schema rather
than a shared loose one; default to Sonnet for nuanced structured generation and
justify anything cheaper; and build per-phase evals before scaling scope — no
prompt change ships without its eval.
Rationale: most reliability benefits of multi-agent systems without the
operational complexity — one well-organised model call per unit of work.

## Quality Gates

Before a change is considered complete it MUST satisfy, in order: ESLint clean
(Principle I); for any LLM workflow change, its per-phase eval run and passing
(Principle VI); for security-sensitive paths, the relevant Principle V controls
verified present; for any documentation or README change, UK-English and
verified-fact checks (Principles III, IV). A change failing any applicable gate
is not done, regardless of feature completeness.

## Governance

This constitution is derived from the project's standing CLAUDE.md rules and
supersedes default agent behaviour where they conflict. User instructions in
CLAUDE.md remain the source of truth; this document is the ratified, versioned
expression of them for spec-kit planning.

Amendments MUST be made by editing this file, recording the change in the Sync
Impact Report, and bumping the version per semantic versioning: MAJOR for
backward-incompatible principle removals or redefinitions, MINOR for a new
principle or materially expanded guidance, PATCH for clarifications and wording.
Every `/speckit-plan` MUST verify its design against these principles at the
Constitution Check gate; unjustified violations block the plan.

**Version**: 1.0.0 | **Ratified**: 2026-06-19 | **Last Amended**: 2026-06-19
