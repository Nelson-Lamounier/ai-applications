<!-- @format -->

# docs/

Documentation index for the ai-applications monorepo. See the root
[README.md](../README.md) for the project pitch and
[CONTEXT.md](../CONTEXT.md) for the domain glossary.

## Map

| Folder | Contents |
| --- | --- |
| [reviews/](reviews/) | Design and implementation reviews per subsystem (ingestion, RAG sub-projects, dataset/model) |
| [plans/](plans/) | RAG sub-project implementation plans, tier-2 ontology auto-import |
| [guides/](guides/) | Operator guides — KB source-repository setup, etc. |
| [checklists/](checklists/) | Deployment + structured-output checklists |
| [superpowers/](superpowers/) | Agent-skill specs and execution plans |
| [skills/](skills/) | Skill bundles consumed by tooling (e.g. self-healing-updater) |
| [projects-migration/](projects-migration/) | Notes for the `projects` table migration |
| [incoming/](incoming/) | Cross-repo docs awaiting `kb-doc` integration — do not link from elsewhere |
| [repo-structure.md](repo-structure.md) | Generated repository tree snapshot |

## Conventions

- Filenames: `kebab-case.md`.
- New design reviews → `reviews/`. New plans → `plans/`. Operator-facing how-to → `guides/`.
- Cross-repo migrations land in `incoming/` first; run the `kb-doc` skill to
  integrate them under the correct subdir.
- Generated artefacts (e.g. `repo-structure.md`) note their generator in a header.
