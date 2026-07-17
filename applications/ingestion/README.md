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
| `off` (default) | Tarball and facts extractors operate as two separate Jobs. The tech-extract Job reads the tarball from GitHub, runs the facts pass, and persists results to the database. The ingestion Job ignores the UNIFIED_INGESTION environment variable and reads from the database after the tech-extract Job completes. |
| `shadow` | Tarball is fetched once and the facts extractors are computed within the ingestion Job without persisting results. Per-layer parity records are written to `unified_parity_runs` for audit purposes. This mode validates that the facts pass produces byte-identical results when run inside the ingestion image. |
| `on` | Tarball is the single file source. Facts pass runs inside the ingestion Job and results persist directly before chunking proceeds. Chunks are stamped inline during ingestion. The separate tech-extract Job is not invoked; post-hoc stamp reconciliation is skipped. |

The tech-extract image and its dedicated Job will be retired at Phase 2 once parity testing confirms the unified approach is safe. Until then, both modes coexist with the `UNIFIED_INGESTION` environment variable controlling which execution path is taken.

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
