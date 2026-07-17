# ingestion

One source tree (`@bedrock/ingestion`), two container images, each a
one-shot Kubernetes Job.

## Images

| Image | Dockerfile | Entrypoint | CMD |
| :- | :- | :- | :- |
| ingestion | [`Dockerfile`](./Dockerfile) (this folder) | `src/run-ingestion.ts` | `node dist/run-ingestion.js` |
| tech-extract | [`../tech-extractor/Dockerfile`](../tech-extractor/Dockerfile) | `src/run-tech-extract.ts` | `node dist/run-tech-extract.js` |

`applications/tech-extractor/` holds only its `Dockerfile`; it builds
from this workspace's source (`COPY applications/ingestion/src`), so
the two images ship independently from one tree.

## UNIFIED_INGESTION flag

| Mode | Behaviour |
| :- | :- |
| `off` (default) | Tarball and facts extractors operate as two separate Jobs. The tech-extract Job reads the tarball from GitHub, runs the facts pass, and persists results to the database. The ingestion Job ignores the UNIFIED_INGESTION environment variable and reads from the database independently — the two Jobs are dispatched concurrently, with no ordering guarantee between them. |
| `shadow` | Tarball is fetched once and the facts extractors are computed within the ingestion Job without persisting results. The in-memory evidence keys are diffed against the sibling tech-extract Job's persisted `technology_evidence` rows (scoped to this run's commit sha), and per-layer set parity on (canonical, filePath) pairs is recorded to `unified_parity_runs`. This is a set-membership comparison, not a byte-identical output check. |
| `on` | Tarball is the single file source. Facts pass runs inside the ingestion Job and results persist directly before chunking proceeds. Chunks are stamped inline during ingestion. The separate tech-extract Job is not invoked; post-hoc stamp reconciliation is skipped. |

The tech-extract image and its dedicated Job will be retired at Phase 2 once parity testing confirms the unified approach is safe. Until then, both modes coexist with the `UNIFIED_INGESTION` environment variable controlling which execution path is taken.

Because the ingestion and tech-extract Jobs are dispatched concurrently (no
ordering), the `shadow` mode's parity gate can legitimately observe an empty
legacy side if the sibling tech-extract Job has not finished writing
`technology_evidence` for this commit sha yet — this is logged as
`unified_shadow.legacy_empty` and does not fail the run.

The `shadow`/`on` tarball fetch defaults to `WORK_DIR=/tmp/ingest-work` in
this (ingestion) image, whereas the tech-extract image defaults `WORK_DIR`
to `/work` — deliberate, not an oversight: the ingestion image's filesystem
root is not writable by `appuser`. Any Job spec overriding `WORK_DIR` for one
image should account for this difference. Likewise, a parity-gate Job should
set `GITHUB_SBOM_ENABLED` identically on both the ingestion and tech-extract
Jobs, or expect a one-sided `github-sbom` parity row (the layer will show
evidence on whichever side has the lane enabled and zero on the other).

## Folder layout

- `src/acquisition/` — GitHub fetch, tarball handling
- `src/facts/` — deterministic tech-extract lanes: extractors, IaC
  parsers, manifest parsing, parity watchdog
- `src/knowledge/` — FileFilter, the chunkers (Markdown/Code/Default),
  and IngestionPipeline
- `src/narrative/` — narrative/profile synthesis
- `src/activity/` — repo activity signals
- `src/persistence/` — repository/persistence adapters
- `src/util/` — shared helpers
- `src/run-*.ts` — Job entrypoints and maintenance/eval scripts at
  the workspace root
