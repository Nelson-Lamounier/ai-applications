# Repository Structure

> Generated snapshot. Regenerate from repo root:
> `tree -I 'node_modules|.git|__pycache__|.venv|venv|dist|build|.next|.turbo|cdk.out' --dirsfirst > docs/repo-structure.md`
> (then wrap in `# Repository Structure` heading + fenced code block).

```text
.
├── api
│   ├── public-api
│   │   ├── __tests__
│   │   │   ├── lib
│   │   │   │   ├── config.test.ts
│   │   │   │   ├── githubAppSecrets.test.ts
│   │   │   │   └── oauth.test.ts
│   │   │   └── routes
│   │   │       ├── chatbot.test.ts
│   │   │       ├── github-webhook.test.ts
│   │   │       ├── health.test.ts
│   │   │       ├── projects.test.ts
│   │   │       └── resumes.test.ts
│   │   ├── src
│   │   │   ├── lib
│   │   │   │   ├── cache.ts
│   │   │   │   ├── config.ts
│   │   │   │   ├── githubAppSecrets.ts
│   │   │   │   ├── metrics.ts
│   │   │   │   ├── oauth.ts
│   │   │   │   └── pg.ts
│   │   │   ├── middleware
│   │   │   │   └── cors.ts
│   │   │   ├── routes
│   │   │   │   ├── articles.ts
│   │   │   │   ├── chatbot.ts
│   │   │   │   ├── github-webhook.ts
│   │   │   │   ├── health.ts
│   │   │   │   ├── metrics.ts
│   │   │   │   ├── projects.ts
│   │   │   │   ├── resumes.ts
│   │   │   │   └── tags.ts
│   │   │   ├── index.ts
│   │   │   └── lambda.ts
│   │   ├── Dockerfile
│   │   ├── jest.config.js
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── package.json
├── applications
│   ├── article-pipeline
│   │   ├── src
│   │   │   ├── __tests__
│   │   │   │   └── run-pipeline.test.ts
│   │   │   ├── agents
│   │   │   │   ├── __tests__
│   │   │   │   │   └── research-agent-retrieval.test.ts
│   │   │   │   ├── qa-agent.test.ts
│   │   │   │   ├── qa-agent.ts
│   │   │   │   ├── qa-legacy-bridge.ts
│   │   │   │   ├── research-agent-validation.test.ts
│   │   │   │   ├── research-agent.ts
│   │   │   │   ├── writer-agent-validation.test.ts
│   │   │   │   └── writer-agent.ts
│   │   │   ├── lib
│   │   │   │   ├── pg.ts
│   │   │   │   └── pipeline-runs.ts
│   │   │   ├── prompts
│   │   │   │   ├── blog-persona.ts
│   │   │   │   ├── qa-persona.ts
│   │   │   │   └── research-persona.ts
│   │   │   ├── env.ts
│   │   │   └── run-pipeline.ts
│   │   ├── Dockerfile
│   │   ├── jest.config.js
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsconfig.tsbuildinfo
│   ├── chatbot
│   │   ├── src
│   │   │   ├── agents
│   │   │   │   └── chatbot-agent.ts
│   │   │   ├── security
│   │   │   │   ├── input-sanitiser.ts
│   │   │   │   └── output-sanitiser.ts
│   │   │   ├── handler.test.ts
│   │   │   ├── index.ts
│   │   │   └── types.ts
│   │   ├── jest.config.js
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsconfig.tsbuildinfo
│   ├── chatbot-authenticated
│   │   ├── src
│   │   │   ├── __tests__
│   │   │   │   ├── handler.test.ts
│   │   │   │   └── session.test.ts
│   │   │   ├── env.ts
│   │   │   ├── index.ts
│   │   │   ├── invoke-claude.ts
│   │   │   ├── retrieval.ts
│   │   │   ├── session.ts
│   │   │   └── types.ts
│   │   ├── jest.config.js
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsconfig.tsbuildinfo
│   ├── chatbot-public
│   │   ├── src
│   │   │   ├── __tests__
│   │   │   │   ├── handler.test.ts
│   │   │   │   └── retrieval.test.ts
│   │   │   ├── env.ts
│   │   │   ├── index.ts
│   │   │   ├── invoke-claude.ts
│   │   │   ├── retrieval.ts
│   │   │   └── types.ts
│   │   ├── jest.config.js
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsconfig.tsbuildinfo
│   ├── ingestion
│   │   ├── src
│   │   │   ├── agents
│   │   │   │   ├── __tests__
│   │   │   │   │   ├── DiagnosticNarrator.test.ts
│   │   │   │   │   ├── DirectionSynthesizer.test.ts
│   │   │   │   │   ├── MirrorRevealSynthesizer.test.ts
│   │   │   │   │   ├── ProfileExtractor.test.ts
│   │   │   │   │   ├── ProfileInputCollector.test.ts
│   │   │   │   │   ├── ReconciliationSynthesizer.test.ts
│   │   │   │   │   └── RetrievalProbe.test.ts
│   │   │   │   ├── DiagnosticNarrator.ts
│   │   │   │   ├── DirectionSynthesizer.ts
│   │   │   │   ├── MirrorRevealSynthesizer.ts
│   │   │   │   ├── ProfileExtractor.ts
│   │   │   │   ├── ProfileInputCollector.ts
│   │   │   │   ├── ReconciliationSynthesizer.ts
│   │   │   │   └── RetrievalProbe.ts
│   │   │   ├── repositories
│   │   │   │   ├── RepositoryProfileEmbeddingsRepository.ts
│   │   │   │   └── RepositoryProfileRepository.ts
│   │   │   ├── util
│   │   │   │   ├── __tests__
│   │   │   │   │   ├── classifyRepo.test.ts
│   │   │   │   │   ├── FileFetchCache.test.ts
│   │   │   │   │   ├── refreshUserProfileRollup.test.ts
│   │   │   │   │   └── scoreProfile.test.ts
│   │   │   │   ├── classifyRepo.ts
│   │   │   │   ├── FileFetchCache.ts
│   │   │   │   ├── refreshUserProfileRollup.ts
│   │   │   │   └── scoreProfile.ts
│   │   │   ├── env.ts
│   │   │   ├── metrics.ts
│   │   │   └── run-ingestion.ts
│   │   ├── Dockerfile
│   │   ├── jest.config.js
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsconfig.tsbuildinfo
│   ├── job-strategist
│   │   ├── src
│   │   │   ├── __tests__
│   │   │   │   └── run-pipeline.integration.test.ts
│   │   │   ├── agents
│   │   │   │   ├── coach-agent.test.ts
│   │   │   │   ├── coach-agent.ts
│   │   │   │   ├── research-agent-validation.test.ts
│   │   │   │   ├── research-agent.test.ts
│   │   │   │   ├── research-agent.ts
│   │   │   │   ├── strategist-agent.ts
│   │   │   │   └── strategist-tailored-resume.test.ts
│   │   │   ├── lib
│   │   │   │   ├── pg.ts
│   │   │   │   └── pipeline-runs.ts
│   │   │   ├── prompts
│   │   │   │   ├── coach-persona.ts
│   │   │   │   ├── research-persona.ts
│   │   │   │   ├── resume-builder-persona.ts
│   │   │   │   ├── resume-constraints.ts
│   │   │   │   └── strategist-persona.ts
│   │   │   ├── schemas
│   │   │   │   ├── dynamo-record.schema.ts
│   │   │   │   ├── environment.schema.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── resume-data.schema.ts
│   │   │   │   └── trigger.schema.ts
│   │   │   ├── security
│   │   │   │   ├── input-sanitiser.ts
│   │   │   │   └── output-sanitiser.ts
│   │   │   ├── services
│   │   │   │   └── resume-service.ts
│   │   │   ├── env-case-study.ts
│   │   │   ├── env-clustering.ts
│   │   │   ├── env-coach.ts
│   │   │   ├── env.ts
│   │   │   ├── run-case-study.ts
│   │   │   ├── run-clustering.ts
│   │   │   ├── run-coach.ts
│   │   │   └── run-pipeline.ts
│   │   ├── Dockerfile
│   │   ├── jest.config.js
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsconfig.tsbuildinfo
│   ├── ontology-importer
│   │   ├── src
│   │   │   ├── __tests__
│   │   │   │   └── integration.test.ts
│   │   │   ├── aliases
│   │   │   │   ├── aliasFilters.test.ts
│   │   │   │   ├── aliasFilters.ts
│   │   │   │   ├── AliasGenerator.test.ts
│   │   │   │   └── AliasGenerator.ts
│   │   │   ├── categorization
│   │   │   │   ├── BedrockBatchClassifier.test.ts
│   │   │   │   ├── BedrockBatchClassifier.ts
│   │   │   │   ├── Categorizer.test.ts
│   │   │   │   ├── Categorizer.ts
│   │   │   │   ├── overrides.json
│   │   │   │   ├── patterns.json
│   │   │   │   ├── ProseSafeTagger.test.ts
│   │   │   │   └── ProseSafeTagger.ts
│   │   │   ├── importer
│   │   │   │   ├── DeactivationDetector.test.ts
│   │   │   │   ├── DeactivationDetector.ts
│   │   │   │   ├── ImportRunSummary.test.ts
│   │   │   │   ├── ImportRunSummary.ts
│   │   │   │   ├── OntologyImporter.test.ts
│   │   │   │   └── OntologyImporter.ts
│   │   │   ├── sources
│   │   │   │   ├── __tests__
│   │   │   │   │   └── fixtures
│   │   │   │   │       ├── azure-specs.json
│   │   │   │   │       ├── botocore-s3-service-2.json
│   │   │   │   │       ├── cratesio.json
│   │   │   │   │       ├── gcp-services.json
│   │   │   │   │       ├── maven.json
│   │   │   │   │       ├── npm-package.json
│   │   │   │   │       └── pypi-package.json
│   │   │   │   ├── data
│   │   │   │   │   ├── azure-services.json
│   │   │   │   │   ├── gcp-services.json
│   │   │   │   │   ├── loadPypiTop.ts
│   │   │   │   │   ├── npm-top-5k.json
│   │   │   │   │   ├── pypi-top-5k.json
│   │   │   │   │   └── README.md
│   │   │   │   ├── AwsBotocoreSource.test.ts
│   │   │   │   ├── AwsBotocoreSource.ts
│   │   │   │   ├── AzureRestSpecsSource.test.ts
│   │   │   │   ├── AzureRestSpecsSource.ts
│   │   │   │   ├── CratesIoSource.test.ts
│   │   │   │   ├── CratesIoSource.ts
│   │   │   │   ├── FakeSource.ts
│   │   │   │   ├── GcpServiceUsageSource.test.ts
│   │   │   │   ├── GcpServiceUsageSource.ts
│   │   │   │   ├── index.test.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── MavenCentralSource.test.ts
│   │   │   │   ├── MavenCentralSource.ts
│   │   │   │   ├── NpmRegistrySource.test.ts
│   │   │   │   ├── NpmRegistrySource.ts
│   │   │   │   ├── PypiBigQuerySource.test.ts
│   │   │   │   ├── PypiBigQuerySource.ts
│   │   │   │   └── Source.ts
│   │   │   ├── env.ts
│   │   │   ├── metrics.ts
│   │   │   ├── run-import.ts
│   │   │   ├── run-llm-batch-followup.ts
│   │   │   └── run-tag-aliases-prose-safe.ts
│   │   ├── Dockerfile
│   │   ├── jest.config.js
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsconfig.tsbuildinfo
│   ├── platform-job-watcher
│   │   ├── __tests__
│   │   │   ├── config.test.ts
│   │   │   ├── reconciler.test.ts
│   │   │   └── watcher.test.ts
│   │   ├── src
│   │   │   ├── config.ts
│   │   │   ├── db.ts
│   │   │   ├── reconciler.ts
│   │   │   ├── run-watcher.ts
│   │   │   └── watcher.ts
│   │   ├── Dockerfile
│   │   ├── jest.config.js
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── platform-rds-bootstrap
│   │   ├── docs
│   │   │   └── projects-migration
│   │   │       └── 00-current-state.md
│   │   ├── migrations
│   │   │   ├── 003_cognito_user_provisioning.sql
│   │   │   ├── 004_resume_portfolio_columns.sql
│   │   │   ├── 005_user_identities.sql
│   │   │   ├── 006_user_roles.sql
│   │   │   ├── 007_reverse_trial.sql
│   │   │   ├── 008_ingestion_quota_debounce.sql
│   │   │   ├── 009_oauth_connections_avatar.sql
│   │   │   ├── 010_resume_import_pipeline.sql
│   │   │   ├── 011_prompt_observability.sql
│   │   │   ├── 012_resume_imports_updated_at.sql
│   │   │   ├── 013_bedrock_cost_tracking.sql
│   │   │   ├── 014_repository_profiles.sql
│   │   │   ├── 015_chat_sessions.sql
│   │   │   ├── 016_resume_import_corrections.sql
│   │   │   ├── 017_tavily_cache.sql
│   │   │   ├── 018_resume_import_confirmed_state.sql
│   │   │   ├── 019_resume_import_gap_report.sql
│   │   │   ├── 020_query_path_indexes.sql
│   │   │   ├── 021_rls_pipeline_tables.sql
│   │   │   ├── 022_semantic_cache.sql
│   │   │   ├── 023_retrieval_quality.sql
│   │   │   ├── 024_billing_pending_subscriptions.sql
│   │   │   ├── 024_user_profile_rollup.sql
│   │   │   ├── 025_billing_cancel_at_period_end.sql
│   │   │   ├── 025_user_profile_mirror_reveal.sql
│   │   │   ├── 026_user_profile_direction.sql
│   │   │   ├── 026_users_soft_delete.sql
│   │   │   ├── 027_user_profile_reconciliation.sql
│   │   │   ├── 028_user_profile_diagnostic.sql
│   │   │   ├── 029_oauth_token_envelope.sql
│   │   │   ├── 030_projects.sql
│   │   │   ├── 031_projects_backfill.sql
│   │   │   ├── 032_projects_proposal_state.sql
│   │   │   ├── 033_projects_case_study_status.sql
│   │   │   ├── 034_technology_graph.sql
│   │   │   ├── 035_technology_ontology_expand.sql
│   │   │   ├── 036_ontology_import_tracking.sql
│   │   │   ├── 037_alias_prose_safe.sql
│   │   │   └── 038_evidence_source_layer_code_prose.sql
│   │   ├── sql
│   │   │   └── manual
│   │   │       └── 030_oauth_token_drop_plain.sql
│   │   ├── src
│   │   │   ├── bootstrap.ts
│   │   │   ├── index.ts
│   │   │   └── migrate-dynamo.ts
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── ROLLBACK.md
│   │   ├── tsconfig.json
│   │   └── tsconfig.tsbuildinfo
│   ├── resume-import-processor
│   │   ├── src
│   │   │   ├── __tests__
│   │   │   │   ├── enrichment.test.ts
│   │   │   │   └── metrics.contract.test.ts
│   │   │   ├── bedrock
│   │   │   │   ├── __tests__
│   │   │   │   │   ├── enrich-role.test.ts
│   │   │   │   │   ├── extract-career.test.ts
│   │   │   │   │   └── gap-analysis.test.ts
│   │   │   │   ├── enrich-role.ts
│   │   │   │   ├── extract-career.ts
│   │   │   │   └── gap-analysis.ts
│   │   │   ├── parsers
│   │   │   │   ├── __tests__
│   │   │   │   │   ├── docx.test.ts
│   │   │   │   │   ├── pdf.integration.test.ts
│   │   │   │   │   └── pdf.test.ts
│   │   │   │   ├── docx.ts
│   │   │   │   └── pdf.ts
│   │   │   ├── tools
│   │   │   │   ├── __tests__
│   │   │   │   │   ├── tavily-cache.test.ts
│   │   │   │   │   └── tavily-fanout.test.ts
│   │   │   │   ├── tavily-cache.ts
│   │   │   │   ├── tavily-fanout.ts
│   │   │   │   └── tavily.ts
│   │   │   ├── embed.ts
│   │   │   ├── enrichment.ts
│   │   │   ├── env.ts
│   │   │   ├── metrics.ts
│   │   │   ├── run-enrichment.ts
│   │   │   └── run-import.ts
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsconfig.tsbuildinfo
│   ├── self-healing
│   │   ├── src
│   │   │   ├── tools
│   │   │   │   ├── analyse-cluster-health
│   │   │   │   │   └── index.ts
│   │   │   │   ├── check-argocd-sync
│   │   │   │   │   └── index.ts
│   │   │   │   ├── check-cert-manager
│   │   │   │   │   └── index.ts
│   │   │   │   ├── check-ingress-routes
│   │   │   │   │   └── index.ts
│   │   │   │   ├── check-node-health
│   │   │   │   │   └── index.ts
│   │   │   │   ├── check-security-group-rules
│   │   │   │   │   └── index.ts
│   │   │   │   ├── diagnose-alarm
│   │   │   │   │   └── index.ts
│   │   │   │   ├── get-node-diagnostic-json
│   │   │   │   │   └── index.ts
│   │   │   │   ├── inspect-workloads
│   │   │   │   │   └── index.ts
│   │   │   │   └── remediate-node-bootstrap
│   │   │   │       └── index.ts
│   │   │   ├── handler.test.ts
│   │   │   ├── index.ts
│   │   │   └── outcome-tracker.ts
│   │   ├── jest.config.js
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsconfig.tsbuildinfo
│   ├── shared
│   │   ├── src
│   │   │   ├── cache
│   │   │   │   ├── cache-types.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── pg-semantic-cache.test.ts
│   │   │   │   ├── pg-semantic-cache.ts
│   │   │   │   ├── redis-client.test.ts
│   │   │   │   ├── redis-client.ts
│   │   │   │   ├── redis-exact-cache.test.ts
│   │   │   │   ├── redis-exact-cache.ts
│   │   │   │   ├── redis-read-cache.test.ts
│   │   │   │   └── redis-read-cache.ts
│   │   │   ├── chatbot
│   │   │   │   ├── __tests__
│   │   │   │   │   ├── context-builder.test.ts
│   │   │   │   │   ├── query-expander.test.ts
│   │   │   │   │   └── zero-result.test.ts
│   │   │   │   ├── context-builder.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── query-expander.ts
│   │   │   │   ├── system-prompt.ts
│   │   │   │   ├── types.ts
│   │   │   │   └── zero-result.ts
│   │   │   ├── config
│   │   │   │   └── feature-flags.ts
│   │   │   ├── crypto
│   │   │   │   ├── index.ts
│   │   │   │   ├── kmsEnvelope.test.ts
│   │   │   │   └── kmsEnvelope.ts
│   │   │   ├── github
│   │   │   │   ├── appJwt.test.ts
│   │   │   │   ├── appJwt.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── webhookSignature.test.ts
│   │   │   │   └── webhookSignature.ts
│   │   │   ├── grounding
│   │   │   │   ├── bedrock-grounding-verifier.test.ts
│   │   │   │   ├── bedrock-grounding-verifier.ts
│   │   │   │   ├── grounding-types.ts
│   │   │   │   └── index.ts
│   │   │   ├── ingestion
│   │   │   │   ├── implementations
│   │   │   │   │   ├── ChunkerRegistry.test.ts
│   │   │   │   │   ├── ChunkerRegistry.ts
│   │   │   │   │   ├── CommitChunker.test.ts
│   │   │   │   │   ├── CommitChunker.ts
│   │   │   │   │   ├── DefaultChunker.ts
│   │   │   │   │   ├── FileFilter.test.ts
│   │   │   │   │   ├── FileFilter.ts
│   │   │   │   │   ├── GitHubAdapter.ts
│   │   │   │   │   ├── index.ts
│   │   │   │   │   ├── MarkdownChunker.test.ts
│   │   │   │   │   └── MarkdownChunker.ts
│   │   │   │   ├── interfaces
│   │   │   │   │   ├── IChunker.ts
│   │   │   │   │   ├── IFileFilter.ts
│   │   │   │   │   ├── index.ts
│   │   │   │   │   └── IRepoAdapter.ts
│   │   │   │   ├── orchestrator
│   │   │   │   │   ├── index.ts
│   │   │   │   │   └── RepoIngestionOrchestrator.ts
│   │   │   │   └── index.ts
│   │   │   ├── observability
│   │   │   │   ├── bedrock.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── k8s.ts
│   │   │   │   ├── lambda.ts
│   │   │   │   ├── logger.ts
│   │   │   │   └── pushgateway.ts
│   │   │   ├── projects
│   │   │   │   ├── case-study-agent.ts
│   │   │   │   ├── case-study-loader.ts
│   │   │   │   ├── case-study-orchestrator.ts
│   │   │   │   ├── case-study-persistence.ts
│   │   │   │   ├── case-study-types.ts
│   │   │   │   ├── clustering-agent.ts
│   │   │   │   ├── clustering-loader.ts
│   │   │   │   ├── clustering-orchestrator.test.ts
│   │   │   │   ├── clustering-orchestrator.ts
│   │   │   │   ├── clustering-persistence.ts
│   │   │   │   ├── clustering-signals.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── source-signals.ts
│   │   │   │   └── types.ts
│   │   │   ├── rds
│   │   │   │   ├── diagnostic
│   │   │   │   │   ├── computeUserDiagnostic.test.ts
│   │   │   │   │   └── computeUserDiagnostic.ts
│   │   │   │   ├── implementations
│   │   │   │   │   ├── BedrockChunkEnricher.test.ts
│   │   │   │   │   ├── BedrockChunkEnricher.ts
│   │   │   │   │   ├── index.ts
│   │   │   │   │   ├── OntologyImportRunRepository.test.ts
│   │   │   │   │   ├── OntologyImportRunRepository.ts
│   │   │   │   │   ├── OntologyImportSourceRepository.test.ts
│   │   │   │   │   ├── OntologyImportSourceRepository.ts
│   │   │   │   │   ├── OntologyReviewQueueRepository.test.ts
│   │   │   │   │   ├── OntologyReviewQueueRepository.ts
│   │   │   │   │   ├── OntologySkippedImportRepository.test.ts
│   │   │   │   │   ├── OntologySkippedImportRepository.ts
│   │   │   │   │   ├── OntologyWriteRepository.test.ts
│   │   │   │   │   ├── OntologyWriteRepository.ts
│   │   │   │   │   ├── RdsCareerHistoryReadRepository.test.ts
│   │   │   │   │   ├── RdsCareerHistoryReadRepository.ts
│   │   │   │   │   ├── RdsDiagnosticInputsReadRepository.test.ts
│   │   │   │   │   ├── RdsDiagnosticInputsReadRepository.ts
│   │   │   │   │   ├── RdsOAuthConnectionsRepository.test.ts
│   │   │   │   │   ├── RdsOAuthConnectionsRepository.ts
│   │   │   │   │   ├── RdsSyncStateRepository.test.ts
│   │   │   │   │   ├── RdsSyncStateRepository.ts
│   │   │   │   │   ├── RdsUserProfileRollupRepository.test.ts
│   │   │   │   │   ├── RdsUserProfileRollupRepository.ts
│   │   │   │   │   ├── RdsVectorStore.ts
│   │   │   │   │   ├── TechnologyCandidateRepository.test.ts
│   │   │   │   │   ├── TechnologyCandidateRepository.ts
│   │   │   │   │   ├── TechnologyEvidenceRepository.test.ts
│   │   │   │   │   ├── TechnologyEvidenceRepository.ts
│   │   │   │   │   ├── TechnologyOntologyRepository.test.ts
│   │   │   │   │   ├── TechnologyOntologyRepository.ts
│   │   │   │   │   ├── TechnologyParityRunRepository.test.ts
│   │   │   │   │   ├── TechnologyParityRunRepository.ts
│   │   │   │   │   └── TitanEmbeddingProvider.ts
│   │   │   │   ├── interfaces
│   │   │   │   │   ├── ICareerHistoryReadRepository.ts
│   │   │   │   │   ├── IChunkEnricher.ts
│   │   │   │   │   ├── IDiagnosticInputsReadRepository.ts
│   │   │   │   │   ├── IEmbeddingProvider.ts
│   │   │   │   │   ├── index.ts
│   │   │   │   │   ├── IOAuthConnectionsRepository.ts
│   │   │   │   │   ├── ISyncStateRepository.ts
│   │   │   │   │   ├── IUserProfileRollupRepository.ts
│   │   │   │   │   └── IVectorStore.ts
│   │   │   │   ├── ontology
│   │   │   │   │   ├── OntologyResolver.test.ts
│   │   │   │   │   └── OntologyResolver.ts
│   │   │   │   ├── pipeline
│   │   │   │   │   ├── index.ts
│   │   │   │   │   ├── IngestionPipeline.test.ts
│   │   │   │   │   └── IngestionPipeline.ts
│   │   │   │   ├── profile
│   │   │   │   │   ├── computeUserProfileRollup.test.ts
│   │   │   │   │   └── computeUserProfileRollup.ts
│   │   │   │   ├── quality
│   │   │   │   │   ├── computeKbQuality.test.ts
│   │   │   │   │   ├── computeKbQuality.ts
│   │   │   │   │   ├── retrievalProbe.test.ts
│   │   │   │   │   └── retrievalProbe.ts
│   │   │   │   ├── types
│   │   │   │   │   ├── ontology-import.ts
│   │   │   │   │   └── techgraph.ts
│   │   │   │   ├── backfillOAuthTokenEnvelope.test.ts
│   │   │   │   ├── backfillOAuthTokenEnvelope.ts
│   │   │   │   ├── bedrock-cost.test.ts
│   │   │   │   ├── bedrock-cost.ts
│   │   │   │   ├── index.ts
│   │   │   │   └── types.ts
│   │   │   ├── retrieval
│   │   │   │   ├── implementations
│   │   │   │   │   ├── BedrockReranker.test.ts
│   │   │   │   │   ├── BedrockReranker.ts
│   │   │   │   │   ├── PgVectorRetriever.test.ts
│   │   │   │   │   └── PgVectorRetriever.ts
│   │   │   │   ├── interfaces
│   │   │   │   │   └── IReranker.ts
│   │   │   │   └── index.ts
│   │   │   ├── security
│   │   │   │   ├── comprehend-pii-detector.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── input-sanitiser.ts
│   │   │   │   ├── output-sanitiser.ts
│   │   │   │   ├── pii-scrubber.test.ts
│   │   │   │   ├── pii-scrubber.ts
│   │   │   │   ├── pii-types.ts
│   │   │   │   ├── regex-pii-detector.test.ts
│   │   │   │   ├── regex-pii-detector.ts
│   │   │   │   └── types.ts
│   │   │   ├── agent-runner.test.ts
│   │   │   ├── agent-runner.ts
│   │   │   ├── base-agent.ts
│   │   │   ├── emf.ts
│   │   │   ├── index.ts
│   │   │   ├── logger.ts
│   │   │   ├── mcp-client.ts
│   │   │   ├── metrics.ts
│   │   │   ├── strategist-types.ts
│   │   │   └── types.ts
│   │   ├── jest.config.js
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsconfig.tsbuildinfo
│   ├── synthetic-monitor
│   │   ├── src
│   │   │   ├── __tests__
│   │   │   │   └── assertions.test.ts
│   │   │   ├── assertions.ts
│   │   │   ├── check.ts
│   │   │   └── prometheus.ts
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsconfig.tsbuildinfo
│   ├── tech-extractor
│   │   ├── parity
│   │   │   ├── 2026-05-26-analysis.md
│   │   │   ├── 2026-05-26-bucket-recount.csv
│   │   │   ├── 2026-05-26-bucket-recount.md
│   │   │   ├── 2026-05-26-diff-classification.csv
│   │   │   ├── 2026-05-27-bucket-recount-v23.csv
│   │   │   └── 2026-05-27-decommission.md
│   │   ├── specs
│   │   │   └── 2026-05-26-iac-detector-strengthening-design.md
│   │   ├── src
│   │   │   ├── __tests__
│   │   │   │   ├── fixtures
│   │   │   │   │   └── iac-value-chart
│   │   │   │   │       ├── external-secret.yaml
│   │   │   │   │       ├── job.yaml
│   │   │   │   │       └── sa.yaml
│   │   │   │   ├── iac-value-scanner.integration.test.ts
│   │   │   │   └── integration.test.ts
│   │   │   ├── config
│   │   │   │   └── sdkCallPatterns.json
│   │   │   ├── extractors
│   │   │   │   ├── __tests__
│   │   │   │   │   └── fixtures
│   │   │   │   │       └── syft-output.json
│   │   │   │   ├── iac
│   │   │   │   │   ├── ArgoHelmParser.test.ts
│   │   │   │   │   ├── ArgoHelmParser.ts
│   │   │   │   │   ├── ArnScanner.test.ts
│   │   │   │   │   ├── ArnScanner.ts
│   │   │   │   │   ├── awsServiceMap.test.ts
│   │   │   │   │   ├── awsServiceMap.ts
│   │   │   │   │   ├── DockerfileParser.test.ts
│   │   │   │   │   ├── DockerfileParser.ts
│   │   │   │   │   ├── EcrUriScanner.test.ts
│   │   │   │   │   ├── EcrUriScanner.ts
│   │   │   │   │   ├── GithubActionsParser.test.ts
│   │   │   │   │   ├── GithubActionsParser.ts
│   │   │   │   │   ├── K8sManifestParser.test.ts
│   │   │   │   │   ├── K8sManifestParser.ts
│   │   │   │   │   ├── ReadmeParser.test.ts
│   │   │   │   │   ├── ReadmeParser.ts
│   │   │   │   │   ├── TerraformParser.test.ts
│   │   │   │   │   └── TerraformParser.ts
│   │   │   │   ├── CommentExtractor.test.ts
│   │   │   │   ├── CommentExtractor.ts
│   │   │   │   ├── Extractor.ts
│   │   │   │   ├── SyftExtractor.test.ts
│   │   │   │   ├── SyftExtractor.ts
│   │   │   │   ├── TreeSitterExtractor.test.ts
│   │   │   │   └── TreeSitterExtractor.ts
│   │   │   ├── orchestrator
│   │   │   │   ├── TechExtractOrchestrator.test.ts
│   │   │   │   └── TechExtractOrchestrator.ts
│   │   │   ├── parity
│   │   │   │   ├── ParityReporter.test.ts
│   │   │   │   └── ParityReporter.ts
│   │   │   ├── tarball
│   │   │   │   ├── fetchTarball.test.ts
│   │   │   │   ├── fetchTarball.ts
│   │   │   │   ├── safeExtract.test.ts
│   │   │   │   └── safeExtract.ts
│   │   │   ├── util
│   │   │   │   ├── fileWalk.test.ts
│   │   │   │   └── fileWalk.ts
│   │   │   ├── env.ts
│   │   │   └── run-tech-extract.ts
│   │   ├── Dockerfile
│   │   ├── jest.config.js
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsconfig.tsbuildinfo
│   ├── jest.config.js
│   ├── package.json
│   └── tsconfig.json
├── content
│   └── articles
│       ├── agentic-content-pipeline-bedrock-rag-publishing.md
│       ├── ai-self-healing-infrastructure-bedrock-agentcore.md
│       ├── certification-journey-aws-devops-professional.md
│       ├── cicd-github-actions-step-functions-argocd-gitops.md
│       ├── full-stack-observability-prometheus-grafana-loki-tempo.md
│       ├── networking-from-scratch-vpc-calico-traefik-cloudfront.md
│       ├── README.md
│       └── self-managed-kubernetes-on-aws-with-cdk.md
├── docs
│   ├── checklists
│   │   ├── rag-deployment-checklist.md
│   │   └── structure-output-checklist.md
│   ├── guides
│   │   └── knowledge-base-source-repository-guide.md
│   ├── incoming
│   │   ├── bedrock-article-generation-pipeline.md
│   │   ├── observability-plan.md
│   │   └── strategist-pipeline-workflow-review.md
│   ├── plans
│   │   ├── rag-shared-safety-implementation-plan.md
│   │   ├── rag-subproject2-app-wiring-implementation-plan.md
│   │   ├── rag-subproject3-semantic-cache-implementation-plan.md
│   │   └── tier2-ontology-auto-import.md
│   ├── projects-migration
│   │   └── 00-current-state.md
│   ├── reviews
│   │   ├── dataset-model-system-design-review.md
│   │   ├── ingestion-pipeline-implementation-review.md
│   │   ├── ingestion-strategist-design-review.md
│   │   ├── rag-shared-safety-design-review.md
│   │   ├── rag-subproject2-app-wiring-design-review.md
│   │   └── rag-subproject3-semantic-cache-design-review.md
│   ├── skills
│   │   ├── self-healing-updater
│   │   │   └── SKILL.md
│   │   └── self-healing-updater-workspace
│   │       └── evals
│   │           └── evals.json
│   ├── superpowers
│   │   ├── plans
│   │   │   ├── 2026-05-02-self-healing-node-lifecycle-trigger.md
│   │   │   ├── 2026-05-13-phase2-article-pipeline-pgvector.md
│   │   │   ├── 2026-05-13-phase3-chatbot-rag-lambda.md
│   │   │   ├── 2026-05-13-profile-extractor.md
│   │   │   ├── 2026-05-17-e2e-smoke-test.md
│   │   │   ├── 2026-05-18-retrieval-quality-probe.md
│   │   │   ├── 2026-05-19-direction.md
│   │   │   ├── 2026-05-19-distillation-cards.md
│   │   │   ├── 2026-05-19-mirror-reveal.md
│   │   │   ├── 2026-05-19-profile-aggregation-foundation.md
│   │   │   ├── 2026-05-19-reconciliation.md
│   │   │   ├── 2026-05-20-diagnostic.md
│   │   │   ├── 2026-05-20-oauth-app-revocation-foundation.md
│   │   │   ├── 2026-05-20-oauth-token-envelope-encryption.md
│   │   │   ├── 2026-05-21-github-webhook-and-app-jwt.md
│   │   │   ├── 2026-05-22-redis-ai-generation-cache.md
│   │   │   ├── 2026-05-25-ontology-importer-bedrock-batch.md
│   │   │   ├── 2026-05-25-tech-extractor-layer1-extraction-app.md
│   │   │   ├── 2026-05-25-tech-extractor-layer1-foundation.md
│   │   │   ├── 2026-05-25-tech-extractor-layer1-job-infra.md
│   │   │   ├── 2026-05-25-tier2-ontology-importer-foundation.md
│   │   │   ├── 2026-05-25-tier2-ontology-importer-llm-infra.md
│   │   │   ├── 2026-05-25-tier2-ontology-importer-sources.md
│   │   │   └── 2026-05-26-iac-detector-strengthening.md
│   │   └── specs
│   │       ├── 2026-05-13-phase3-chatbot-rag-lambda-design.md
│   │       ├── 2026-05-13-profile-extractor-design.md
│   │       ├── 2026-05-17-e2e-smoke-test-design.md
│   │       ├── 2026-05-18-retrieval-quality-probe-design.md
│   │       ├── 2026-05-19-direction-design.md
│   │       ├── 2026-05-19-distillation-cards-design.md
│   │       ├── 2026-05-19-mirror-reveal-design.md
│   │       ├── 2026-05-19-profile-aggregation-foundation-design.md
│   │       ├── 2026-05-19-reconciliation-design.md
│   │       ├── 2026-05-20-diagnostic-design.md
│   │       ├── 2026-05-20-oauth-app-revocation-foundation-design.md
│   │       ├── 2026-05-20-oauth-token-envelope-encryption-design.md
│   │       ├── 2026-05-21-github-webhook-and-app-jwt-design.md
│   │       ├── 2026-05-22-redis-ai-generation-cache-design.md
│   │       ├── 2026-05-25-ontology-importer-bedrock-batch-design.md
│   │       └── 2026-05-25-tech-extractor-layer1-design.md
│   └── repo-structure.md
├── infra
│   ├── bin
│   │   └── app.ts
│   ├── lib
│   │   ├── aspects
│   │   │   ├── cdk-nag-aspect.ts
│   │   │   ├── index.ts
│   │   │   └── tagging-aspect.ts
│   │   ├── config
│   │   │   ├── bedrock
│   │   │   │   ├── allocations.ts
│   │   │   │   ├── chatbot-persona.ts
│   │   │   │   ├── configurations.ts
│   │   │   │   ├── content-allocations.ts
│   │   │   │   ├── index.ts
│   │   │   │   └── strategist-persona.ts
│   │   │   ├── self-healing
│   │   │   │   ├── allocations.ts
│   │   │   │   ├── configurations.ts
│   │   │   │   └── index.ts
│   │   │   ├── shared
│   │   │   │   └── model-registry.ts
│   │   │   ├── defaults.ts
│   │   │   ├── environments.ts
│   │   │   ├── index.ts
│   │   │   └── projects.ts
│   │   ├── constructs
│   │   │   ├── observability
│   │   │   │   ├── application-inference-profile.ts
│   │   │   │   └── index.ts
│   │   │   └── index.ts
│   │   ├── factories
│   │   │   ├── index.ts
│   │   │   ├── project-interfaces.ts
│   │   │   └── project-registry.ts
│   │   ├── projects
│   │   │   ├── bedrock
│   │   │   │   ├── factory.ts
│   │   │   │   └── index.ts
│   │   │   ├── self-healing
│   │   │   │   ├── factory.ts
│   │   │   │   └── index.ts
│   │   │   └── index.ts
│   │   ├── stacks
│   │   │   ├── bedrock
│   │   │   │   ├── agent-stack.ts
│   │   │   │   ├── api-stack.ts
│   │   │   │   ├── data-stack.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── kb-stack.ts
│   │   │   │   └── README.md
│   │   │   └── self-healing
│   │   │       ├── agent-stack.ts
│   │   │       ├── gateway-stack.ts
│   │   │       └── index.ts
│   │   └── utilities
│   │       ├── index.ts
│   │       ├── lambda-observability.ts
│   │       ├── naming.ts
│   │       └── validation.ts
│   ├── scripts
│   │   ├── cd
│   │   │   ├── deploy.ts
│   │   │   ├── deployment-failure-report.ts
│   │   │   ├── diagnose-rollback.ts
│   │   │   └── finalize.ts
│   │   ├── ci
│   │   │   ├── cfn-import-rescue.ts
│   │   │   ├── preflight-checks.ts
│   │   │   ├── security-scan.ts
│   │   │   └── synthesize.ts
│   │   └── shared
│   │       ├── exec.ts
│   │       └── stacks.ts
│   ├── tests
│   │   ├── fixtures
│   │   │   ├── assertions.ts
│   │   │   ├── constants.ts
│   │   │   ├── index.ts
│   │   │   ├── mock-resources.ts
│   │   │   └── test-app.ts
│   │   ├── unit
│   │   │   └── stacks
│   │   │       └── bedrock
│   │   │           ├── agent-stack.test.ts
│   │   │           ├── api-stack.test.ts
│   │   │           ├── data-stack.test.ts
│   │   │           └── kb-stack.test.ts
│   │   ├── jest-setup.ts
│   │   └── jest-worker-setup.js
│   ├── cdk.context.json
│   ├── cdk.json
│   ├── eslint.config.mjs
│   ├── jest.config.js
│   ├── jest.integration.config.js
│   ├── package.json
│   └── tsconfig.json
├── packages
│   └── script-utils
│       ├── src
│       │   ├── aws.ts
│       │   ├── cdk.ts
│       │   ├── exec.ts
│       │   ├── github.ts
│       │   ├── logger.ts
│       │   ├── paths.ts
│       │   ├── stacks.ts
│       │   └── types.ts
│       ├── jest.config.cjs
│       └── package.json
├── rag-checklist
│   ├── article-pipeline.md
│   ├── chatbot.md
│   ├── ingestion.md
│   ├── job-strategist.md
│   ├── README.md
│   └── resume-import.md
├── scripts
│   ├── smoke
│   │   ├── __tests__
│   │   │   ├── admin-api-client.test.ts
│   │   │   ├── cleanup-file.test.ts
│   │   │   ├── cleanup-registry.test.ts
│   │   │   ├── cognito-auth.test.ts
│   │   │   ├── discovery.test.ts
│   │   │   ├── exec-wrapper.test.ts
│   │   │   └── rds-client.test.ts
│   │   ├── fixtures
│   │   │   ├── article-draft.md
│   │   │   └── strategist-jd.txt
│   │   ├── admin-api-client.ts
│   │   ├── admin-api-contract.ts
│   │   ├── article-pipeline.smoke.test.ts
│   │   ├── chatbots.smoke.test.ts
│   │   ├── cleanup-file.ts
│   │   ├── cleanup-registry.ts
│   │   ├── cognito-auth.ts
│   │   ├── discovery.ts
│   │   ├── exec-wrapper.ts
│   │   ├── ingestion.smoke.test.ts
│   │   ├── jest.smoke.config.cjs
│   │   ├── job-strategist.smoke.test.ts
│   │   ├── port-forward.ts
│   │   ├── rds-client.ts
│   │   ├── README.md
│   │   ├── resume-import.smoke.test.ts
│   │   ├── tsconfig.json
│   │   └── types.ts
│   ├── backfill-oauth-token-envelope.ts
│   ├── seed-public-api-github-app.sh
│   ├── smoke-e2e.ts
│   ├── smoke-test-github-adapter.ts
│   ├── test-projects-case-study.ts
│   ├── test-projects-clustering.ts
│   ├── test-projects-migration.ts
│   └── test-strategist-integration.ts
├── CONTEXT.md
├── eslint.config.mjs
├── jest.config.base.cjs
├── justfile
├── package.json
├── README.md
├── tsconfig.base.json
└── yarn.lock

184 directories, 745 files
```
