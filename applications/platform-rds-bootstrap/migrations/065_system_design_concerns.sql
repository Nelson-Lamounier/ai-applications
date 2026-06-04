-- 065_system_design_concerns.sql
-- Curated 2026 system-design interview concern ontology. Global reference data
-- (no user_id, no RLS), frozen snapshot, idempotent re-seed. Mirrors 051_dsa_topics.
BEGIN;

CREATE TABLE IF NOT EXISTS system_design_concerns (
    concern_id              TEXT PRIMARY KEY,
    category                TEXT NOT NULL,
    concern_question        TEXT NOT NULL,
    why_interviewers_ask    TEXT NOT NULL,
    detection_signals       JSONB NOT NULL DEFAULT '[]'::jsonb,
    implementation_patterns JSONB NOT NULL DEFAULT '[]'::jsonb,
    follow_up_questions     JSONB NOT NULL DEFAULT '[]'::jsonb,
    gap_signals             JSONB NOT NULL DEFAULT '[]'::jsonb,
    jd_signal_keywords      JSONB NOT NULL DEFAULT '[]'::jsonb,
    importance              SMALLINT NOT NULL DEFAULT 5,
    source                  TEXT NOT NULL,
    as_of                   DATE NOT NULL
);

INSERT INTO system_design_concerns
    (concern_id, category, concern_question, why_interviewers_ask, detection_signals,
     implementation_patterns, follow_up_questions, gap_signals, jd_signal_keywords, importance, source, as_of) VALUES

('data_isolation_tenant_scoping', 'data_isolation',
 'How do you ensure users cannot access other users'' data?',
 'Multi-tenant data leaks are catastrophic and interviewer-prominent in 2026; tests real authz vs theory.',
 '["row level security","rls","tenant","tenant_id","user_id","scoped query","middleware filter","policy"]'::jsonb,
 '[{"name":"postgres_rls","strengths":["database-enforced","hard to bypass"],"gotchas":["superuser bypass","policy perf"]},{"name":"middleware_query_filter","strengths":["explicit","debuggable"],"gotchas":["easy to forget on new query"]}]'::jsonb,
 '["What if a developer forgets the tenant filter on a new query?","How do you handle admin/support access?","How do you audit cross-tenant access attempts?","How is isolation handled in caches and search indexes?"]'::jsonb,
 '["tenant column present but queries dont filter","middleware present but inconsistent","no tests for isolation"]'::jsonb,
 '["multi-tenant","tenant","data isolation","rls","saas"]'::jsonb, 1, 'curated-2026', '2026-06-04'),

('authn_authz_sessions', 'auth',
 'How do users prove identity and how are permissions enforced?',
 'Auth is the most-probed surface; interviewers test token strategy, session handling, and authz depth.',
 '["oauth","jwt","session","cognito","passkey","magic link","refresh token","rbac","authorization","bearer"]'::jsonb,
 '[{"name":"oauth_oidc_provider","strengths":["offloads identity","standard"],"gotchas":["token lifecycle","logout propagation"]},{"name":"server_session","strengths":["revocable","simple"],"gotchas":["session store scaling"]}]'::jsonb,
 '["How do you rotate refresh tokens?","How do you revoke a compromised session?","How do you enforce least privilege?","Where does authz happen — gateway, service, or DB?"]'::jsonb,
 '["auth present but no revocation","roles checked inconsistently","tokens not rotated"]'::jsonb,
 '["authentication","authorization","oauth","identity","sso","rbac"]'::jsonb, 1, 'curated-2026', '2026-06-04'),

('rate_limiting_dos', 'dos_protection',
 'How do you protect the system from abuse, DoS, and runaway cost?',
 'Cost-based and volumetric abuse are common 2026 probes; tests defense-in-depth thinking.',
 '["rate limit","throttle","token bucket","sliding window","waf","shield","cloudflare","quota","backpressure"]'::jsonb,
 '[{"name":"app_token_bucket","strengths":["fine-grained","per-user"],"gotchas":["distributed counter coordination"]},{"name":"edge_waf","strengths":["absorbs volumetric","off-host"],"gotchas":["coarse","cost"]}]'::jsonb,
 '["Per-user, per-IP, or per-endpoint limiting?","How do you degrade gracefully under load?","How do you prevent a single user blowing up compute cost?","Where is the limiter state stored?"]'::jsonb,
 '["rate limiting present but single-node","no infra-level protection","no cost guardrails"]'::jsonb,
 '["rate limiting","ddos","abuse","throttling","waf","scale"]'::jsonb, 2, 'curated-2026', '2026-06-04'),

