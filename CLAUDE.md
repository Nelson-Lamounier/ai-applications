# Project rules

## ESLint

- Always run ESLint before considering any code change complete.

## Git / branch workflow

- Do all feature work on a dedicated branch off `develop`. Never commit feature work directly to `develop` or `main`.
- **Delete every feature branch once its PR is merged** — local branch *and* the remote head if it lingers. Do not let branches accumulate; the only long-lived local branches are `develop` and `main`.
- Before deleting any branch, confirm nothing is lost: `git rev-list --count <branch> --not --remotes` must be `0`. If it has unpushed commits, push them to a same-named remote branch first, then delete.
- When a feature used a git worktree, `git worktree remove` it after the PR merges, then `git worktree prune`. Periodically `git remote prune origin` to drop stale remote-tracking refs.

## Language and writing style

- Write **all** prose in **English (UK)** — documentation, README files, code
  comments, commit bodies, PR descriptions, and user-facing copy.
- Use UK spelling: `-ise`/`-isation` (organise, optimise), `-our` (colour,
  behaviour), `-re` (centre), doubled `-ll-` (modelled, labelled). Not US forms.
- **No non-ASCII diacritics** in prose or identifiers. Write `resume`, not
  `résumé`; `cafe`, not `café`. The codebase term for the generated job document
  is **`resume`** (matches `resumeBullets`, `tailoredResumeData`,
  `resume-import-processor`) — keep docs consistent with it.
- Never assert a technical fact you have not verified. Check the code and, for
  infrastructure claims (DB engine, cluster type, vector store, region,
  resource names), the **live AWS account** before writing it. Do not copy
  forward stale claims from existing docs.

## README.md authoring (root files)

The project case-study generator reads each repo's **root `README.md`** as
ground-truth `productContext` (`applications/shared/src/projects/case-study-loader.ts`).
It takes only the **first ~1,400 characters per repo, top-down** (ordered by
`chunk_index`, no section search) and uses them for the case study's tagline +
first pitch paragraph. Position beats completeness — write root READMEs for that.

- **Lead with the product, above the fold.** The first ~800 characters must
  answer: **what** the product is, **who** it's for, **the problem** it solves,
  and **this repo's role** in the product. Everything a recruiter needs to
  understand the product belongs here, before any stack or architecture detail.
- **Tech depth goes below the fold.** Stack, decisions, challenges, and
  architecture are grounded by the generator from commits/PRs/code — they do not
  need to be in the README head and do not shape the pitch. Keep them for human
  readers, lower down.
- **Multi-repo projects:** each member repo's root README head must state *that
  repo's role in the product* (the heads are concatenated), e.g. "the AWS
  infrastructure for X — EKS, observability, delivery".
- **Verify every claim** in the README against the code and the live account
  (see the language section). A README that misstates the stack poisons the
  generated case study.

## Security and processing guardrails

- Enforce `DRY_RUN` at the tool-dispatch boundary. Prompt wording is not a safety control; any write tool must be listed in `WRITE_TOOLS` and blocked before the MCP Gateway is called.
- Authenticated handlers must derive `userId` from verified authorizer claims (`custom:user_id`, `user_id`, or `sub`) and fail closed when the claim is missing or invalid. Use `PORTFOLIO_OWNER_USER_ID` only for explicitly owner-only jobs.
- Set Postgres RLS context inside the transaction with `SELECT set_config('app.current_user_id', $1, true)`. Do not use parameterized `SET LOCAL`.
- File intake must enforce allowlisted content types and byte caps before buffering. Compare stored metadata and upstream object size when both are available.
- Retryable import persistence must be transactional and idempotent. Track every created row when a schema field promises created IDs.
- Tarball and repository processing must cap compressed size, extracted size, per-file extracted size, and text read size.
- Numbered SQL migration runners must use a ledger with checksums and must reject changed historical migrations.
- Network adapters that buffer responses must set request timeouts and response-size caps.

## LLM / Bedrock workflow design pattern

These are the standing design principles for **any** LLM-backed workflow in this repo —
Coach, ingestion, and every future implementation or refactor. When building a new
workflow or refactoring an existing one (e.g. the next ingestion iteration), apply these
where applicable. Coach is the reference implementation, not the scope.

The goal: most of the reliability and maintainability benefits people associate with
multi-agent systems, without the operational complexity. Prefer one well-organized model
call per unit of work over a fat prompt navigating branches it shouldn't be on.

### 1. Phase-specific prompts, not a fat persona with branches

Assemble each phase's prompt from a shared base plus phase-specific additions instead of
one monolithic persona full of conditional branches. Same execution model (the model
still does one call); the prompt is just better organized so the model isn't reasoning
about branches it isn't on. "Phase" = whatever the natural unit is for the workflow
(coach stage, ingestion step, enrichment layer, etc.).

### 2. Skills pattern for prompt organization

Move per-phase instructions into structured, self-contained units (Skill folders or the
equivalent module boundary). Same execution model; better separation of concerns; iterate
on one phase without touching the others.

### 3. Strengthen per-phase tool / output schemas

Each phase's tool schema defines exactly what that phase produces. Push structured-output
discipline to its useful limit: one variant per phase rather than a shared loose schema.
(Coach Phone Screen is the template — every stage should have its own.)

### 4. Default to Sonnet for nuanced structured generation

For nuanced multi-section structured output, default to Sonnet over Haiku. Haiku
flakiness on this class of task is a real signal — Sonnet pays for itself; the cost
increase is worth the reliability. Use cheaper models only where the task is genuinely
simple and reliability has been verified.

### 5. Per-phase evals — non-negotiable

Build a small eval suite per phase before expanding scope. Define what good output looks
like for that phase: correct grounding to evidence, correct phase focus, valid structured
output, no hallucination. Run it on every prompt change. This is the highest-impact AI
engineering investment available and almost no one does it well. No prompt change ships
without its eval.

### Applying to a new workflow

When you start or refactor any LLM workflow, walk this list:

1. What are the phases? Split the fat prompt accordingly.
2. Shared base + per-phase deltas, organized as Skills/modules.
3. One tight output schema per phase.
4. Sonnet by default; justify anything cheaper.
5. Per-phase evals before you scale the work.

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:
`specs/004-chunk-packing/plan.md`
<!-- SPECKIT END -->
