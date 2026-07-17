<!-- @format -->

# change-impact/

Answers "what was the impact of the changes to file X?" with a narration
that is **structurally incapable of inventing a number**. Deterministic code
measures the facts from commit diffs; a Sonnet call phrases them; a grounding
gate discards any model output citing a figure outside the measured set and
substitutes a deterministic sentence instead. The served result is grounded
by construction.

## Data flow

```text
ChangeImpactStore (RdsRepoActivityStore in production)
  getFileChanges  → repo_commit_files history for the file (newest-first, limit 50)
  getMeasuredPerf → measured perf metrics at the oldest and newest touching commit
        ↓
buildFileChangeImpact + buildChangeImpactReport   (pure metrics)
        ↓
allowedNumbersFor(report)   (the exact citable number set)
        ↓
narrateChangeImpact (Sonnet 4.6, tool emit_change_impact, 512 max tokens)
        ↓
isGrounded(narration)?  yes → serve model output (source: 'model')
                        no  → buildDeterministicNarration (source: 'deterministic')
```

## The grounding gate

`allowedNumbersFor` collects every measured value (change count, churn, net
LOC, complexity delta, each perf before/after/percent, plus absolute
values). `findUngroundedNumbers` extracts every standalone number from the
narration and flags any not within a 0.5 tolerance (display rounding) of an
allowed value. One flagged number discards the whole model narration. The
system prompt also tells the model to cite only provided facts, but the gate
is the control; the prompt is not.

## Payloads

| Type | Fields |
| --- | --- |
| `CommitChangeMetrics` | `sha, locDelta, churn, filesChanged, byStatus` |
| `FileChangeImpact` | `filePath, changeCount, churn, netLoc, complexityDelta, lastChangedAt` |
| `PerfComparison` | `metric, unit, before, after, percentChange` |
| `ChangeImpactReport` | `filePath, structural, performance[], hasMeasuredPerf` |
| `ChangeImpactNarration` | `summary, performanceLine, grounded (always true when served), source: model\|deterministic` |

`percentChange` appears only when a real before/after pair was measured;
`complexityDelta` counts decision points (`if/for/while/case/catch/when`,
`&&`, `||`) on added minus removed diff lines.

## Files

| File | Role |
| --- | --- |
| `change-metrics.ts` | Pure Layer-1 facts from diffs: per-commit summary, per-file impact, complexity delta, percent change, report assembly. The only sanctioned source of numbers. |
| `change-impact-grounding.ts` | The anti-fabrication gate: `allowedNumbersFor`, `findUngroundedNumbers`, `isGrounded`. |
| `change-impact-narrator.ts` | The Bedrock narrator (`CHANGE_IMPACT_MODEL`, default Sonnet 4.6) plus `buildDeterministicNarration`, the always-available fallback. |
| `change-impact-service.ts` | Query-time composition: `narrateFileChangeImpact(store, ...)` ties the store, metrics, and narrator together. `ChangeImpactStore` is the persistence seam. |
| `__tests__/` | Unit tests plus a narrator `.eval.test.ts`. |

## Consumers

The subsystem is invoked at query time through the barrel (no K8s Job of its
own); the fully isolated design (no imports from any other projects
subfolder) keeps it reusable wherever grounded change narration is needed.
