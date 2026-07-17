/**
 * @format
 * Golden skill set (DeepEval track, first dataset) + loader.
 *
 * HAND-LABELLED ground truth: for each real chunk, the UNION of valid canonical
 * skills it evidences (lowercased noun phrases). A candidate (per-chunk / packed
 * / Tier1 enrichment) is scored against THIS — not against another noisy LLM
 * draw — which removes the sample-vs-sample ceiling (~0.75) that capped every
 * prior eval. Labeller: Claude Code, applying the enricher's system prompt to the
 * real content; 2026-06-20. 21 chunks, 4 repos, 7 file types.
 *
 * Embedded as TS (not JSON) so it always compiles into the container image — the
 * JSON-in-dist gap is avoided. Edit here; keep `skills` canonical + lowercased.
 *
 * Score with `computeSemanticEvalMetrics(goldenMap, candidateMap, sim, τ)`:
 *   recall    = of a chunk's golden skills, how many the candidate found;
 *   precision = of the candidate's skills, how many are VALID (in the golden union).
 */

export interface GoldenChunk { id: string; file: string; skills: string[] }
export interface GoldenSet { version: number; chunks: GoldenChunk[] }

const GOLDEN: GoldenSet = {
    version: 1,
    chunks: [
        { id: '626fd4bc-1553-4e51-b1a9-07d43357872f', file: 'ai-applications:docs/PROJECT_IMPLEMENTATION_REVIEW.md#24', skills: ['technical documentation', 'hono', 'cognito authentication', 'row level security', 'rest api design', 'react query'] },
        { id: 'fe8deb3d-c6b5-4ab3-84a3-8538bcd0c24f', file: 'tucaken-infra:CHANGELOG.md#4', skills: ['incident resolution', 'aws cloudfront', 'argocd', 'kubernetes troubleshooting', 'observability', 'structured logging'] },
        { id: '2a05cb9d-3617-4d47-9ec6-6314352e6bc5', file: 'tucaken-infra:docs/concepts/nlb-architecture.md#21', skills: ['aws networking', 'aws ec2', 'security groups', 'aws cli'] },
        { id: '02834651-993c-4dca-aada-0c596aa1b69c', file: 'ai-applications:job-strategist/evals/.../to_bedrock_byoi.py#0', skills: ['python', 'amazon bedrock', 'rag evaluation', 'evaluation tooling', 'pgvector'] },
        { id: '0c662e4b-a2d0-4c96-bb22-32e6beff9e90', file: 'tucaken-infra:.checkov/custom_checks/kms_rules.py#0', skills: ['python', 'checkov', 'infrastructure as code', 'aws kms', 'least privilege', 'cloudformation security'] },
        { id: '097cb731-13ae-4572-bd13-d747748c6e46', file: 'tucaken-infra:.checkov/custom_checks/kms_rules.py#1', skills: ['python', 'checkov', 'aws kms', 'least privilege', 'policy validation'] },
        { id: '50a8e7db-bc46-40e3-b0e7-6a4e232a3035', file: 'ai-applications:migrations/016_resume_import_corrections.sql#0', skills: ['sql', 'database schema design', 'database migrations', 'data modelling'] },
        { id: '362dc58c-a544-4de2-bb48-552e6a511eca', file: 'ai-applications:migrations/025_user_profile_mirror_reveal.sql#0', skills: ['sql', 'database migrations', 'database schema design'] },
        { id: '8fdaac20-573b-456d-a4fd-abbb76f46e69', file: 'ai-applications:migrations/046_project_ontology.sql#0', skills: ['sql', 'database schema design', 'data modelling', 'database migrations'] },
        { id: '9480273b-3c7d-4613-ad9c-730f5500eaf7', file: 'ai-applications:shared/src/agent-runner.ts#0', skills: ['typescript', 'amazon bedrock', 'aws sdk', 'distributed tracing', 'metrics and monitoring'] },
        { id: '029ba590-4038-455d-9a58-e4809d073f7d', file: 'ai-applications:ingestion/src/knowledge/IngestionPipeline.ts#10', skills: ['typescript', 'opentelemetry', 'distributed tracing', 'error handling'] },
        { id: 'ca28b707-8347-48bf-a527-a3e24c53adf5', file: 'tucaken-infra:infra/.../bedrock-observability.ts#2', skills: ['typescript', 'aws cdk', 'infrastructure as code', 'aws cloudwatch', 'observability'] },
        { id: '0e8ac9b6-f15f-44a8-be82-63f8b9aa3f3d', file: 'tucaken-app:src/components/ui/Markdown.tsx#2', skills: ['react', 'typescript', 'react development'] },
        { id: '66702463-c7aa-4363-9494-5938195096a0', file: 'tucaken-app:src/components/ui/Sparkline.tsx#0', skills: ['react', 'typescript', 'data visualisation', 'svg rendering'] },
        { id: '837e9416-0555-4d3e-b3b9-7ead22c021f3', file: 'tucaken-app:src/features/account/settings/SettingsPage.tsx#0', skills: ['react', 'typescript', 'react query', 'react development'] },
        { id: '5b07a32c-bd8c-42e1-a6da-9cfd57c9c0db', file: 'kubernetes-bootstrap:argocd-apps/cluster-autoscaler.yaml#0', skills: ['argocd', 'gitops', 'kubernetes', 'cluster autoscaler', 'autoscaling', 'helm charts'] },
        { id: 'fe39dcc8-d248-4906-a70f-da1b1f030fdc', file: 'kubernetes-bootstrap:charts/admin-api/.../networkpolicy.yaml#0', skills: ['kubernetes networking', 'kubernetes', 'network security', 'traefik'] },
        { id: '82b95194-2b84-4eba-9643-51427878b135', file: 'kubernetes-bootstrap:charts/tucaken-app/external-secrets/...yaml#0', skills: ['external secrets', 'kubernetes', 'aws ssm', 'secrets management'] },
        { id: '366d6ea8-2c2e-4098-9849-7184a1c379ff', file: 'ai-applications:.github/workflows/build-ci-image.yml#1', skills: ['github actions', 'ci/cd pipelines'] },
        { id: 'a95adf84-817c-4ebf-9783-11cbe8656092', file: 'tucaken-infra:.github/actions/setup-node-yarn/action.yml#0', skills: ['github actions', 'ci/cd pipelines', 'yarn'] },
        { id: '45e4f61b-4a94-49d0-a5ea-a64902a9b4a3', file: 'tucaken-infra:.github/workflows/deploy-org.yml#3', skills: ['github actions', 'ci/cd pipelines', 'shell scripting', 'loki'] },
    ],
};

/** golden id -> canonical skills[]. */
export function goldenToMap(golden: GoldenSet = GOLDEN): Map<string, string[]> {
    return new Map(golden.chunks.map((c) => [c.id, c.skills]));
}

/** The embedded golden set. */
export function loadGoldenSet(): GoldenSet {
    return GOLDEN;
}
