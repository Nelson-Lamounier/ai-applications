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