('reliability_self_healing', 'reliability',
 'How does the system stay available when components fail?',
 'Seniority signal; interviewers probe retries, circuit breakers, and self-healing posture.',
 '["retry","backoff","circuit breaker","health check","self-healing","failover","graceful degradation","bulkhead","timeout"]'::jsonb,
 '[{"name":"retry_with_backoff","strengths":["handles transient faults"],"gotchas":["retry storms without jitter"]},{"name":"self_healing_controller","strengths":["auto-remediation"],"gotchas":["masking real failures"]}]'::jsonb,
 '["How do you avoid retry storms?","What is your RPO/RTO target?","How do you detect a partial outage?","How do you roll back a bad deploy?"]'::jsonb,
 '["retries without backoff","no circuit breaker","no health checks"]'::jsonb,
 '["reliability","resilience","high availability","failover","sre"]'::jsonb, 3, 'curated-2026', '2026-06-04'),

('api_design_protection', 'api_design',
 'Why this API style (REST/GraphQL/gRPC), and how is it protected (validation, idempotency, versioning)?',
 'API surface is where most defects and breaking changes leak; interviewers test deliberate protocol choice and hardening, not just "we use REST".',
 '["rest","graphql","grpc","openapi","schema validation","zod","idempotency","idempotency key","versioning","api version","pagination","request validation","contract"]'::jsonb,
 '[{"name":"rest_openapi_contract","strengths":["ubiquitous tooling","cacheable","easy to debug"],"gotchas":["over/under-fetching","versioning churn"]},{"name":"graphql_typed_schema","strengths":["client-shaped responses","one round trip","strong typing"],"gotchas":["n+1 resolvers","query-cost abuse","harder caching"]},{"name":"schema_validated_boundary","strengths":["rejects malformed input early","self-documenting"],"gotchas":["schema drift between client and server if not generated"]}]'::jsonb,
 '["How do you make a write endpoint safe to retry (idempotency)?","How do you version without breaking existing clients?","Where do you validate input and what happens on a malformed request?","How do you stop an expensive query (deep GraphQL nesting, unbounded list) from overloading the backend?"]'::jsonb,
 '["endpoints exist but no input validation","no idempotency on writes","no versioning strategy","contract not enforced/generated"]'::jsonb,
 '["api","rest","graphql","grpc","openapi","api design","integration","contract"]'::jsonb, 2, 'curated-2026', '2026-06-04'),

('concurrency_race_conditions', 'concurrency',
 'How do you handle concurrent mutations and race conditions?',
 'Race conditions are the bugs that pass code review and surface in production; interviewers probe whether the candidate reasons about interleaving, not just happy paths.',
 '["transaction","optimistic lock","pessimistic lock","select for update","version column","compare and swap","mutex","advisory lock","unique constraint","serializable","upsert","on conflict","atomic"]'::jsonb,
 '[{"name":"optimistic_concurrency_version","strengths":["no held locks","scales for low contention"],"gotchas":["retry on conflict","write amplification under high contention"]},{"name":"db_row_lock_for_update","strengths":["simple correctness","strong guarantee"],"gotchas":["lock contention","deadlock risk if order varies"]},{"name":"db_unique_constraint_upsert","strengths":["database enforces invariant","race-proof inserts"],"gotchas":["need to handle conflict path explicitly"]}]'::jsonb,
 '["Two requests update the same row at once — what happens?","How do you make a check-then-write atomic?","How do you prevent a double-submit creating two records?","Do you ever hold a lock across an external call, and why is that dangerous?"]'::jsonb,
 '["check-then-write without a transaction","no unique constraint backing an invariant","read-modify-write with no version/lock","assumes single-threaded execution"]'::jsonb,
 '["concurrency","race condition","transactional","consistency","high throughput","locking"]'::jsonb, 3, 'curated-2026', '2026-06-04'),

