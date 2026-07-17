<!-- @format -->

# grounding/

Code-grounded **component-kind classification**. The clustering agent used to
guess each repo's role (frontend, backend, infra, ...) from README prose;
this subsystem replaces that guess with a deterministic classification
derived from what the repo actually contains. It also keeps confirmed
projects' components honest over time.

## The classification

`classifyComponentKind` maps a repo's signals to one of the 8
`ProjectComponentKind` values with a first-match rule order:

```text
mobile → ml → data → infra → docs → frontend → backend → shared (fallback)
```

Signals come from three places (loaded by `loadRepoRoleSignals` in one
query):

| Source table | Signal |
| --- | --- |
| `repo_sync_state.archetype_signals` | 13 booleans (has_iac, has_k8s_manifests, has_helm_chart, has_argocd_apps, has_dockerfile, has_ci, has_android_dir, has_ios_dir, has_react_native, has_flutter_pubspec, has_models_dir, has_requirements_with_ml_deps, has_notebooks) |
| `repo_sync_state.evidence_topology` | is_monorepo, has_migrations, migration_tools |
| `document_embeddings` | per-repo counts of `metadata->>'fileClass'` lanes (source, iac, ci, test, db, docs, config) |
| `repositories` / `repository_profiles` | primary language, topics, extracted tech stack |

`componentNameFor` names the component from the kind (infra distinguishes
`GitOps Infrastructure` / `Kubernetes Infrastructure` / `Infrastructure`).

## Two consumers

1. **Clustering** (increment 3): `applyGroundedComponentKinds` regroups every
   proposal's repos by derived kind before persistence, overriding whatever
   the agent claimed. Pure; grouping is preserved, only the component layer
   is rebuilt.
2. **Confirmed-project refresh** (increment 4):
   `recomputeConfirmedProjectComponents` rebuilds a confirmed project's
   `project_components` + `project_repositories` in place from current
   signals, inside the caller's transaction. Confirmed projects are excluded
   from re-clustering, so without this their kinds would never improve. The
   case-study Job runs it best-effort before generation.

## Files

| File | Role |
| --- | --- |
| `component-kind.ts` | Pure classifier: `RepoRoleSignals` interface, `classifyComponentKind`, `componentNameFor`. No I/O. |
| `repo-role-signals.ts` | `loadRepoRoleSignals(pool, userId)`: the one query joining `repositories`, `repository_profiles`, `repo_sync_state`, and `document_embeddings` lane counts, plus the pure row mapper `extractRoleSignals`. |
| `grounded-components.ts` | Pure regrouping core shared by both consumers: `regroupComponentsByKind` (one component per kind, ordered backend-first) and `applyGroundedComponentKinds`. |
| `confirmed-project-refresh.ts` | `recomputeConfirmedProjectComponents`: transactional delete + reinsert of the component layer for confirmed projects. |
| `__tests__/` | Unit tests for every module. |
