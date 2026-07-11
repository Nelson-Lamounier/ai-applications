Live project data is in — and it already surfaces the headline cost finding. While the code deep-dive agent finishes, the shape of it:

The generated project is narratively strong: the pitch (2,290 chars) leads with a differentiator ("Most personal portfolios are static pages you scroll — this one you can talk to"), the tagline is recruiter-parseable, and highlights carry verified numbers (LCP 132 ms). 5 challenges / 5 decisions / 5 highlights persisted as structured rows.
The cost profile is the standout problem: project-case-study ran 5 calls at 516K input tokens total (~103K per call!) for $2.75 on this one project, plus system-tour at $0.53. A 103K-token prompt into Sonnet per generation is the single biggest optimisation target in the whole feature — that's the "can I cut the LLM input/response" question answering itself before we even see the prompt assembly.
One field is empty: product_description — worth checking whether it's a newer field the generator never populates.

Yes — the code deep-dive agent is still working (it has a lot of files to read). While it finishes, let me answer one puzzle from the live data myself — whether the 5 case-study calls were regenerations or a multi-pass design (different cost implications):

PROJECTS feature — factual map (worktree: /Users/nelsonlamounier/Desktop/portfolio/ai-applications/.worktrees/enrichment-rag-ab)
All paths below are relative to the worktree root unless absolute. Line numbers verified against the worktree as of today.

1. Exact LLM input assembly (case-study agent)
Entry: runCaseStudyOrchestration() (applications/shared/src/projects/case-study-orchestrator.ts:208) → loadCaseStudyContext() (applications/shared/src/projects/case-study-loader.ts:308) → packContext() → bedrockCaseStudyAgent.invoke() (applications/shared/src/projects/case-study-agent.ts:553).

System prompt (case-study-agent.ts:65-162)
Opens verbatim:

You are a portfolio editor writing the case study for a single project. The project may span multiple repositories. Your output is read by recruiters and engineers; treat every claim as something the author may be asked about in an interview.

Then "Lead with the PRODUCT, then the engineering…", "Synthesise ONE coherent project story…", 9 numbered rules (evidence citation, productContext exemption, tagline/pitch shape, ADR decisions ≤5, challenges ≤5, highlights 3–5, resumeBullets ≤250 chars, honest depthMarkers, Mermaid architecture), a <verifiedStack> paragraph, and a closing confident-voice paragraph. Optional appendices via buildSystemPrompt() (agent.ts:211-229):

Archetype calibration block ('Project calibration:', This is a ${stage}-level ${archetype.name} project…) when context.archetype is set.
REFINE_PROMPT_BLOCK (agent.ts:172-196, REFINE MODE — a prior case study … <priorCaseStudy> … <newRepos> coverage guarantee) when priorCaseStudy present.
CASE_STUDY_PROMPT_VERSION = sha256(SYSTEM_PROMPT_TEXT + REFINE_PROMPT_BLOCK).slice(0,12) — folded into the cache key (agent.ts:205-209).

User message blocks, in order (buildUserMessage, agent.ts:433-499)
#	Tag (verbatim)	Content	Loader source	Caps
1	<project>	JSON envelope {projectName, tagline, pitch, components, repositories, commits, pulls}	projects (id,user_id,name,tagline,pitch,product_description,user_overrides,type,shape — loader.ts:312-315); project_components (name+kind, ORDER BY order_index, loader.ts:322-326); repos: project_repositories→repositories + repository_profiles.extracted->'tech_stack' (loader.ts:328-352); commits: repo_commits all rows, ORDER BY authored_at DESC, no SQL LIMIT (loader.ts:405-419); pulls: repo_pull_requests all rows, ORDER BY merged_at DESC NULLS LAST, no SQL LIMIT (loader.ts:423-439)	Bounded only by packContext (see below). Ingestion itself caps storage at 500 commits / 100 PRs per repo (RepoIngestionOrchestrator.ts:156,159)
2	<productContext> (only if non-empty)	Precedence: projects.product_description override verbatim → per-repo ### {fullName} + GitHub description + head of root README (loader.ts:140-158)	READMEs from document_embeddings WHERE lower(file_path) IN ('readme.md','readme') ORDER BY chunk_index (loader.ts:387-395)	README_CHARS_PER_REPO = 1_400/repo (loader.ts:111), global PRODUCT_CONTEXT_CHARS = 4_000 (loader.ts:113)
3	<kbChunks>	JSON array {repoFullName, filePath, chunkType:'document', content}	document_embeddings scoped to member repos, ORDER BY de.last_synced_at DESC LIMIT 24 (loader.ts:370-381) — pure recency, no embedding similarity, no fileClass filter, chunk_type hardcoded 'document'	KB_CHUNK_CAP = 24 (loader.ts:103); 2,400 chars/chunk after packing
4	<fileChanges> (if any)	most-changed files {repoFullName, filePath, additions, deletions, changes}	repo_commit_files GROUP BY file, ORDER BY sum(additions)+sum(deletions) DESC LIMIT 30 (loader.ts:201-210)	FILE_CHANGE_CAP = 30 (loader.ts:109)
5	<verifiedStack> (if any)	{name, version, purl} per canonical	technology_evidence JOIN technology_ontology, source_layer IN ('syft','treesitter','iac','dockerfile') (loader.ts:236-257)	VERIFIED_STACK_CAP = 80, version-bearing first (loader.ts:107, 252-257)
6	<priorCaseStudy> (refine only)	reconstructed from projects + project_decisions/highlights/challenges/stack_items with stored source_signals (case-study-refine.ts:85-160)	gated on projects.case_study_generated_at not status (refine.ts:94-99)	none
7	<newRepos> (refine + new repos)	repos not cited by any prior row (underrepresentedRepos, refine.ts:59-70)	—	—
8	closing line	Emit the emit_case_study tool now. (agent.ts:497)	—	—
Token budget (case-study-context-budget.ts)
CONTEXT_TOKEN_BUDGET = 120_000 est. tokens (loader.ts:166), ~4 chars/token heuristic. Per-item truncation: commit message 800 chars, KB chunk 2,400 chars, PR body 1,200 chars (budget.ts:42-44). Then greedy fill in priority order: commits → kbChunks → pulls (budget.ts:89-110). Skeleton (project/components/repos + productContext + verifiedStack + fileChanges etc.) is always preserved.