('scaling_stateless_horizontal', 'scaling',
 'How does the system scale horizontally under load?',
 'Tests whether the design can add capacity by adding instances; interviewers hunt for hidden state that pins traffic to one node.',
 '["stateless","horizontal scaling","autoscale","autoscaling","hpa","load balancer","replica","sharding","partition","queue","worker pool","kubernetes","fan out","sticky session"]'::jsonb,
 '[{"name":"stateless_app_external_state","strengths":["any node serves any request","trivial to add replicas"],"gotchas":["must externalise sessions/cache/uploads","cold-start of new replicas"]},{"name":"horizontal_pod_autoscaler","strengths":["capacity follows demand","cost-efficient at idle"],"gotchas":["scale-up lag","metric choice (CPU vs custom)","thundering herd on dependencies"]},{"name":"queue_worker_decoupling","strengths":["absorbs spikes","scales producers and consumers independently"],"gotchas":["backlog visibility","poison messages","ordering loss"]}]'::jsonb,
 '["What state lives in-process that would break if you ran two instances?","What metric triggers a scale-out and what is the lag before new capacity is ready?","What is the first component to fall over under 10x load?","How do you scale the write path, not just the read path?"]'::jsonb,
 '["in-memory session or cache assumed single-node","no autoscaling configured","stateful singletons in the request path","read scaling only, write path unaddressed"]'::jsonb,
 '["scale","scaling","high throughput","horizontal","load","distributed","kubernetes","autoscaling"]'::jsonb, 2, 'curated-2026', '2026-06-04'),

('consistency_durability', 'consistency',
 'Sync vs async writes, eventual consistency, and durability/backup strategy?',
 'Interviewers test whether the candidate chose a consistency model on purpose and can defend the data-loss window and recovery story.',
 '["eventual consistency","strong consistency","async","synchronous write","outbox","saga","replication","write ahead log","durability","backup","point in time recovery","pitr","snapshot","read replica","quorum"]'::jsonb,
 '[{"name":"synchronous_strong_write","strengths":["read-your-writes","simple mental model"],"gotchas":["latency tied to slowest replica","availability cost on partition"]},{"name":"async_outbox_eventual","strengths":["fast user-facing write","resilient to downstream outages"],"gotchas":["stale reads window","needs idempotent consumers","dual-write trap if no outbox"]},{"name":"managed_pitr_backup","strengths":["bounded recovery point","tested restore path"],"gotchas":["restore time (RTO)","backups untested are not backups"]}]'::jsonb,
 '["Can a user read their own write immediately, or is there a lag?","What is your worst-case data-loss window if the primary dies?","How do you keep two systems in sync without a dual-write race?","When did you last test a restore from backup?"]'::jsonb,
 '["dual-writes to db and cache/queue with no outbox","no backup or untested restore","consistency model never stated","async everywhere with no read-your-writes story"]'::jsonb,
 '["consistency","durability","eventual consistency","backup","replication","data integrity","disaster recovery"]'::jsonb, 3, 'curated-2026', '2026-06-04'),

('observability_ops', 'observability',
 'What do you log vs metric vs trace, and how do you alert?',
 'Tests operational maturity; interviewers want to know the candidate can answer "is it broken and why" in production, not just build features.',
 '["logging","structured logs","metrics","prometheus","grafana","tracing","opentelemetry","otel","span","alert","alerting","dashboard","slo","sli","error budget","correlation id","health endpoint"]'::jsonb,
 '[{"name":"structured_logs_correlation_id","strengths":["queryable","ties a request across services"],"gotchas":["log volume cost","PII leakage if unfiltered"]},{"name":"red_use_metrics","strengths":["cheap","alertable","trend over time"],"gotchas":["cardinality explosion","metrics tell what not why"]},{"name":"distributed_tracing_otel","strengths":["pinpoints latency across hops","root-cause for slow requests"],"gotchas":["sampling decisions","instrumentation effort"]}]'::jsonb,
 '["A user reports it is slow — what is the first dashboard or query you open?","What do you alert on, and how do you avoid paging on noise?","How do you trace one request across multiple services?","What is logged vs measured, and why not log everything?"]'::jsonb,
 '["only ad-hoc console logs","no metrics or dashboards","alerts on symptoms not SLOs (or none)","no way to correlate a request across services"]'::jsonb,
 '["observability","monitoring","logging","metrics","tracing","prometheus","grafana","slo","on-call","sre"]'::jsonb, 2, 'curated-2026', '2026-06-04'),

