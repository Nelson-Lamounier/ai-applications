# ingestion

One source tree (`@bedrock/ingestion`), one container image, a
one-shot Kubernetes Job.

## Image

| Image | Dockerfile | Entrypoint | CMD |
| :- | :- | :- | :- |
| ingestion | [`Dockerfile`](./Dockerfile) (this folder) | `src/run-ingestion.ts` | `node dist/run-ingestion.js` |

> **Retired (2026-07-18):** this workspace used to ship a second image,
> `tech-extract` (`applications/tech-extractor/Dockerfile`, entrypoint
> `src/run-tech-extract.ts`), dispatched as a sibling Job that ran the
> facts extractors standalone. It has been deleted — the dispatched
> ingestion Job now runs with `UNIFIED_INGESTION=on` in production, so
> the facts pass always executes in-process (see `on` below); there is
> no longer a sibling Job to compare against.

## UNIFIED_INGESTION flag

| Mode | Behaviour |
| :- | :- |
| `off` | Legacy two-Job behaviour, retained only as a fallback code path — no longer dispatched. The ingestion Job would ignore the tarball and facts extractors entirely, reading from the database independently of the (now-deleted) tech-extract Job. |
| `shadow` | Tarball is fetched once and the facts extractors are computed within the ingestion Job without persisting results, for parity measurement. With the tech-extract Job gone there is no sibling side left to diff against, so this mode has no live comparison target. |
| `on` (dispatched default) | Tarball is the single file source. Facts pass runs inside the ingestion Job via `runFactsStage` and results persist directly before chunking proceeds. Chunks are stamped inline during ingestion. |

The tarball fetch defaults to `WORK_DIR=/tmp/ingest-work` in this image —
the filesystem root is not writable by `appuser`. Any Job spec overriding
`WORK_DIR` should account for this.

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