Field provenance summary
projects: name, tagline, pitch, product_description, type, shape, user_overrides (loaded but deliberately NOT forwarded to the prompt — agent.ts:434-436).
project_components: name, kind.
repository_profiles.extracted: only tech_stack array (repo metadata) — classification is used by clustering, not case study.
repo_commits: sha, author_name, author_login, authored_at, message.
repo_pull_requests: number, title, body, state, author_login, merged_at, html_url.
repo_commit_files: churn aggregation → <fileChanges>.
technology_evidence: → <verifiedStack> (prompt) + persist-time stamping.
document_embeddings: (a) 24 recency chunks, (b) README rows for productContext, (c) metadata->>'fileClass' lane counts for deterministic depth markers (loader.ts:187-193) — prompt never sees the lane counts; they override the output.
repo_sync_state.archetype_signals: OR-merged (loader.ts:358-367) → archetype classification (calibration block) + depth markers. Raw signals never enter the prompt.
skills[] chunk metadata, tech_skill_map, file_tech_stack: NOT used anywhere in the projects prompt path (verified by grep — tech_skill_map only in applications/ingestion/* + TechSkillMapRepository; file_tech_stack only stamped in applications/shared/src/projects/stamp-evidence-metadata.ts for retrieval, never read back by case study).
Stale-doc flag: case-study-types.ts:230-246 comments claim "capped by MAX_COMMITS (default 50)" and "MAX_PULLS_PER_REPO (default 25)" — no such caps exist in the loader; the real bound is packContext + ingestion's 500/100.

2. Output contract
Forced Bedrock tool_use, single tool emit_case_study (agent.ts:403-429). Required top-level keys: tagline (≤200), pitch (≤4000), stack (≤40 items), decisions (≤5), highlights (≤5), challenges (≤5), depthMarkers, architecture ({diagramFormat: mermaid|svg, diagramSource, nodes[], edges[]}), resumeBullets (1–6 sets, angles: backend|frontend|infrastructure|fullstack|data_ml|product_leadership, ≤8 bullets ≤500 chars each). Every stack/decision/highlight/challenge row carries sourceSignals {commits[], pulls[], files[], ungroundedClaims[], grounding} (types.ts:48-103).

Parsing: parseJsonResponse → Zod CaseStudySchema.safeParse; on failure two deterministic repairs (coerceArchitectureString, clampOversizedFields — case-study-schema-repair.ts) then re-validate; if still failing, one bounded model retry feeding the exact Zod issues back (agent.ts:576-594).

Persistence (case-study-persistence.ts, one transaction): projects (tagline, pitch, case_study_status='complete', case_study_generated_at/pipeline_run_id/model/input_hash, computed_archetype, computed_stage); project_stack_items (+ server-side verifiedTech stamping via stampStackSignals, persistence.ts:362-375); project_decisions (preserveUserConfirmed); project_highlights; project_challenges — all reconciled idempotently by (project_id, content_hash) insert-then-prune (persistence.ts:178-248); project_depth_markers (upsert, ON CONFLICT project_id); project_architecture (upsert, is_user_edited=FALSE guard, Mermaid normalised); project_resume_bullets (upsert per (project_id, angle)). Sticky sections in projects.user_overrides are skipped. depthMarkers are overridden pre-persist with deterministic values (orchestrator.ts:249-250, case-study-depth.ts — fileClass lane counts + archetype signals + refactor-commit regex count).

System tour: separate Sonnet call after persist (run-case-study.ts:256-266), input = the case study only, output project_system_tours (migration 063). Tool emit_system_tour: area, context, keyDecisions (1–6), tradeoffs (≤6), systemMap (must copy architecture verbatim), outcomes (≤6), whatIdChange (≤4, evidenced limitations only).

UI reads (tucaken-app, src/features/projects/components/detail/ProjectDetail.tsx): one query projectsQueries.detail(projectId) rendering Hero, Pitch (project.pitch), Repositories (repositories + components + case_study_generated_at), Architecture (project.architecture), StackMap (stack_items), DepthMarkers (depth_markers), Highlights, Challenges, DecisionLog (decisions), ResumeBullets (resume_bullets), ShareCaseStudy (slug, visibility). Plus public/PublicCaseStudy.tsx. A UI consumer for project_system_tours was not found in the dirs I can read — unverified.

3. Model + token economics
Agent	Model env (default)	maxTokens	thinkingBudget	Notes
case-study	CASE_STUDY_MODEL → eu.anthropic.claude-sonnet-4-6; INFERENCE_PROFILE_ARN wins (agent.ts:45-50; env-case-study.ts:33-34)	32,768 (agent.ts:58)	0 (forced tool_use, agent.ts:61)	context budget 120k est. input tokens
system-tour	SYSTEM_TOUR_MODEL → sonnet-4-6 (system-tour-agent.ts:39-44)	16,384	0	runs on every case-study Job; runSystemTour supports a cache but run-case-study.ts:258-265 passes none → tour Sonnet call every run
clustering	CLUSTERING_MODEL → eu.anthropic.claude-haiku-4-5-20251001-v1:0 (clustering-agent.ts:39-41)	4,096	0	MAX_PROPOSALS=8; input = repo digests + deterministic signals only
overview judge (eval-only)	CASE_STUDY_MODEL → sonnet (narrative-grader.ts:161)	512	0	behind CASE_STUDY_EVAL_JUDGE=1, E2E script only
change-impact narrator	CHANGE_IMPACT_MODEL → sonnet (change-impact-narrator.ts:29)	512	0	see gaps — no production caller
Pricing table (applications/shared/src/metrics.ts:132-146): sonnet-4-6 $0.003/1k in, $0.015/1k out; haiku-4-5 $0.001/1k in, $0.005/1k out. Cost accumulated per invocation (agent-runner.ts:479-539; cents attribution uses a fixed 60/40 input/output split heuristic, lines 537-539). No Bedrock prompt caching anywhere (no cachePoint/cache_control in agent-runner/base-agent — verified by grep).

Caching layers: RedisExactCache keyed by computeInputHash (orchestrator.ts:133-154) — hash covers prompt version, project id/name/tagline/pitch/productContext, components, repo names+techStack+topics, commit SHAs, PR number/state/mergedAt, archetype/stage/sections. Not hashed: kbChunks content, fileChangeEvidence, verifiedStack — a dependency-version change alone never busts the cache. Refine runs bypass the cache entirely (orchestrator.ts:70-72,226) and refine is on by default (CASE_STUDY_DISABLE_REFINE !== 'true', run-case-study.ts:225) — so after the first completion, every regenerate is a paid Sonnet call.

Prompt bloat candidates:

Commits fill first in the greedy pack: up to 500/repo × 800 chars — on multi-repo projects they can consume most of the 120k budget while PRs (packed last, despite the prompt calling them "the strongest form of evidence") get dropped entirely.
depthMarkers are a required output the model must generate but the orchestrator throws away and replaces deterministically — wasted output tokens + schema burden.
KB chunks: 24×2,400 chars of recency-arbitrary content (see gaps).
Two Sonnet calls per Job (case study + tour) with the whole case study re-serialised as tour input.
4. Narrative controls
Recruiter framing (verbatim): system prompt line 2-3: Your output is read by recruiters and engineers; treat every claim as something the author may be asked about in an interview. Also rule 6: highlights are 3–5 things a recruiter could point to in 5 seconds and calibration: Recruiters at this level look hardest at: ${priority}.
Voice: rule 3 Written in the candidate's voice ("I built" / "I designed", never "we built"); closing: Narrate real, evidenced work plainly and confidently… Avoid hedged phrasing ("claimed", "attempted to", "appears to").
Grounding: rule 1 evidence-citation requirement; production grounding is now deterministic citation-presence — groundFromCitations (orchestrator.ts:169-182): GROUNDED iff any commit/PR/file cited, else NOT_VERIFIED. The previous per-row LLM verifier was removed because it "flagged ~100% as NOT_GROUNDED — noise… burned ~15 Haiku calls per run" (orchestrator.ts:157-168). Nothing verifies a cited SHA/PR actually exists in the supplied context (schema regex only).
Graders (eval/CI only, NOT a production gate — only consumer is scripts/test-projects-case-study.ts and unit tests):
case-study-product-grader.ts: taglineIsProductFirst, pitchOpensWithProduct, noInfraOpener (deterministic, TECH_TOKENS set).
case-study-narrative-grader.ts: workLeadsNarrative (every engineering row cites commit/PR), techNotSpine (no tech-dominated pitch paragraph opener, no repo-name-led or ≥3-tech roll-call highlight titles), confidentVoice (hedge regexes incl. \bwe built\b); plus injectable judgeCombinedOverview LLM judge (threshold 0.7), prompt: Score 0..1 on TWO things together: (1) the pitch reads as ONE coherent product story across all repositories… (2) technology is supporting detail, not the spine….
case-study-refine-grader.ts (preservation/coverage checks for refine mode).
Invented-metric guardrail: the case-study prompt has no explicit "never invent a number" rule — resume bullets are told to be quantified where possible, guarded only by evidence citation. The strict number gate exists only in change-impact-narrator (isGrounded discards any narration citing a figure absent from the report, narrator.ts:66-71).
5. Connection to ingestion skills
Chunk skills[]: never read by clustering, case study, system tour, or project persistence. Assigned at ingestion by applications/shared/src/rds/enrichment/assignSkillsToChunks.ts + tier1-skill-rules.ts (Tier-1 deterministic, post-LLM-enrichment retirement); consumed only by retrieval (RdsVectorStore filter-then-rank skills lane, now A/B-parameterised — commit e6967c1: recall@8 identical 0.9194 lane-on vs lane-off, the measured basis for retiring per-chunk Haiku enrichment).
tech_skill_map: ingestion-only (run-ingestion.ts:225,304, run-reenrich.ts, evals).
technology_evidence: YES — twice in projects (loader <verifiedStack> + persist-time verifiedTech stamping), and in strategist-side RdsProjectEvidenceRepository.load() (repoEvidence union with dsa_evidence, project-evidence.ts:30-49).
file_tech_stack: stamped onto chunk metadata for retrieval (stamp-evidence-metadata.ts:58-69); not read by projects.
Net effect of enrichment retirement on projects: none — the case-study prompt never consumed chunk skills; its KB input is raw chunk content only.
6. Connection to job-strategist (JD pipeline)
Join points, all fail-open:

RdsProjectEvidenceRepository.load() (applications/shared/src/stage-prep/project-evidence.ts:11-85): projects (non-archived; archived single-repo defaults excluded to avoid double-count), components, decisions, stack items, tags, highlights, challenges, tech/dsa evidence, repos-per-project.
formatProjectEvidence() (stage-prep/format-project-evidence.ts:50-84): renders the block headed verbatim PROJECT CASE STUDIES — the candidate has N documented project(s) (their own work), listed below. + RESUME RULE: represent EACH documented project as EXACTLY ONE résumé project entry…. Caps: 8 projects, 12 stack, 5 decisions, 5 highlights, 4 challenges per project; ranked by documentedScore (highlights+decisions ×2). Note format-project-evidence.ts:118-119 comment: "case-study regeneration currently accumulates rows, so near-dupes occur" — stale: persistence now prunes (insert+prune added later); the dedupe remains as belt-and-braces.
Research agent (run-pipeline.ts:612-626 → research-agent.ts:489-497): section header verbatim ## Project Case Studies — Documented Portfolio Projects (factual, citeable evidence) — "Treat as factual evidence ALONGSIDE the KB passages… you may name the project as its source citation." Combined with Profile Intelligence into candidateGroundingBlock.
Strategist agent (strategist-agent.ts:288-296): ### Documented Project Case Studies (CITEABLE EVIDENCE) (--- BEGIN PROJECT CASE STUDIES ---). Plus loadAchievementEvidence (agents/achievement-evidence.ts): raw SQL over project_challenges/decisions/highlights (caps 4/4/4, user-wide, no project scoping/ranking) → strategist section ### Achievement & Impact Evidence (use for the cover letter: lead with a challenge overcome; …) (strategist-agent.ts:300-305).
Resume guard (resume-guard.ts:788-789): repair prompt For project_restates_bullets: rewrite each flagged project description in three beats — (1) open with its documented pitch: ${formatPitches(...)}…; pitches from loadProjectLaneIndex (project-evidence-block.ts:35-54, pitch = p.pitch ?? p.tagline first 200 chars). Also project-name variants for lane classification (resume-guard.ts:197).
Cover-letter guard (cover-letter-guard.ts:221): …ownership via the documented projects (${narrative.projectPitches.map(pp => ${pp.name}: ${pp.pitch.slice(0,120)})…})….
Free pipeline (free/gather-evidence.ts:55,63 → free-resume-writer.ts:430,435): <project_evidence> and <achievements_and_impact> XML tags.
Coach (run-coach.ts:302,334,365): project evidence drives joinSkillCandidates (skill-transfer stages), detectConcernEvidence (system-design walkthrough), detectPrincipleEvidence (bar-raiser). The system tour itself is not consumed by the coach (not found).
7. Trigger / refresh model
Clustering (Haiku, per user): manual only — admin-api POST /clustering/run (tucaken-app admin-api/src/routes/projects.ts:554-621; Pro-gated; inserts pipeline_runs type='clustering', creates K8s Job node dist/run-clustering.js). Proposals surface via GET /clustering/proposals → review UI (ProjectReviewStep.tsx). Cache: RedisExactCache scope clustering:{userId}, kbTag=environment, exact input hash.
Case study (Sonnet, per project): case_study_status='pending' is set by three writers — (a) POST /:id/confirm (project confirmation, routes/projects.ts:339-350), (b) POST /:id/regenerate manual CTA (routes/projects.ts:634-663; UI Regenerate button in Hero.tsx/ProjectCard.tsx), (c) post-sync intent in ingestion: applyPostSyncProjectAction (applications/ingestion/src/util/applyPostSyncProjectAction.ts) — Add-repo-time 'build' (confirm + queue) or 'link' (move repo into target project + queue target). A reconciler loop in admin-api (case-study-reconciler.ts, TICK_MS=30_000, 120-second debounce + non-terminal-run guard, LIMIT 20) dispatches the K8s Job for confirmed pending projects.
Within a Job (run-case-study.ts): feature-flag projects.case_study.enabled → best-effort component refresh from grounded role signals (recomputeConfirmedProjectComponents) → refine-by-default (prior exists ⇒ REFINE mode; refine bypasses semantic cache; new-repo refine scopes commits/PRs/KB to the new repos only, scopeEvidenceToRepos, orchestrator.ts:329-334) → generate → deterministic grounding → persist → cache write (full runs only) → system tour (fail-open) → optional article-topic discovery (ARTICLE_TOPIC_DISCOVERY=1, derives candidates from challenges+decisions, article-topic-discovery.ts).
No automatic regeneration on ordinary re-sync — only the explicit post-sync 'build'/'link' intent or user CTA flips status to pending. (No other case_study_status='pending' writer found.)
8. Gaps / observations
KB chunk selection is recency-arbitrary: ORDER BY last_synced_at DESC LIMIT 24 — no similarity, no fileClass/doc preference, and since last_synced_at is per-sync-batch the intra-repo order is effectively unspecified; the 24 slots can be filled by config/source chunks of whichever repo synced last, and can duplicate README content already in <productContext>. The retrieval-quality machinery (kb_quality scores, filter-then-rank prefilter, multi-query retrieval) used by the strategist is not used here.
PRs packed last in the token budget (commits → KB → pulls) while the prompt declares PRs "the strongest form of evidence" — on large multi-repo projects PR evidence is the first thing silently dropped. PR review comments are not ingested at all (only PR metadata: title/body/state/urls).
Model-generated depthMarkers are discarded (deterministic override at orchestrator.ts:249-250) yet remain a required tool-schema field — wasted output tokens and schema complexity; same for the risk that architecture.nodes/edges duplicates diagramSource.
Cache-key blind spots: computeInputHash omits kbChunks content, fileChangeEvidence, verifiedStack — dependency/version or README-chunk changes alone can serve a stale cached study. Conversely, the agent's own tagline/pitch output is written back to projects and is hashed as input next run — self-referential hash churn.
change-impact-narrator / change-impact-service are dead code in this repo: exported from projects/index.ts:189-190 but no production caller (grep-verified). File header says "A route, chatbot tool, or coach can call this" — none does. (Possible external consumer in tucaken-app not visible from my access — unverified.)
Graders are eval-only: product/narrative graders and the overview judge never run in the production Job — a regression in pitch framing ships unchecked; the only production gates are the JSON schema, the citation-presence grounding, and deterministic depth/stack stamping.
No verification that cited evidence is real: citation-presence == GROUNDED; a fabricated-but-well-formed SHA would pass (regex ^[0-9a-f]{7,40}$ only). The prior LLM verifier was removed; the "hallucination safety net is being redesigned separately" (orchestrator.ts:166-167).
Achievement-evidence loader is unranked and user-global (achievement-evidence.ts:33-41): ORDER BY order_index LIMIT 4 across ALL projects mixes rows from different projects arbitrarily (order_index is per project) — the cover-letter evidence may come from the least relevant project.
Data available but never fed to the case-study prompt: evidence_topology (repository_profiles — used by strategist ATS repo-profile.ts, not projects), raw archetype_signals, repository_profiles.extracted fields beyond tech_stack (classification/quality_score), dsa_evidence, repo_sync_state recency stats, chunk skills[], kb_quality, per-file file_tech_stack.
Stale comments: case-study-types.ts:230-246 (MAX_COMMITS 50 / MAX_PULLS_PER_REPO 25 — nonexistent), format-project-evidence.ts:118-119 ("regeneration currently accumulates rows" — persistence now prunes), types.ts:82-88 still describes BedrockGroundingVerifier (mode='flag') which no longer runs; docs case-study-generation.md still shows a "grounding verifier" stage and "grade the subjective dimension" wording.
System tour cost: regenerated on every case-study Job (cache parameter exists but is not wired in run-case-study.ts) even when the case study came from the semantic cache — a cache-hit run still pays a full Sonnet tour call. (Tour skip-on-identical-hash exists only if a cache were passed.)
Duplicate SQL: verified-stack map is loaded twice per run (loader for the prompt, persistence for stamping) with near-identical queries (loader.ts:236-243 vs persistence.ts:51-61).
Inconsistent caps across surfaces: prompt stack ≤40 vs strategist block shows ≤12/project; decisions ≤5 everywhere but achievement-evidence caps at 4; resume bullets ≤8×500 chars generated vs prompt rule says "never longer than 250 characters" (schema allows 500 — rule/schema mismatch).
Bash Timeline of case-study calls: regenerations vs multi-pass
IN
S=/private/tmp/claude-501/-Users-nelsonlamounier-Desktop-portfolio-tucaken-infra/7d2e62dc-43f6-4140-96f8-57f6a99c3a05/scratchpad/dbq.sh && $S "SELECT invoked_at::timestamp(0), agent, system_prompt_tokens+user_message_tokens AS in_tok, output_tokens AS out_tok, round(total_cost_cents/100.0,3) AS usd, cache_tokens_saved FROM prompt_invocations WHERE project_id='7ca4da40-b895-4c6b-a211-40702b3ad19c' ORDER BY invoked_at;" 2>&1 | grep -v PodSecurity

OUT
     invoked_at      |        agent        | in_tok | out_tok |  usd  | cache_tokens_saved 
---------------------+---------------------+--------+---------+-------+--------------------
 2026-06-24 09:07:24 | project-case-study  |  83905 |   13452 | 0.453 |                  0
 2026-06-24 09:08:35 | project-system-tour |  15558 |    3714 | 0.102 |                  0
 2026-06-24 09:10:12 | project-case-study  |  83903 |   15102 | 0.478 |                  0
 2026-06-24 09:11:15 | project-system-tour |  16062 |    3230 | 0.097 |                  0
 2026-06-24 09:11:36 | project-case-study  |  96402 |   15778 | 0.526 |                  0
 2026-06-24 09:12:46 | project-system-tour |  15427 |    3497 | 0.099 |                  0
 2026-07-04 16:17:25 | project-case-study  | 121236 |   18294 | 0.638 |                  0
 2026-07-04 16:18:38 | project-system-tour |  16654 |    4202 | 0.113 |                  0
 2026-07-05 08:08:15 | project-case-study  | 130786 |   17263 | 0.651 |                  0
 2026-07-05 08:09:31 | project-system-tour |  16826 |    4538 | 0.119 |                  0
(10 rows)
<task-notification>
<task-id>a6d0bbaa980ed6535</task-id>
<tool-use-id>toolu_01GWKXrWcXLztwEUx7em5yxf</tool-use-id>
<output-file>/private/tmp/claude-501/-Users-nelsonlamounier-Desktop-portfolio-tucaken-infra/7d2e62dc-43f6-4140-96f8-57f6a99c3a05/tasks/a6d0bbaa980ed6535.output</output-file>
<status>completed</status>
<summary>Agent "Deep-dive project/case-study pipeline" finished</summary>
<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>
<result># PROJECTS feature — factual map (worktree: `/Users/nelsonlamounier/Desktop/portfolio/ai-applications/.worktrees/enrichment-rag-ab`)

All paths below are relative to the worktree root unless absolute. Line numbers verified against the worktree as of today.

---

## 1. Exact LLM input assembly (case-study agent)

**Entry**: `runCaseStudyOrchestration()` (`applications/shared/src/projects/case-study-orchestrator.ts:208`) → `loadCaseStudyContext()` (`applications/shared/src/projects/case-study-loader.ts:308`) → `packContext()` → `bedrockCaseStudyAgent.invoke()` (`applications/shared/src/projects/case-study-agent.ts:553`).

### System prompt (case-study-agent.ts:65-162)
Opens verbatim:
&gt; `You are a portfolio editor writing the case study for a single project. The project may span multiple repositories. Your output is read by recruiters and engineers; treat every claim as something the author may be asked about in an interview.`

Then "Lead with the PRODUCT, then the engineering…", "Synthesise ONE coherent project story…", 9 numbered rules (evidence citation, productContext exemption, tagline/pitch shape, ADR decisions ≤5, challenges ≤5, highlights 3–5, resumeBullets ≤250 chars, honest depthMarkers, Mermaid architecture), a `&lt;verifiedStack&gt;` paragraph, and a closing confident-voice paragraph. Optional appendices via `buildSystemPrompt()` (agent.ts:211-229):
- **Archetype calibration block** (`'Project calibration:'`, `This is a ${stage}-level ${archetype.name} project…`) when `context.archetype` is set.
- **`REFINE_PROMPT_BLOCK`** (agent.ts:172-196, `REFINE MODE — a prior case study … &lt;priorCaseStudy&gt; … &lt;newRepos&gt; coverage guarantee`) when `priorCaseStudy` present.

`CASE_STUDY_PROMPT_VERSION` = sha256(SYSTEM_PROMPT_TEXT + REFINE_PROMPT_BLOCK).slice(0,12) — folded into the cache key (agent.ts:205-209).

### User message blocks, in order (`buildUserMessage`, agent.ts:433-499)
| # | Tag (verbatim) | Content | Loader source | Caps |
|---|---|---|---|---|
| 1 | `&lt;project&gt;` | JSON envelope `{projectName, tagline, pitch, components, repositories, commits, pulls}` | `projects` (id,user_id,name,tagline,pitch,product_description,user_overrides,type,shape — loader.ts:312-315); `project_components` (name+kind, ORDER BY order_index, loader.ts:322-326); repos: `project_repositories→repositories` + `repository_profiles.extracted-&gt;'tech_stack'` (loader.ts:328-352); commits: **`repo_commits`** all rows, `ORDER BY authored_at DESC`, **no SQL LIMIT** (loader.ts:405-419); pulls: **`repo_pull_requests`** all rows, `ORDER BY merged_at DESC NULLS LAST`, **no SQL LIMIT** (loader.ts:423-439) | Bounded only by `packContext` (see below). Ingestion itself caps storage at 500 commits / 100 PRs per repo (`RepoIngestionOrchestrator.ts:156,159`) |
| 2 | `&lt;productContext&gt;` (only if non-empty) | Precedence: `projects.product_description` override verbatim → per-repo `### {fullName}` + GitHub description + head of root README (loader.ts:140-158) | READMEs from `document_embeddings WHERE lower(file_path) IN ('readme.md','readme') ORDER BY chunk_index` (loader.ts:387-395) | `README_CHARS_PER_REPO = 1_400`/repo (loader.ts:111), global `PRODUCT_CONTEXT_CHARS = 4_000` (loader.ts:113) |
| 3 | `&lt;kbChunks&gt;` | JSON array `{repoFullName, filePath, chunkType:'document', content}` | `document_embeddings` scoped to member repos, **`ORDER BY de.last_synced_at DESC LIMIT 24`** (loader.ts:370-381) — pure recency, **no embedding similarity, no fileClass filter, chunk_type hardcoded `'document'`** | `KB_CHUNK_CAP = 24` (loader.ts:103); 2,400 chars/chunk after packing |
| 4 | `&lt;fileChanges&gt;` (if any) | most-changed files `{repoFullName, filePath, additions, deletions, changes}` | `repo_commit_files` GROUP BY file, `ORDER BY sum(additions)+sum(deletions) DESC LIMIT 30` (loader.ts:201-210) | `FILE_CHANGE_CAP = 30` (loader.ts:109) |
| 5 | `&lt;verifiedStack&gt;` (if any) | `{name, version, purl}` per canonical | `technology_evidence JOIN technology_ontology`, `source_layer IN ('syft','treesitter','iac','dockerfile')` (loader.ts:236-257) | `VERIFIED_STACK_CAP = 80`, version-bearing first (loader.ts:107, 252-257) |
| 6 | `&lt;priorCaseStudy&gt;` (refine only) | reconstructed from `projects` + `project_decisions/highlights/challenges/stack_items` **with stored `source_signals`** (`case-study-refine.ts:85-160`) | gated on `projects.case_study_generated_at` not status (refine.ts:94-99) | none |
| 7 | `&lt;newRepos&gt;` (refine + new repos) | repos not cited by any prior row (`underrepresentedRepos`, refine.ts:59-70) | — | — |
| 8 | closing line | `Emit the emit_case_study tool now.` (agent.ts:497) | — | — |

### Token budget (`case-study-context-budget.ts`)
`CONTEXT_TOKEN_BUDGET = 120_000` est. tokens (loader.ts:166), ~4 chars/token heuristic. Per-item truncation: commit message 800 chars, KB chunk 2,400 chars, PR body 1,200 chars (budget.ts:42-44). Then **greedy fill in priority order: commits → kbChunks → pulls** (budget.ts:89-110). Skeleton (project/components/repos + productContext + verifiedStack + fileChanges etc.) is always preserved.

### Field provenance summary
- `projects`: name, tagline, pitch, product_description, type, shape, user_overrides (loaded but **deliberately NOT forwarded** to the prompt — agent.ts:434-436).
- `project_components`: name, kind.
- `repository_profiles.extracted`: only `tech_stack` array (repo metadata) — `classification` is used by **clustering**, not case study.
- `repo_commits`: sha, author_name, author_login, authored_at, message.
- `repo_pull_requests`: number, title, body, state, author_login, merged_at, html_url.
- `repo_commit_files`: churn aggregation → `&lt;fileChanges&gt;`.
- `technology_evidence`: → `&lt;verifiedStack&gt;` (prompt) + persist-time stamping.
- `document_embeddings`: (a) 24 recency chunks, (b) README rows for productContext, (c) `metadata-&gt;&gt;'fileClass'` lane counts for deterministic depth markers (loader.ts:187-193) — **prompt never sees the lane counts; they override the output**.
- `repo_sync_state.archetype_signals`: OR-merged (loader.ts:358-367) → archetype classification (calibration block) + depth markers. Raw signals never enter the prompt.
- **`skills[]` chunk metadata, `tech_skill_map`, `file_tech_stack`: NOT used anywhere in the projects prompt path** (verified by grep — `tech_skill_map` only in `applications/ingestion/*` + `TechSkillMapRepository`; `file_tech_stack` only stamped in `applications/shared/src/projects/stamp-evidence-metadata.ts` for retrieval, never read back by case study).

**Stale-doc flag**: `case-study-types.ts:230-246` comments claim "capped by `MAX_COMMITS` (default 50)" and "`MAX_PULLS_PER_REPO` (default 25)" — **no such caps exist in the loader**; the real bound is packContext + ingestion's 500/100.

---

## 2. Output contract

**Forced Bedrock tool_use**, single tool `emit_case_study` (agent.ts:403-429). Required top-level keys: `tagline` (≤200), `pitch` (≤4000), `stack` (≤40 items), `decisions` (≤5), `highlights` (≤5), `challenges` (≤5), `depthMarkers`, `architecture` (`{diagramFormat: mermaid|svg, diagramSource, nodes[], edges[]}`), `resumeBullets` (1–6 sets, angles: `backend|frontend|infrastructure|fullstack|data_ml|product_leadership`, ≤8 bullets ≤500 chars each). Every stack/decision/highlight/challenge row carries `sourceSignals` `{commits[], pulls[], files[], ungroundedClaims[], grounding}` (types.ts:48-103).

Parsing: `parseJsonResponse` → Zod `CaseStudySchema.safeParse`; on failure two deterministic repairs (`coerceArchitectureString`, `clampOversizedFields` — `case-study-schema-repair.ts`) then re-validate; if still failing, **one bounded model retry** feeding the exact Zod issues back (agent.ts:576-594).

**Persistence** (`case-study-persistence.ts`, one transaction): `projects` (tagline, pitch, case_study_status='complete', case_study_generated_at/pipeline_run_id/model/input_hash, computed_archetype, computed_stage); `project_stack_items` (+ server-side `verifiedTech` stamping via `stampStackSignals`, persistence.ts:362-375); `project_decisions` (preserveUserConfirmed); `project_highlights`; `project_challenges` — all reconciled idempotently by `(project_id, content_hash)` insert-then-prune (persistence.ts:178-248); `project_depth_markers` (upsert, ON CONFLICT project_id); `project_architecture` (upsert, `is_user_edited=FALSE` guard, Mermaid normalised); `project_resume_bullets` (upsert per `(project_id, angle)`). Sticky sections in `projects.user_overrides` are skipped. depthMarkers are **overridden pre-persist** with deterministic values (orchestrator.ts:249-250, `case-study-depth.ts` — fileClass lane counts + archetype signals + refactor-commit regex count).

**System tour**: separate Sonnet call after persist (run-case-study.ts:256-266), input = the case study only, output `project_system_tours` (migration 063). Tool `emit_system_tour`: area, context, keyDecisions (1–6), tradeoffs (≤6), systemMap (must copy architecture verbatim), outcomes (≤6), whatIdChange (≤4, evidenced limitations only).

**UI reads** (tucaken-app, `src/features/projects/components/detail/ProjectDetail.tsx`): one query `projectsQueries.detail(projectId)` rendering Hero, `Pitch` (project.pitch), `Repositories` (repositories + components + case_study_generated_at), `Architecture` (project.architecture), `StackMap` (stack_items), `DepthMarkers` (depth_markers), `Highlights`, `Challenges`, `DecisionLog` (decisions), `ResumeBullets` (resume_bullets), `ShareCaseStudy` (slug, visibility). Plus `public/PublicCaseStudy.tsx`. A UI consumer for `project_system_tours` was **not found in the dirs I can read — unverified**.

---

## 3. Model + token economics

| Agent | Model env (default) | maxTokens | thinkingBudget | Notes |
|---|---|---|---|---|
| case-study | `CASE_STUDY_MODEL` → `eu.anthropic.claude-sonnet-4-6`; `INFERENCE_PROFILE_ARN` wins (agent.ts:45-50; env-case-study.ts:33-34) | **32,768** (agent.ts:58) | 0 (forced tool_use, agent.ts:61) | context budget 120k est. input tokens |
| system-tour | `SYSTEM_TOUR_MODEL` → sonnet-4-6 (system-tour-agent.ts:39-44) | 16,384 | 0 | runs on **every** case-study Job; `runSystemTour` supports a cache but run-case-study.ts:258-265 passes **none** → tour Sonnet call every run |
| clustering | `CLUSTERING_MODEL` → `eu.anthropic.claude-haiku-4-5-20251001-v1:0` (clustering-agent.ts:39-41) | 4,096 | 0 | MAX_PROPOSALS=8; input = repo digests + deterministic signals only |
| overview judge (eval-only) | `CASE_STUDY_MODEL` → sonnet (narrative-grader.ts:161) | 512 | 0 | behind `CASE_STUDY_EVAL_JUDGE=1`, E2E script only |
| change-impact narrator | `CHANGE_IMPACT_MODEL` → sonnet (change-impact-narrator.ts:29) | 512 | 0 | see gaps — no production caller |

Pricing table (`applications/shared/src/metrics.ts:132-146`): sonnet-4-6 $0.003/1k in, $0.015/1k out; haiku-4-5 $0.001/1k in, $0.005/1k out. Cost accumulated per invocation (`agent-runner.ts:479-539`; cents attribution uses a fixed 60/40 input/output split heuristic, lines 537-539). **No Bedrock prompt caching anywhere** (no `cachePoint`/`cache_control` in agent-runner/base-agent — verified by grep).

Caching layers: `RedisExactCache` keyed by `computeInputHash` (orchestrator.ts:133-154) — hash covers prompt version, project id/name/tagline/pitch/productContext, components, repo names+techStack+topics, commit SHAs, PR number/state/mergedAt, archetype/stage/sections. **Not hashed: kbChunks content, fileChangeEvidence, verifiedStack** — a dependency-version change alone never busts the cache. Refine runs **bypass the cache entirely** (orchestrator.ts:70-72,226) and refine is **on by default** (`CASE_STUDY_DISABLE_REFINE !== 'true'`, run-case-study.ts:225) — so after the first completion, every regenerate is a paid Sonnet call.

**Prompt bloat candidates**:
- Commits fill first in the greedy pack: up to 500/repo × 800 chars — on multi-repo projects they can consume most of the 120k budget while **PRs (packed last, despite the prompt calling them "the strongest form of evidence") get dropped entirely**.
- `depthMarkers` are a required output the model must generate but the orchestrator throws away and replaces deterministically — wasted output tokens + schema burden.
- KB chunks: 24×2,400 chars of recency-arbitrary content (see gaps).
- Two Sonnet calls per Job (case study + tour) with the whole case study re-serialised as tour input.

---

## 4. Narrative controls

- **Recruiter framing (verbatim)**: system prompt line 2-3: `Your output is read by recruiters and engineers; treat every claim as something the author may be asked about in an interview.` Also rule 6: `highlights are 3–5 things a recruiter could point to in 5 seconds` and calibration: `Recruiters at this level look hardest at: ${priority}.`
- **Voice**: rule 3 `Written in the candidate's voice ("I built" / "I designed", never "we built")`; closing: `Narrate real, evidenced work plainly and confidently… Avoid hedged phrasing ("claimed", "attempted to", "appears to")`.
- **Grounding**: rule 1 evidence-citation requirement; production grounding is now **deterministic citation-presence** — `groundFromCitations` (orchestrator.ts:169-182): GROUNDED iff any commit/PR/file cited, else NOT_VERIFIED. The previous per-row LLM verifier was removed because it "flagged ~100% as NOT_GROUNDED — noise… burned ~15 Haiku calls per run" (orchestrator.ts:157-168). **Nothing verifies a cited SHA/PR actually exists in the supplied context** (schema regex only).
- **Graders** (eval/CI only, NOT a production gate — only consumer is `scripts/test-projects-case-study.ts` and unit tests):
  - `case-study-product-grader.ts`: `taglineIsProductFirst`, `pitchOpensWithProduct`, `noInfraOpener` (deterministic, TECH_TOKENS set).
  - `case-study-narrative-grader.ts`: `workLeadsNarrative` (every engineering row cites commit/PR), `techNotSpine` (no tech-dominated pitch paragraph opener, no repo-name-led or ≥3-tech roll-call highlight titles), `confidentVoice` (hedge regexes incl. `\bwe built\b`); plus injectable `judgeCombinedOverview` LLM judge (threshold 0.7), prompt: `Score 0..1 on TWO things together: (1) the pitch reads as ONE coherent product story across all repositories… (2) technology is supporting detail, not the spine…`.
  - `case-study-refine-grader.ts` (preservation/coverage checks for refine mode).
- **Invented-metric guardrail**: the case-study prompt has **no explicit "never invent a number" rule** — resume bullets are told to be `quantified where possible`, guarded only by evidence citation. The strict number gate exists only in `change-impact-narrator` (`isGrounded` discards any narration citing a figure absent from the report, narrator.ts:66-71).

---

## 5. Connection to ingestion skills

- **Chunk `skills[]`**: never read by clustering, case study, system tour, or project persistence. Assigned at ingestion by `applications/shared/src/rds/enrichment/assignSkillsToChunks.ts` + `tier1-skill-rules.ts` (Tier-1 deterministic, post-LLM-enrichment retirement); consumed only by retrieval (RdsVectorStore filter-then-rank skills lane, now A/B-parameterised — commit `e6967c1`: recall@8 identical 0.9194 lane-on vs lane-off, the measured basis for retiring per-chunk Haiku enrichment).
- **`tech_skill_map`**: ingestion-only (`run-ingestion.ts:225,304`, `run-reenrich.ts`, evals).
- **`technology_evidence`**: YES — twice in projects (loader `&lt;verifiedStack&gt;` + persist-time `verifiedTech` stamping), and in strategist-side `RdsProjectEvidenceRepository.load()` (repoEvidence union with `dsa_evidence`, project-evidence.ts:30-49).
- **`file_tech_stack`**: stamped onto chunk metadata for retrieval (`stamp-evidence-metadata.ts:58-69`); not read by projects.
- **Net effect of enrichment retirement on projects: none** — the case-study prompt never consumed chunk skills; its KB input is raw chunk `content` only.

---

## 6. Connection to job-strategist (JD pipeline)

Join points, all fail-open:
1. **`RdsProjectEvidenceRepository.load()`** (`applications/shared/src/stage-prep/project-evidence.ts:11-85`): projects (non-archived; archived single-repo defaults excluded to avoid double-count), components, decisions, stack items, tags, highlights, challenges, tech/dsa evidence, repos-per-project.
2. **`formatProjectEvidence()`** (`stage-prep/format-project-evidence.ts:50-84`): renders the block headed verbatim `PROJECT CASE STUDIES — the candidate has N documented project(s) (their own work), listed below.` + `RESUME RULE: represent EACH documented project as EXACTLY ONE résumé project entry…`. Caps: 8 projects, 12 stack, 5 decisions, 5 highlights, 4 challenges per project; ranked by documentedScore (highlights+decisions ×2). Note format-project-evidence.ts:118-119 comment: "case-study regeneration currently accumulates rows, so near-dupes occur" — **stale**: persistence now prunes (insert+prune added later); the dedupe remains as belt-and-braces.
3. **Research agent** (`run-pipeline.ts:612-626` → `research-agent.ts:489-497`): section header verbatim `## Project Case Studies — Documented Portfolio Projects (factual, citeable evidence)` — "Treat as factual evidence ALONGSIDE the KB passages… you may name the project as its source citation." Combined with Profile Intelligence into `candidateGroundingBlock`.
4. **Strategist agent** (`strategist-agent.ts:288-296`): `### Documented Project Case Studies (CITEABLE EVIDENCE)` (`--- BEGIN PROJECT CASE STUDIES ---`). Plus `loadAchievementEvidence` (`agents/achievement-evidence.ts`): raw SQL over `project_challenges/decisions/highlights` (caps 4/4/4, **user-wide, no project scoping/ranking**) → strategist section `### Achievement &amp; Impact Evidence (use for the cover letter: lead with a challenge overcome; …)` (strategist-agent.ts:300-305).
5. **Resume guard** (`resume-guard.ts:788-789`): repair prompt `For project_restates_bullets: rewrite each flagged project description in three beats — (1) open with its documented pitch: ${formatPitches(...)}…`; pitches from `loadProjectLaneIndex` (`project-evidence-block.ts:35-54`, pitch = `p.pitch ?? p.tagline` first 200 chars). Also project-name variants for lane classification (resume-guard.ts:197).
6. **Cover-letter guard** (`cover-letter-guard.ts:221`): `…ownership via the documented projects (${narrative.projectPitches.map(pp =&gt; `${pp.name}: ${pp.pitch.slice(0,120)}`)…})…`.
7. **Free pipeline** (`free/gather-evidence.ts:55,63` → `free-resume-writer.ts:430,435`): `&lt;project_evidence&gt;` and `&lt;achievements_and_impact&gt;` XML tags.
8. **Coach** (`run-coach.ts:302,334,365`): project evidence drives `joinSkillCandidates` (skill-transfer stages), `detectConcernEvidence` (system-design walkthrough), `detectPrincipleEvidence` (bar-raiser). The system tour itself is **not** consumed by the coach (not found).

---

## 7. Trigger / refresh model

- **Clustering** (Haiku, per user): manual only — admin-api `POST /clustering/run` (tucaken-app `admin-api/src/routes/projects.ts:554-621`; Pro-gated; inserts `pipeline_runs` type='clustering', creates K8s Job `node dist/run-clustering.js`). Proposals surface via `GET /clustering/proposals` → review UI (`ProjectReviewStep.tsx`). Cache: RedisExactCache scope `clustering:{userId}`, kbTag=environment, exact input hash.
- **Case study** (Sonnet, per project): `case_study_status='pending'` is set by three writers — (a) `POST /:id/confirm` (project confirmation, routes/projects.ts:339-350), (b) `POST /:id/regenerate` manual CTA (routes/projects.ts:634-663; UI Regenerate button in `Hero.tsx`/`ProjectCard.tsx`), (c) **post-sync intent** in ingestion: `applyPostSyncProjectAction` (`applications/ingestion/src/util/applyPostSyncProjectAction.ts`) — Add-repo-time 'build' (confirm + queue) or 'link' (move repo into target project + queue target). A **reconciler loop** in admin-api (`case-study-reconciler.ts`, `TICK_MS=30_000`, 120-second debounce + non-terminal-run guard, LIMIT 20) dispatches the K8s Job for confirmed pending projects.
- Within a Job (`run-case-study.ts`): feature-flag `projects.case_study.enabled` → best-effort component refresh from grounded role signals (`recomputeConfirmedProjectComponents`) → refine-by-default (prior exists ⇒ REFINE mode; refine **bypasses semantic cache**; new-repo refine scopes commits/PRs/KB to the new repos only, `scopeEvidenceToRepos`, orchestrator.ts:329-334) → generate → deterministic grounding → persist → cache write (full runs only) → system tour (fail-open) → optional article-topic discovery (`ARTICLE_TOPIC_DISCOVERY=1`, derives candidates from challenges+decisions, `article-topic-discovery.ts`).
- **No automatic regeneration on ordinary re-sync** — only the explicit post-sync 'build'/'link' intent or user CTA flips status to pending. (No other `case_study_status='pending'` writer found.)

---

## 8. Gaps / observations

1. **KB chunk selection is recency-arbitrary**: `ORDER BY last_synced_at DESC LIMIT 24` — no similarity, no fileClass/doc preference, and since `last_synced_at` is per-sync-batch the intra-repo order is effectively unspecified; the 24 slots can be filled by config/source chunks of whichever repo synced last, and can duplicate README content already in `&lt;productContext&gt;`. The retrieval-quality machinery (kb_quality scores, filter-then-rank prefilter, multi-query retrieval) used by the strategist is **not** used here.
2. **PRs packed last** in the token budget (commits → KB → pulls) while the prompt declares PRs "the strongest form of evidence" — on large multi-repo projects PR evidence is the first thing silently dropped. PR **review comments** are not ingested at all (only PR metadata: title/body/state/urls).
3. **Model-generated `depthMarkers` are discarded** (deterministic override at orchestrator.ts:249-250) yet remain a required tool-schema field — wasted output tokens and schema complexity; same for the risk that `architecture.nodes/edges` duplicates `diagramSource`.
4. **Cache-key blind spots**: `computeInputHash` omits kbChunks content, fileChangeEvidence, verifiedStack — dependency/version or README-chunk changes alone can serve a stale cached study. Conversely, the agent's own tagline/pitch output is written back to `projects` and is hashed as input next run — self-referential hash churn.
5. **`change-impact-narrator` / `change-impact-service` are dead code in this repo**: exported from `projects/index.ts:189-190` but no production caller (grep-verified). File header says "A route, chatbot tool, or coach can call this" — none does. (Possible external consumer in tucaken-app not visible from my access — unverified.)
6. **Graders are eval-only**: product/narrative graders and the overview judge never run in the production Job — a regression in pitch framing ships unchecked; the only production gates are the JSON schema, the citation-presence grounding, and deterministic depth/stack stamping.
7. **No verification that cited evidence is real**: citation-presence == GROUNDED; a fabricated-but-well-formed SHA would pass (regex `^[0-9a-f]{7,40}$` only). The prior LLM verifier was removed; the "hallucination safety net is being redesigned separately" (orchestrator.ts:166-167).
8. **Achievement-evidence loader is unranked and user-global** (`achievement-evidence.ts:33-41`): `ORDER BY order_index LIMIT 4` across ALL projects mixes rows from different projects arbitrarily (order_index is per project) — the cover-letter evidence may come from the least relevant project.
9. **Data available but never fed to the case-study prompt**: `evidence_topology` (repository_profiles — used by strategist ATS `repo-profile.ts`, not projects), raw `archetype_signals`, `repository_profiles.extracted` fields beyond tech_stack (classification/quality_score), `dsa_evidence`, `repo_sync_state` recency stats, chunk `skills[]`, `kb_quality`, per-file `file_tech_stack`.
10. **Stale comments**: `case-study-types.ts:230-246` (MAX_COMMITS 50 / MAX_PULLS_PER_REPO 25 — nonexistent), `format-project-evidence.ts:118-119` ("regeneration currently accumulates rows" — persistence now prunes), types.ts:82-88 still describes `BedrockGroundingVerifier (mode='flag')` which no longer runs; docs `case-study-generation.md` still shows a "grounding verifier" stage and "grade the subjective dimension" wording.
11. **System tour cost**: regenerated on every case-study Job (cache parameter exists but is not wired in run-case-study.ts) even when the case study came from the semantic cache — a cache-hit run still pays a full Sonnet tour call. (Tour skip-on-identical-hash exists only if a cache were passed.)
12. **Duplicate SQL**: verified-stack map is loaded twice per run (loader for the prompt, persistence for stamping) with near-identical queries (loader.ts:236-243 vs persistence.ts:51-61).
13. **Inconsistent caps across surfaces**: prompt stack ≤40 vs strategist block shows ≤12/project; decisions ≤5 everywhere but achievement-evidence caps at 4; resume bullets ≤8×500 chars generated vs prompt rule says "never longer than 250 characters" (schema allows 500 — rule/schema mismatch).</result>
<usage><subagent_tokens>186144</subagent_tokens><tool_uses>62</tool_uses><duration_ms>618573</duration_ms></usage>
</task-notification>
Update Todos

Dispatch code deep-dive: case-study pipeline (inputs, prompt, schema, cost, consumers)

Pull live frontend-portfolio project data + generation costs from DB

Synthesise the full project-design review (all 13 questions)
Write project-case-study-design-review.md
19 lines
---
name: project-case-study-design-review
description: 2026-07-07 review of the Projects/case-study pipeline — cost profile (103K-token prompts, no caching), data sourcing gaps (recency chunks, PRs dropped last), improvement list; frontend-portfolio baseline for the A/B regenerate
metadata:
  type: project
---

**Projects/case-study design review (2026-07-07), code + live data:**

- **Live baseline (frontend-portfolio project 7ca4da40, for the A/B regenerate):** case study complete Jul 5, Sonnet 4.6; pitch 2,290 chars (strong, product-first), 5/5/5 challenges/decisions/highlights, archetype production_saas. Generation cost: 5 case-study calls totalling 516K in / 80K out / $2.75 (input GREW 84K→131K per call across regenerates; `cache_tokens_saved: 0` on every row) + system-tour $0.53. `product_description` empty (never populated).
- **Prompt assembly** (case-study-agent buildUserMessage): `<project>` envelope (commits from repo_commits NO SQL limit, PRs no limit; ingestion caps 500/100 per repo) → `<productContext>` (README 1,400 chars/repo, 4K global) → `<kbChunks>` (**24 chunks by last_synced_at DESC — pure recency, no similarity/fileClass**) → `<fileChanges>` (top-30 churn) → `<verifiedStack>` (technology_evidence, cap 80). Token budget 120K est., greedy pack **commits → kbChunks → pulls** — PRs ("strongest evidence" per the prompt) dropped FIRST under pressure.
- **Output**: forced tool emit_case_study + Zod + 2 deterministic repairs + 1 bounded retry (robust). Sections: tagline/pitch/stack/decisions≤5/highlights≤5/challenges≤5/depthMarkers/architecture(mermaid+nodes/edges)/resumeBullets(6 angles×8×500chars). **depthMarkers are generated then discarded** (deterministic override). 250-char rule vs 500-char schema mismatch on bullets.
- **Key gaps**: no Bedrock prompt caching anywhere; refine mode (default after first run) bypasses the semantic cache → every regenerate full-price; system tour re-paid every run (cache param exists, not wired); cache key omits kbChunks/fileChanges/verifiedStack; graders (product/narrative/overview-judge) are eval-only, never a production gate; grounding = citation-PRESENCE only (fabricated SHA passes regex); achievement-evidence loader unranked user-global (cover-letter risk); change-impact-narrator dead code; PR review comments not ingested; stale comments (MAX_COMMITS 50 nonexistent).
- **Ingestion-skills connection: chunk skills[]/tier1/file_tech_stack NEVER used by projects** — enrichment retirement changed nothing here. Real connections: technology_evidence (verifiedStack + stamping), archetype_signals (calibration + depth), fileClass lane counts (deterministic depth markers), README/raw chunks.
- **JD join points (8)**: RdsProjectEvidenceRepository → formatProjectEvidence (8 projects/12 stack/5/5/4 caps) → research candidateGroundingBlock + strategist CITEABLE EVIDENCE block + achievement-evidence (cover letter) + resume-guard pitches + cover-letter-guard + free pipeline + coach (skills/system-design/bar-raiser). System tour consumed by no downstream (UI consumer unverified).
- **Improvement priorities**: P1 cost — reorder pack (PRs first), cap commits (~150), similarity/doc-lane chunk selection, drop depthMarkers from schema, wire tour cache/skip, trim resumeBullets angles (est. $0.65 → ~$0.25/regenerate); P2 quality — deterministic citation-existence check (set lookup vs supplied evidence), promote deterministic graders to production gate, rank achievement-evidence; P3 hygiene — cache-key completeness, stale docs, 250/500 mismatch, dup SQL.

Related: [[jd-pipeline-design-review]], [[chunk-enrichment-value-review]].
Edit MEMORY.md
Added 1 line
Projects design review — answering all thirteen questions, grounded in the live frontend-portfolio project
TL;DR: the output quality and the output contract are genuinely good — the recruiter framing, evidence-citation design, and JSON robustness are above industry norm. The problems are on the input side (what feeds the LLM and in what order) and the cost side (103K-token prompts, zero caching, growing every regenerate). Your live project cost $2.75 across 5 generations and each regenerate is getting more expensive (84K → 131K input tokens), which is exactly backwards.

Q: What ingested data is passed to the LLM to create the project?
In prompt order, for the case-study call (Sonnet 4.6, forced emit_case_study tool, 120K-token budget):

Block	Source	Cap
<project> envelope	projects (name/tagline/pitch), project_components, repo list + repository_profiles.extracted->tech_stack, all repo_commits (newest first), all repo_pull_requests	only the ingestion-time 500 commits/100 PRs per repo, then the token packer
<productContext>	product_description override → else GitHub description + README head	1,400 chars/repo, 4K total
<kbChunks>	document_embeddings — 24 chunks by last_synced_at DESC	pure recency; no similarity, no docs-lane preference
<fileChanges>	repo_commit_files churn top-30	30
<verifiedStack>	technology_evidence (syft/treesitter/iac/dockerfile layers)	80
(refine runs) <priorCaseStudy> + <newRepos>	prior persisted rows	none
Token packing is greedy: commits → kbChunks → pulls. Note what that means: PRs — which the prompt itself calls the strongest form of evidence — are the first thing silently dropped when a project is commit-heavy.

Q: Is it taking full advantage of the ingested data (no enrichment)?
Enrichment first, because it resolves your connection question cleanly: chunk skills[], the tier-1 map, and file_tech_stack are never read by the projects pipeline — the retirement changed nothing here. The real ingestion→projects connections are technology_evidence (the verified stack, used twice), archetype_signals (calibrates the prompt: "This is a {stage}-level {archetype} project"), fileClass lane counts (deterministic depth markers), and raw README/chunk content.

Beyond that — no, meaningful data goes unused: evidence_topology, repository_profiles classification/quality fields, dsa_evidence, and most importantly your docs corpus — the 24-chunk window is recency-arbitrary, so whether your new docs/concepts files (prime case-study material!) make it in depends on sync timing, not relevance. PR review comments aren't ingested at all — for a recruiter narrative, that's the collaboration-evidence lane missing entirely.

Q: Cost-optimised? Can I cut the LLM response?
No, and this is the biggest win available. Evidence from your own ledger: cache_tokens_saved: 0 on all 10 invocations — no prompt caching anywhere; refine mode (the default after first generation) bypasses the semantic cache, so every regenerate is a full-price call; the input grows each regenerate (the prior case study gets appended, commits accumulate); and the system-tour Sonnet call is re-paid on every run — the code has a cache parameter for it that's simply never passed. On the output side: depthMarkers are a required schema field the model must generate and the orchestrator then throws away (deterministic override), architecture.nodes/edges duplicates diagramSource, and resumeBullets (6 angles × 8 bullets × 500 chars) is the bulk of your 16–18K output tokens — generating only the angles matching your target roles would halve output cost. Realistic post-fix regenerate: ~$0.20–0.25 instead of $0.65 and climbing.

Q: Is the LLM response well-formatted (JSON)?
Yes — this is the strongest part of the design. Forced tool_use → Zod validation → two deterministic repairs → one bounded model retry that feeds the exact Zod errors back. That's textbook. One inconsistency to fix: the prompt says bullets "never longer than 250 characters" while the schema allows 500.

Q: Right data for a recruiter-facing description? Narrative well-established?
The framing is excellent and explicitly recruiter-first — quoted from the system prompt: "Your output is read by recruiters and engineers; treat every claim as something the author may be asked about in an interview", highlights must be "things a recruiter could point to in 5 seconds", candidate voice enforced ("I built", never "we built"), product-before-engineering rules. And your live artefact proves it lands: the pitch opens with the product and a differentiator, highlights carry verified numbers (LCP 132 ms).

Two honest weaknesses: the narrative graders never run in production — product-first/confident-voice/coherence checks exist but only in eval scripts, so a framing regression ships ungated; and grounding is citation-presence only — a well-formed but fabricated commit SHA passes a regex, nothing checks it exists in the supplied evidence (the old LLM verifier was removed for noise; a deterministic set-lookup against the supplied commits/PRs would be nearly free). Also: your product_description field is empty — filling it in the UI gives the model an authoritative product statement instead of inferring one from the README.

Q: Does the JD/job-strategist flow get what it needs from projects?
Mostly yes — projects flow into the JD pipeline at eight join points (research grounding block, strategist "CITEABLE EVIDENCE" section, achievement evidence for cover letters, resume-guard pitches, cover-letter guard, free tier, and two coach stages). Two gaps: the achievement-evidence loader is unranked and user-global (ORDER BY order_index LIMIT 4 across all projects — your cover letter can lead with a challenge from the least relevant project), and the system tour is consumed by nothing downstream I could verify — if the UI doesn't render it either, that's a pure-cost artefact.

Q: Industry standard?
Split verdict, same shape as the JD review: the output contract (schema-forced, repair-retried), the provenance design (sourceSignals per row — most portfolio generators have nothing like it), and the idempotent content-hash persistence are at-or-above standard. Below standard: no prompt caching on a 100K+ static-heavy prompt, relevance-blind context selection (recency instead of similarity — the strategist side of your own codebase does this properly), and quality gates that exist but don't gate.

The improvement plan (what I'd change before your A/B regenerate)
P1 — cost & sourcing (changes the input, so the A/B measures it):

Reorder the token packer: PRs → docs-lane chunks → commits, and cap commits sensibly (~150 newest; 500×800 chars of commit messages is the current bloat king).
Replace the 24-recency chunks with docs-lane-preferred, similarity-selected chunks (query = the project pitch/tagline; the retrieval machinery already exists).
Drop depthMarkers from the tool schema (it's discarded), and generate resumeBullets only for angles relevant to the project archetype.
Wire the existing system-tour cache and skip the tour on case-study cache hits.
P2 — quality gates: deterministic citation-existence check (cited SHAs/PR numbers must exist in the supplied evidence — a set lookup); promote the deterministic graders (product-first, confident-voice) to a production gate with one retry; rank achievement-evidence by the target project.

P3 — hygiene: add kbChunks/fileChanges/verifiedStack to the cache key; fix the 250/500 bullet mismatch; delete or wire change-impact-narrator; correct the stale MAX_COMMITS comments.

Your A/B is well-set-up: the Jul 5 baseline is locked ($0.65, 130.8K input tokens, the current pitch/highlights), and your fresh docs sync means the new generation will have your concepts docs available — with P1 applied, they'd enter by relevance rather than luck.

Want me to implement P1 (the cost/sourcing changes) in the worktree now so your regenerate measures them — or would you rather start by iterating section-by-section ("Pitch", "Repositories", "Architecture") on the prompt rules first?

create a local .md files with the full report from your response so I can better refer to
Bash Check existing reviews directory convention
IN
ls /Users/nelsonlamounier/Desktop/portfolio/ai-applications/docs/reviews/ 2>/dev/null && head -12 /Users/nelsonlamounier/Desktop/portfolio/ai-applications/docs/reviews/*.md 2>/dev/null | head -14

OUT
bedrock-article-pipeline-pre-k8s-architecture.md
cross-account-observability-plan.md
dataset-model-system-design-review.md
ingestion-pipeline-implementation-review.md
ingestion-strategist-design-review.md
rag-shared-safety-design-review.md
rag-subproject2-app-wiring-design-review.md
rag-subproject3-semantic-cache-design-review.md
strategist-pipeline-pre-k8s-architecture.md
==> /Users/nelsonlamounier/Desktop/portfolio/ai-applications/docs/reviews/bedrock-article-pipeline-pre-k8s-architecture.md <==
# Bedrock article pipeline — pre-K8s architecture (historical)

> **Status:** Historical — describes the **Lambda + Step Functions +
> DynamoDB** architecture that ran the article-generation workflow
> before the move to K8s Jobs. **The current system is documented in
> [docs/projects/article-pipeline.md](../projects/article-pipeline.md)**;
> that README explicitly notes "Replaces the previous Trigger /
> Research / Writer / QA Lambda chain orchestrated by Step Functions."
>
> Kept here because the **CDK stack composition** the article pipeline
> once used (BedrockDataStack / BedrockAgentStack / BedrockApiStack /
> BedrockKbStack — the BedrockProjectFactory 4-stack family) still
Write project-case-study-design-review.md
187 lines
# Projects / case-study pipeline — design review (2026-07-07)

> **Status:** Actionable review. Grounded in the code as of develop
> (post enrichment-retirement, post #423) and in the live dev database
> — the `frontend-portfolio` project (id `7ca4da40-b895-4c6b-a211-40702b3ad19c`)
> serves as the measured baseline for the planned A/B regenerate.
>
> **TL;DR:** output quality and the output contract are genuinely good —
> the recruiter framing, per-row evidence citation (`sourceSignals`) and
> JSON robustness are above industry norm. The problems are on the
> **input side** (what feeds the LLM and in what order) and the **cost
> side** (103K-token prompts, zero caching, growing on every
> regenerate). The live project cost $2.75 across 5 generations and
> each regenerate got MORE expensive (84K → 131K input tokens).

---

## 1. Live baseline (frozen for the A/B regenerate)

| Dimension | Value |
|---|---|
| Project | `frontend-portfolio`, side_project / single_repo, archetype `production_saas` |
| Case study | complete, generated 2026-07-05 08:08, `eu.anthropic.claude-sonnet-4-6` |
| Narrative artefacts | pitch 2,290 chars (product-first, strong differentiator close), 5 challenges / 5 decisions / 5 highlights / 1 component; highlights carry verified numbers (LCP 132 ms) |
| `product_description` | **empty** — the authoritative product-statement override has never been populated |
| Generation cost | `project-case-study`: 5 calls, 516K input / 80K output tokens, **$2.75**; `project-system-tour`: 5 calls, $0.53 |
| Cost trend | input tokens per call: 84K → 84K → 96K → 121K → **131K** (refine mode appends the prior study; commits accumulate) |
| Prompt caching | `cache_tokens_saved: 0` on all 10 invocations — no caching of any kind fired |

---

## 2. What data is passed to the LLM (prompt assembly, in order)

Case-study call: Sonnet 4.6, forced `emit_case_study` tool, maxTokens
32,768, thinking 0, context budget ~120K est. tokens
(`case-study-agent.ts` / `case-study-loader.ts` /
`case-study-context-budget.ts`).

| # | Prompt block | Source | Cap |
|---|---|---|---|
| 1 | `<project>` envelope (name, tagline, pitch, components, repositories, commits, pulls) | `projects`, `project_components`, `project_repositories` → `repositories` + `repository_profiles.extracted->tech_stack`, **all `repo_commits`** (newest first, no SQL limit), **all `repo_pull_requests`** | ingestion stores ≤500 commits / ≤100 PRs per repo; then the token packer |
| 2 | `<productContext>` | `projects.product_description` override → else GitHub description + head of root README (from `document_embeddings` README rows) | 1,400 chars/repo, 4,000 global |
| 3 | `<kbChunks>` | `document_embeddings` — **24 chunks by `last_synced_at DESC`** | pure recency; no similarity, no fileClass/docs preference; 2,400 chars/chunk |
| 4 | `<fileChanges>` | `repo_commit_files` churn, top 30 files | 30 |
| 5 | `<verifiedStack>` | `technology_evidence` JOIN `technology_ontology` (syft/treesitter/iac/dockerfile layers) | 80, version-bearing first |
| 6–7 | `<priorCaseStudy>` + `<newRepos>` (refine runs only) | prior persisted rows incl. stored `source_signals` | none |

Token packing is greedy in the order **commits → kbChunks → pulls**
(commit messages truncated at 800 chars, chunks 2,400, PR bodies
1,200). Consequence: **PRs — which the system prompt itself calls the
strongest form of evidence — are the first thing silently dropped** on
commit-heavy projects.

The system prompt opens (verbatim): *“You are a portfolio editor
writing the case study for a single project… Your output is read by
recruiters and engineers; treat every claim as something the author may
be asked about in an interview.”* Optional appendices: archetype
calibration (“This is a {stage}-level {archetype} project…”) and the
REFINE block.

---

## 3. Answers to the review questions

### Is the pipeline taking full advantage of the ingested data (post-enrichment)?

**Enrichment: chunk `skills[]`, the Tier-1 map and `file_tech_stack`
are never read by the projects pipeline — the enrichment retirement
changed nothing here.** The real ingestion→projects connections are:
`technology_evidence` (verified stack, used in the prompt AND for
persist-time stamping), `archetype_signals` (prompt calibration +
deterministic depth markers), fileClass lane counts (depth markers),
and raw README/chunk content.

Beyond that, **meaningful data goes unused**: `evidence_topology`,
`repository_profiles` classification/quality fields, `dsa_evidence`,
and — most importantly — the docs corpus: the 24-chunk window is
recency-arbitrary, so whether `docs/concepts/*` files (prime
case-study material) enter the prompt depends on sync timing, not
relevance. **PR review comments are not ingested at all** — the
collaboration-evidence lane is missing for a recruiter narrative.

### Is the design cost-optimised?

**No — this is the biggest available win.**

- No Bedrock prompt caching anywhere (`cache_tokens_saved: 0` across the board).
- Refine mode (default after the first generation) **bypasses the semantic cache** — every regenerate is a full-price Sonnet call.
- Input grows per regenerate (prior study appended; commits accumulate).
- The system-tour Sonnet call is re-paid on every run — `runSystemTour` supports a cache, but `run-case-study.ts` never passes one; a case-study cache HIT still pays a full tour call.
- The semantic-cache key omits `kbChunks` content, `fileChanges` and `verifiedStack` — stale-serve risk one way, and the agent’s own tagline/pitch output feeds back into next run’s hash the other way.
- `verifiedStack` is loaded twice per run with near-identical SQL (loader + persistence).

### Can the LLM response be cut?

Yes, meaningfully:

- **`depthMarkers`** is a required schema field the model must generate — and the orchestrator **discards it** (deterministic override from fileClass lanes + archetype signals). Remove from the schema.
- **`architecture.nodes/edges` duplicates `diagramSource`** — keep one.
- **`resumeBullets`** (up to 6 angles × 8 bullets × 500 chars) dominates the ~16–18K output tokens. Generate only angles relevant to the project archetype / user target roles, or on demand.
- Rule/schema mismatch: prompt says bullets ≤250 chars, schema allows 500.

Realistic post-fix regenerate: **~$0.20–0.25 instead of $0.65 and climbing.**

### Is the LLM response well-formatted (JSON)?

**Yes — the strongest part of the design.** Forced tool_use → Zod
validation → two deterministic repairs (`coerceArchitectureString`,
`clampOversizedFields`) → one bounded model retry that feeds the exact
Zod issues back. Persistence is transactional and idempotent
(`(project_id, content_hash)` insert-then-prune; user-confirmed rows
and `user_overrides` sticky sections preserved).

### Right data for a recruiter-facing description? Narrative well-established?

The framing is explicitly recruiter-first and it demonstrably lands
(see baseline pitch/highlights). Voice rules enforce candidate voice
and confident phrasing; highlights must be “things a recruiter could
point to in 5 seconds”.

Two weaknesses:

1. **The narrative graders never run in production.** `taglineIsProductFirst`, `pitchOpensWithProduct`, `workLeadsNarrative`, `confidentVoice` and the combined-overview LLM judge exist — but only in eval scripts. A framing regression ships ungated.
2. **Grounding is citation-presence only.** A row is GROUNDED iff it cites any commit/PR/file; nothing verifies a cited SHA/PR exists in the supplied evidence (regex only). The old per-row LLM verifier was removed for noise (~15 Haiku calls/run, ~100% false NOT_GROUNDED); a deterministic set-lookup against the supplied context would be nearly free.

Also: populate `product_description` — it takes precedence over
README-derived product context and is currently empty.

### Does the JD / job-strategist flow get what it needs from projects?

Projects feed the JD pipeline at **eight join points**: research-agent
grounding block (“Project Case Studies — Documented Portfolio
Projects”), strategist “CITEABLE EVIDENCE” block, achievement evidence
(cover letter), resume-guard pitches, cover-letter guard, free-tier
writer, and two coach stages (system-design walkthrough, bar-raiser).

Gaps: the **achievement-evidence loader is unranked and user-global**
(`ORDER BY order_index LIMIT 4` across ALL projects — the cover letter
can lead with a challenge from the least relevant project), and the
**system tour has no verified downstream consumer** (not the coach; UI
consumer unconfirmed) — potentially pure cost.

### Industry standard?

Above standard: schema-forced output with repair-retry; per-row
`sourceSignals` provenance; idempotent reconciling persistence; refine
mode with coverage guarantees. Below standard: no prompt caching on a
100K+ prompt; relevance-blind (recency) context selection — the
strategist side of the same codebase does similarity + rerank properly;
quality gates that exist but do not gate.

---

## 4. Improvement plan

### P1 — cost & sourcing (do BEFORE the A/B regenerate so it measures them)

1. **Reorder the token packer: PRs → docs-lane chunks → commits**, and cap commits (~150 newest). Commit messages are the current bloat king (up to 500 × 800 chars/repo).
2. **Replace 24-recency chunks with docs-lane-preferred, similarity-selected chunks** (query = project pitch/tagline; retrieval machinery already exists in shared).
3. **Drop `depthMarkers` from the tool schema** (discarded anyway); trim `resumeBullets` to archetype-relevant angles.
4. **Wire the existing system-tour cache** and skip the tour on case-study cache hits.

### P2 — quality gates

5. **Deterministic citation-existence check**: cited SHAs / PR numbers / file paths must exist in the supplied evidence (set lookup). Fail → downgrade grounding, optionally one retry.
6. **Promote the deterministic graders** (product-first, confident-voice, work-leads-narrative) to a production gate with one bounded retry.
7. **Rank achievement-evidence** by target project relevance instead of unscoped `order_index`.

### P3 — hygiene

8. Add `kbChunks`/`fileChanges`/`verifiedStack` to the semantic-cache key; stop hashing the agent’s own prior tagline/pitch output as input.
9. Fix the 250/500 bullet-length rule/schema mismatch.
10. Delete or wire `change-impact-narrator` (currently dead code with no production caller).
11. Correct stale comments/docs: `MAX_COMMITS 50` / `MAX_PULLS_PER_REPO 25` (nonexistent caps), “regeneration accumulates rows” (persistence now prunes), grounding-verifier references in `case-study-generation.md`.
12. Deduplicate the verified-stack SQL (loader vs persistence).

---

## 5. A/B protocol for frontend-portfolio

Baseline (above) is frozen. Apply P1, regenerate via the UI CTA, then compare:

- **Cost**: `prompt_invocations` for the project — input/output tokens + USD vs $0.65/131K.
- **Sourcing**: whether the new `docs/concepts` content enters `<kbChunks>` by relevance (P1.2) rather than sync-timing luck.
- **Content**: pitch/highlights/decisions diff — expect equal-or-better narrative with PR evidence visibly cited in `sourceSignals`.
- **Regression guard**: the deterministic graders (P2.6) green on the new artefact.
Report saved: docs/reviews/project-case-study-design-review.md in the ai-applications repo, following your existing docs/reviews/ convention (alongside ingestion-strategist-design-review.md and friends).

It contains the complete review in reference form:

The frozen live baseline for your A/B — the frontend-portfolio project's artefacts, the $2.75 / 516K-token cost record, and the growing-input trend with cache_tokens_saved: 0 receipts
The exact prompt-assembly table — every block, its source table, and its cap, plus the commits→chunks→pulls packing order problem
All the review questions answered — enrichment connection (none, by design), cost verdict, output-contract assessment, recruiter-framing quotes, the eight JD join points, industry-standard comparison
The prioritised improvement plan — P1 cost/sourcing (do before regenerating), P2 quality gates, P3 hygiene — twelve items total
The A/B protocol — exactly what to compare after you regenerate
The file is untracked in your main checkout (currently on fix/audit-linkify-it-cve), so it's yours to commit wherever it fits — and once committed and synced, it becomes KB content itself. Note there's also a compact version in my persistent memory, so future sessions can pick this up without re-deriving it.

Ready to start on P1 in a worktree whenever you give the word.