('performance_caching', 'performance',
 'Caching layers, invalidation, and query/N+1 optimisation?',
 'Interviewers test whether the candidate measures before optimising and understands the hardest problem — invalidation — rather than caching blindly.',
 '["cache","caching","redis","memcached","cdn","ttl","invalidation","cache busting","n+1","query optimization","index","eager load","dataloader","materialized view","read replica","precompute"]'::jsonb,
 '[{"name":"redis_read_through_cache","strengths":["big latency win on hot reads","offloads the database"],"gotchas":["invalidation complexity","stampede on expiry","stale data risk"]},{"name":"cdn_edge_cache","strengths":["serves static/near-static close to user","absorbs read volume"],"gotchas":["cache-key design","purge propagation delay"]},{"name":"query_index_and_batching","strengths":["fixes the root cause not the symptom","no extra moving parts"],"gotchas":["index write cost","must find the N+1 first via profiling"]}]'::jsonb,
 '["How do you invalidate or expire this cache, and what happens if it is stale?","How do you prevent a cache stampede when a hot key expires?","Did you profile before caching, or cache to hide an N+1?","What is your cache hit rate and how do you know?"]'::jsonb,
 '["cache with no invalidation strategy","caching used to mask an unindexed query / N+1","no measurement of hit rate or latency","TTL chosen arbitrarily"]'::jsonb,
 '["performance","caching","cache","redis","latency","optimization","cdn","low latency","high performance"]'::jsonb, 3, 'curated-2026', '2026-06-04'),

('cost_management', 'cost',
 'How do you keep infra cost bounded (right-sizing, autoscaling, free-tier discipline)?',
 'Cost is a 2026 first-class design constraint, especially with LLM spend; interviewers test whether the candidate treats the bill as an engineering metric.',
 '["cost","budget","right sizing","spot instance","reserved","autoscaling","scale to zero","free tier","cost explorer","token cost","caching to reduce cost","batch","tiered storage","lifecycle policy"]'::jsonb,
 '[{"name":"right_sizing_and_autoscale","strengths":["pay for what you use","scale to zero at idle"],"gotchas":["scale-up lag","cold starts","over-aggressive downscale causes thrash"]},{"name":"spot_and_reserved_mix","strengths":["large discount on interruptible/steady workloads"],"gotchas":["spot interruption handling","commitment risk on reserved"]},{"name":"cost_attribution_and_alerts","strengths":["catches runaway spend early","ties cost to feature/team"],"gotchas":["tagging discipline required","attribution gaps for shared infra"]}]'::jsonb,
 '["What is the single biggest line item in your bill, and why?","How would you cut cost 30% without cutting features?","What stops a bug or abusive user from running up a huge bill overnight?","How do you attribute cost to a feature or model?"]'::jsonb,
 '["no cost visibility or budget alerts","always-on resources with no scale-to-zero","no per-model / per-feature cost attribution","LLM calls with no caching or token budget"]'::jsonb,
 '["cost","cost optimization","finops","budget","efficiency","cloud cost","spend"]'::jsonb, 4, 'curated-2026', '2026-06-04'),

('security_beyond_auth', 'security',
 'Secret management, encryption at rest/in transit, PII and logging hygiene?',
 'Auth is only the front door; interviewers probe whether secrets, data-at-rest, transport, and log hygiene are handled — the failures that become breach headlines.',
 '["secret","secrets manager","vault","kms","encryption at rest","tls","https","mtls","pii","redaction","sealed secret","env var","sanitize","input validation","sql injection","xss","csrf","least privilege"]'::jsonb,
 '[{"name":"managed_secrets_store","strengths":["rotation","access-audited","never in source"],"gotchas":["bootstrap/access policy","caching secrets in memory safely"]},{"name":"encryption_at_rest_and_in_transit","strengths":["protects data on disk and on the wire","often compliance-required"],"gotchas":["key management (KMS) ownership","cert/TLS rotation"]},{"name":"pii_redaction_in_logs","strengths":["prevents sensitive data leaking to log sinks"],"gotchas":["easy to forget on a new log line","structured-log field allow-listing needed"]}]'::jsonb,
 '["Where do secrets live, and could they ever appear in source control or logs?","Is data encrypted at rest and in transit, and who holds the keys?","What stops a SQL-injection or XSS payload?","Does any PII end up in your logs or error reports?"]'::jsonb,
 '["secrets in env files or committed to source","no encryption at rest / unmanaged keys","PII logged unredacted","input not validated against injection"]'::jsonb,
 '["security","secrets","encryption","kms","pii","compliance","tls","vulnerability","appsec"]'::jsonb, 2, 'curated-2026', '2026-06-04'),

