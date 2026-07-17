<!-- @format -->

# clustering/

Groups a user's synced repositories into **multi-repo project proposals**.
One run covers one user. The output is a set of AI-suggested `projects` rows
the user can confirm or dismiss in the app; confirmed projects are never
touched by later runs.

## Data flow

```text
repositories ─┐
repository_profiles ─┤→ loadRepoDigests ─┐
repository_profile_embeddings → loadDescriptionEmbeddings ─┤
                                                           ↓
                              buildClusteringSignals (pure, deterministic)
                                                           ↓
                    Redis exact cache (scope clustering:<userId>, key = input hash)
                                                           ↓ miss
                    bedrockClusteringAgent  (Haiku 4.5, tool emit_project_groupings)
                                                           ↓
                    applyGroundedComponentKinds  (../grounding, code-derived kinds)
                                                           ↓
                    persistClusteringResult → projects / project_components /
                                              project_repositories  (one transaction)
```

## Inputs (reads)

| Table | Used for |
| --- | --- |
| `repositories` | id, full name, primary language, topics, sync timestamps |
| `repository_profiles` | extracted tech stack, classification |
| `repository_profile_embeddings` | description embeddings (`chunk_type = 'description'`, pgvector) |

## Outputs (writes)

`persistClusteringResult` runs in one transaction: clears prior unconfirmed
AI proposals (`is_ai_suggested = TRUE AND is_user_confirmed = FALSE AND
shape <> 'single_repo'`), then inserts `projects` (shape `multi_repo`,
unique per-user slug), `project_components`, and `project_repositories`
links. Repos already in a confirmed project are excluded; proposals left
with fewer than 2 repos are skipped.

## Payload

`ClusteringResult` (defined in `../types.ts`): at most 8 `ClusteringProposal`
entries, each `{ name, confidence: high|medium|low, reasoning (<= 2000 chars),
components: [{ name, kind, repositoryIds[] }] }`. The agent must only
reference repos by UUID and never emits single-repo groupings; unknown ids
are filtered out after parsing.

## Files

| File | Role |
| --- | --- |
| `clustering-loader.ts` | Read path: `loadRepoDigests` + `loadDescriptionEmbeddings`, including pgvector text parsing. |
| `clustering-signals.ts` | Pure signal extraction: shared naming prefixes, shared topics (with a generic-topic blocklist), shared tech stack, and embedding-cosine pairs (threshold 0.78, cap 32). `serialiseSignalsForPrompt` flattens the maps for the prompt. |
| `clustering-agent.ts` | Bedrock tool-use agent. Model `CLUSTERING_MODEL` (default Haiku 4.5), forced tool `emit_project_groupings`, max 4096 tokens. Parses and filters the result to known repos. |
| `clustering-persistence.ts` | Transactional write path described above. |
| `clustering-orchestrator.ts` | `runClusteringOrchestration`: composes loader, signals, cache, agent, grounding, persistence. Computes the sha256 input hash used as the cache key. Short-circuits when the user has fewer than 2 repos. |
| `__tests__/` | Unit tests for the orchestrator composition. |

## Entrypoint

`applications/job-strategist/src/run-clustering.ts` (one-shot K8s Job).
Required env: `CLUSTERING_PIPELINE_RUN_ID`, `USER_ID`, `PG_*`. Feature flag
`projects.clustering.enabled`. Status flow on `pipeline_runs`:
`queued → signals_extracting → analysing → persisting → complete/failed`.
