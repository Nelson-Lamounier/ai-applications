# grounding/

Anti-fabrication layer. Deterministic passes wrapped around the matcher's LLM
verdicts. Builds the skill-evidence ledger, attaches provenance (source path, lane,
KB passage), demotes claims contradicted by the actual code (`code-truth`,
`vendor-provenance`), strips ungrounded numbers (`number-provenance`). In: matcher
`verifiedMatches`/`partialMatches`/`gaps` + KB passages + code-tech maps. Out:
demoted/annotated matches fed to the writer. Called from `run-pipeline.ts` ~L875-960.