('ai_specific_concerns', 'ai',
 'Prompt-injection defence, output validation, token cost, RAG grounding?',
 'With LLM features now common, interviewers test whether the candidate treats the model as an untrusted, non-deterministic, costly component — not a magic black box.',
 '["prompt injection","output validation","grounding","rag","retrieval","hallucination","guardrail","token cost","model fallback","structured output","tool use","schema","eval","bedrock","embedding","context window"]'::jsonb,
 '[{"name":"rag_grounded_with_citations","strengths":["answers tied to real sources","reduces hallucination"],"gotchas":["retrieval quality dominates","stale or wrong context still misleads","chunking strategy matters"]},{"name":"structured_output_schema_validation","strengths":["machine-checkable model output","rejects malformed/invented fields"],"gotchas":["model may still fill schema with wrong values","forced-tool schema can be brittle"]},{"name":"prompt_injection_isolation","strengths":["treats retrieved/user text as untrusted","limits tool blast radius"],"gotchas":["hard to fully prevent","needs least-privilege tools and output checks"]}]'::jsonb,
 '["How do you stop untrusted text in a document from hijacking the prompt?","How do you know the model''s answer is grounded and not invented?","What happens when the model returns malformed or wrong output?","How do you bound token cost and latency per request, and what is your fallback if the model is down or slow?"]'::jsonb,
 '["LLM output trusted without validation","RAG with no grounding/citation check","no prompt-injection consideration on retrieved/user content","no token budget, fallback, or eval/regression guard"]'::jsonb,
 '["ai","llm","rag","prompt","bedrock","openai","generative","grounding","agent","ml"]'::jsonb, 2, 'curated-2026', '2026-06-04'),

('data_modeling_storage', 'data_modeling',
 'How did you choose your data stores and model the schema for access patterns?',
 'Interviewers test whether the schema and store choice follow the access patterns; the wrong model or store is expensive to undo later.',
 '["schema","data model","normalization","denormalize","index","postgres","relational","nosql","document store","key value","jsonb","foreign key","access pattern","partition key","time series","blob storage","object store"]'::jsonb,
 '[{"name":"relational_normalized_postgres","strengths":["integrity via constraints/FKs","flexible ad-hoc queries","transactions"],"gotchas":["joins at scale","schema migrations need care"]},{"name":"denormalized_for_read_pattern","strengths":["fast reads on a known access path","fewer joins"],"gotchas":["update anomalies","must keep copies in sync"]},{"name":"polyglot_store_per_workload","strengths":["right tool per data shape (blobs to object store, hot KV to redis)"],"gotchas":["operational surface area","cross-store consistency"]}]'::jsonb,
 '["What are the top read and write access patterns this schema is optimised for?","Why this store (relational vs document vs KV) for this data?","How would the model change at 100x the data volume?","Where would you denormalize, and what does that cost you on writes?"]'::jsonb,
 '["schema modeled before access patterns were known","one store forced onto a poorly-fitting workload","no indexes for the main query path","blobs / large objects stored in the primary database"]'::jsonb,
 '["data model","schema","database","postgres","nosql","storage","modeling","relational","data store"]'::jsonb, 3, 'curated-2026', '2026-06-04')

ON CONFLICT (concern_id) DO UPDATE SET
    category=EXCLUDED.category, concern_question=EXCLUDED.concern_question,
    why_interviewers_ask=EXCLUDED.why_interviewers_ask, detection_signals=EXCLUDED.detection_signals,
    implementation_patterns=EXCLUDED.implementation_patterns, follow_up_questions=EXCLUDED.follow_up_questions,
    gap_signals=EXCLUDED.gap_signals, jd_signal_keywords=EXCLUDED.jd_signal_keywords,
    importance=EXCLUDED.importance, source=EXCLUDED.source, as_of=EXCLUDED.as_of;

COMMIT;
