/** @format */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectConceptFilePatterns, detectK8sOrchestration, detectIacPresence,
  detectMigrationsDir, detectBrokerTopology, ConceptPatternExtractor,
} from '../ConceptPatternExtractor.js';
import type { ConceptTechEvidence, RawConceptEvidence } from '../ConceptPatternExtractor.js';
import { walkTextFiles } from '../../util/fileWalk.js';

function only(detector: string, out: RawConceptEvidence[]): RawConceptEvidence[] {
  return out.filter((r) => r.detector === detector);
}

// ---------------------------------------------------------------------------
// 1/2. workflow-ci / workflow-deploy
// ---------------------------------------------------------------------------

describe('workflow-ci', () => {
  it('fires on a GH Actions workflow that parses as YAML with a jobs: key', () => {
    const src = ['name: CI', 'on: push', 'jobs:', '  build:', '    runs-on: ubuntu-latest'].join('\n');
    const out = only('workflow-ci', detectConceptFilePatterns('.github/workflows/ci.yaml', src));
    expect(out).toEqual([{ conceptAlias: 'ci/cd pipelines', detector: 'workflow-ci', filePath: '.github/workflows/ci.yaml', confidence: 1.0 }]);
  });

  it('fires on a .gitlab-ci.yml with a stages: key', () => {
    const src = ['stages:', '  - build', '  - test'].join('\n');
    expect(only('workflow-ci', detectConceptFilePatterns('.gitlab-ci.yml', src))).toHaveLength(1);
  });

  it('near-miss: does NOT fire on a fixture workflow file (path guard)', () => {
    const src = ['name: CI', 'jobs:', '  build:', '    runs-on: ubuntu-latest'].join('\n');
    expect(only('workflow-ci', detectConceptFilePatterns('__tests__/fixtures/.github/workflows/ci.yaml', src))).toEqual([]);
  });

  it('near-miss: does NOT fire on a workflow-shaped markdown doc (path guard)', () => {
    const src = ['jobs:', '  build:', '    runs-on: ubuntu-latest'].join('\n');
    expect(only('workflow-ci', detectConceptFilePatterns('.github/workflows/README.md', src))).toEqual([]);
  });

  it('near-miss: does NOT fire on a Jenkinsfile written as Groovy DSL (fails YAML parse)', () => {
    const src = ['pipeline {', '  agent any', '  stages { stage("build") { steps { echo "hi" } } }', '}'].join('\n');
    expect(only('workflow-ci', detectConceptFilePatterns('Jenkinsfile', src))).toEqual([]);
  });

  it('near-miss: does NOT fire on a workflow YAML with neither jobs: nor stages:', () => {
    const src = ['name: CI', 'on: push'].join('\n');
    expect(only('workflow-ci', detectConceptFilePatterns('.github/workflows/ci.yaml', src))).toEqual([]);
  });
});

describe('workflow-deploy', () => {
  it('fires when an actionable run: line contains a deploy marker', () => {
    const src = [
      'name: Deploy', 'on: push', 'jobs:', '  deploy:', '    runs-on: ubuntu-latest',
      '    steps:', '      - run: kubectl apply -f manifest.yaml',
    ].join('\n');
    const out = only('workflow-deploy', detectConceptFilePatterns('.github/workflows/deploy.yaml', src));
    expect(out).toEqual([{ conceptAlias: 'ci/cd pipelines', detector: 'workflow-deploy', filePath: '.github/workflows/deploy.yaml', confidence: 1.0 }]);
  });

  it('fires when an actionable uses: line references an ECR action', () => {
    const src = [
      'on: push', 'jobs:', '  build:', '    runs-on: ubuntu-latest',
      '    steps:', '      - uses: aws-actions/amazon-ecr-login@v2',
    ].join('\n');
    expect(only('workflow-deploy', detectConceptFilePatterns('.github/workflows/build.yaml', src))).toHaveLength(1);
  });

  it('fires when helm upgrade / argocd markers sit inside a multi-line run: block', () => {
    const src = [
      'on: push', 'jobs:', '  deploy:', '    runs-on: ubuntu-latest',
      '    steps:', '      - run: |', '          helm upgrade myapp ./chart', '          argocd app sync myapp',
    ].join('\n');
    expect(only('workflow-deploy', detectConceptFilePatterns('.github/workflows/deploy.yaml', src))).toHaveLength(1);
  });

  it('is a distinct detector from workflow-ci (both fire on the same deploy file)', () => {
    const src = [
      'on: push', 'jobs:', '  deploy:', '    runs-on: ubuntu-latest',
      '    steps:', '      - run: kubectl apply -f manifest.yaml',
    ].join('\n');
    const out = detectConceptFilePatterns('.github/workflows/deploy.yaml', src);
    expect(out.map((r) => r.detector).sort()).toEqual(['workflow-ci', 'workflow-deploy']);
  });

  it('near-miss: does NOT fire when the deploy marker is only in a job name, not a run/uses line', () => {
    const src = [
      'on: push', 'jobs:', '  deploy-to-prod:', '    name: Deploy to prod', '    runs-on: ubuntu-latest',
      '    steps:', '      - run: echo "hello"',
    ].join('\n');
    expect(only('workflow-deploy', detectConceptFilePatterns('.github/workflows/build.yaml', src))).toEqual([]);
  });

  it('near-miss: does NOT fire when the deploy marker is only inside a commented-out script line', () => {
    const src = [
      'on: push', 'jobs:', '  build:', '    runs-on: ubuntu-latest',
      '    steps:', '      - run: |', '          # deploy to staging manually later', '          echo "hi"',
    ].join('\n');
    expect(only('workflow-deploy', detectConceptFilePatterns('.github/workflows/build.yaml', src))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. k8s-orchestration (aggregate, driven by techEvidence)
// ---------------------------------------------------------------------------

describe('k8s-orchestration', () => {
  it('fires once per distinct manifest file carrying an iac-layer kubernetes/argocd evidence row', () => {
    const techEvidence: ConceptTechEvidence[] = [
      { sourceLayer: 'iac', canonicalName: 'kubernetes', filePath: 'k8s/deploy.yaml' },
      { sourceLayer: 'iac', canonicalName: 'redis', filePath: 'k8s/deploy.yaml' },
      { sourceLayer: 'iac', canonicalName: 'argocd', filePath: 'argocd-apps/app.yaml' },
    ];
    const out = detectK8sOrchestration(techEvidence);
    expect(out).toEqual([
      { conceptAlias: 'container orchestration', detector: 'k8s-orchestration', filePath: 'k8s/deploy.yaml', confidence: 1.0 },
      { conceptAlias: 'container orchestration', detector: 'k8s-orchestration', filePath: 'argocd-apps/app.yaml', confidence: 1.0 },
    ]);
  });

  it('near-miss: does NOT fire on a README mention of kubernetes (source_layer=readme, not iac)', () => {
    const techEvidence: ConceptTechEvidence[] = [
      { sourceLayer: 'readme', canonicalName: 'kubernetes', filePath: 'README.md' },
    ];
    expect(detectK8sOrchestration(techEvidence)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. iac-presence (aggregate, driven by techEvidence)
// ---------------------------------------------------------------------------

describe('iac-presence', () => {
  it('fires once from the first real iac-layer evidence row this run', () => {
    const techEvidence: ConceptTechEvidence[] = [
      { sourceLayer: 'iac', canonicalName: 'terraform', filePath: 'infra/main.tf' },
      { sourceLayer: 'iac', canonicalName: 'kubernetes', filePath: 'k8s/deploy.yaml' },
    ];
    expect(detectIacPresence(techEvidence)).toEqual([
      { conceptAlias: 'infrastructure as code', detector: 'iac-presence', filePath: 'infra/main.tf', confidence: 1.0 },
    ]);
  });

  it('near-miss: does NOT fire when no iac-layer evidence rows exist this run', () => {
    const techEvidence: ConceptTechEvidence[] = [
      { sourceLayer: 'readme', canonicalName: 'terraform', filePath: 'README.md' },
      { sourceLayer: 'sbom', canonicalName: 'express', filePath: 'package.json' },
    ];
    expect(detectIacPresence(techEvidence)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. monitoring-config
// ---------------------------------------------------------------------------

describe('monitoring-config', () => {
  it('fires on a Grafana dashboard JSON with a panels key (path AND content match)', () => {
    const src = '{ "title": "Overview", "panels": [{ "id": 1 }] }';
    expect(only('monitoring-config', detectConceptFilePatterns('grafana/dashboards/overview.json', src))).toEqual([
      { conceptAlias: 'observability', detector: 'monitoring-config', filePath: 'grafana/dashboards/overview.json', confidence: 1.0 },
    ]);
  });

  it('fires on prometheus.yml with scrape_configs:', () => {
    const src = ['global:', '  scrape_interval: 15s', 'scrape_configs:', '  - job_name: app'].join('\n');
    expect(only('monitoring-config', detectConceptFilePatterns('monitoring/prometheus.yml', src))).toHaveLength(1);
  });

  it('fires on an alertmanager rules file with groups:', () => {
    const src = ['groups:', '  - name: alerts', '    rules:', '      - alert: HighCpu'].join('\n');
    expect(only('monitoring-config', detectConceptFilePatterns('alerting/rules.yaml', src))).toHaveLength(1);
  });

  it('near-miss: does NOT fire on a matching path with unrelated content (path matches, content does not)', () => {
    const src = 'This directory holds the Grafana dashboards for the ops team.';
    expect(only('monitoring-config', detectConceptFilePatterns('grafana/dashboards/README.md', src))).toEqual([]);
  });

  it('near-miss: does NOT fire on matching content in an unrelated path (content matches, path does not)', () => {
    const src = '{ "panels": [{ "id": 1 }] }';
    expect(only('monitoring-config', detectConceptFilePatterns('src/widgets/layout.json', src))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. runbooks
// ---------------------------------------------------------------------------

describe('runbooks', () => {
  it('fires on any markdown file under a runbooks/ dir', () => {
    const src = '# Redis outage\n\nHow to fix it.';
    expect(only('runbooks', detectConceptFilePatterns('runbooks/redis-outage.md', src))).toEqual([
      { conceptAlias: 'incident response', detector: 'runbooks', filePath: 'runbooks/redis-outage.md', confidence: 1.0 },
    ]);
  });

  it('fires on any markdown file under docs/runbooks/', () => {
    const src = '# Notes';
    expect(only('runbooks', detectConceptFilePatterns('docs/runbooks/db-failover.md', src))).toHaveLength(1);
  });

  it('fires on a markdown doc whose first 30 lines carry BOTH severity and an alert/on-call/incident token', () => {
    const src = ['# High latency', '', 'Severity: SEV-2', '', 'Triggered by the on-call alert for p99 latency.'].join('\n');
    expect(only('runbooks', detectConceptFilePatterns('docs/high-latency.md', src))).toHaveLength(1);
  });

  it('near-miss: does NOT fire on a non-markdown file even under runbooks/', () => {
    const src = '{"title":"redis outage"}';
    expect(only('runbooks', detectConceptFilePatterns('runbooks/redis-outage.json', src))).toEqual([]);
  });

  it('near-miss: does NOT fire on a generic markdown doc mentioning only "severity" (both-token rule)', () => {
    const src = ['# Bug triage', '', 'We label bugs with a severity field: low/medium/high.'].join('\n');
    expect(only('runbooks', detectConceptFilePatterns('docs/triage.md', src))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. secrets-config
// ---------------------------------------------------------------------------

describe('secrets-config', () => {
  it('fires on an ExternalSecret manifest (kind: sniff)', () => {
    const src = ['apiVersion: external-secrets.io/v1', 'kind: ExternalSecret', 'metadata:', '  name: db-creds'].join('\n');
    expect(only('secrets-config', detectConceptFilePatterns('k8s/external-secret.yaml', src))).toEqual([
      { conceptAlias: 'secrets management', detector: 'secrets-config', filePath: 'k8s/external-secret.yaml', confidence: 1.0 },
    ]);
  });

  it('fires on an exact vault.hcl filename match', () => {
    expect(only('secrets-config', detectConceptFilePatterns('config/vault.hcl', 'path "secret/*" { capabilities = ["read"] }'))).toHaveLength(1);
  });

  it('fires on an exact .sops.yaml filename match', () => {
    expect(only('secrets-config', detectConceptFilePatterns('.sops.yaml', 'creation_rules:\n  - pgp: abc'))).toHaveLength(1);
  });

  it('near-miss: does NOT fire on a generic Secret (not ExternalSecret/SecretStore) manifest', () => {
    const src = ['apiVersion: v1', 'kind: Secret', 'metadata:', '  name: opaque'].join('\n');
    expect(only('secrets-config', detectConceptFilePatterns('k8s/secret.yaml', src))).toEqual([]);
  });

  it('near-miss: does NOT fire on a file merely named "vault-notes.md"', () => {
    expect(only('secrets-config', detectConceptFilePatterns('docs/vault-notes.md', '# Vault setup notes'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. broker-topology (aggregate, both-condition)
// ---------------------------------------------------------------------------

describe('broker-topology', () => {
  const brokerTech: ConceptTechEvidence[] = [
    { sourceLayer: 'iac', canonicalName: 'kafka', filePath: 'k8s/kafka.yaml' },
  ];

  it('fires when >=2 compose services AND a broker evidence row are both present', async () => {
    const compose = ['services:', '  api:', '    image: myapp/api', '  worker:', '    image: myapp/worker'].join('\n');
    const files = ['docker-compose.yaml'];
    const readFile = async (rel: string) => (rel === 'docker-compose.yaml' ? compose : null);
    expect(await detectBrokerTopology(files, readFile, brokerTech)).toEqual([
      { conceptAlias: 'distributed systems', detector: 'broker-topology', filePath: 'k8s/kafka.yaml', confidence: 1.0 },
    ]);
  });

  it('fires when >=2 k8s Deployment docs AND a broker evidence row are both present', async () => {
    const deployA = ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: api'].join('\n');
    const deployB = ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: worker'].join('\n');
    const files = ['k8s/api.yaml', 'k8s/worker.yaml'];
    const readFile = async (rel: string) => (rel === 'k8s/api.yaml' ? deployA : rel === 'k8s/worker.yaml' ? deployB : null);
    expect(await detectBrokerTopology(files, readFile, brokerTech)).toHaveLength(1);
  });

  it('near-miss: single-condition — 2 service manifests but NO broker evidence row', async () => {
    const compose = ['services:', '  api:', '    image: myapp/api', '  worker:', '    image: myapp/worker'].join('\n');
    const files = ['docker-compose.yaml'];
    const readFile = async () => compose;
    expect(await detectBrokerTopology(files, readFile, [])).toEqual([]);
  });

  it('near-miss: single-condition — a broker evidence row but only 1 service manifest', async () => {
    const compose = ['services:', '  api:', '    image: myapp/api'].join('\n');
    const files = ['docker-compose.yaml'];
    const readFile = async () => compose;
    expect(await detectBrokerTopology(files, readFile, brokerTech)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. scheduled-automation
// ---------------------------------------------------------------------------

describe('scheduled-automation', () => {
  it('fires on a CronJob manifest', () => {
    const src = ['apiVersion: batch/v1', 'kind: CronJob', 'metadata:', '  name: nightly-cleanup'].join('\n');
    expect(only('scheduled-automation', detectConceptFilePatterns('k8s/cronjob.yaml', src))).toEqual([
      { conceptAlias: 'process automation', detector: 'scheduled-automation', filePath: 'k8s/cronjob.yaml', confidence: 1.0 },
    ]);
  });

  it('fires on a workflow file with an on.schedule trigger', () => {
    const src = ['on:', '  schedule:', '    - cron: "0 3 * * *"', 'jobs:', '  nightly:', '    runs-on: ubuntu-latest'].join('\n');
    expect(only('scheduled-automation', detectConceptFilePatterns('.github/workflows/nightly.yaml', src))).toHaveLength(1);
  });

  it('near-miss: does NOT fire on a Job (not CronJob) manifest', () => {
    const src = ['apiVersion: batch/v1', 'kind: Job', 'metadata:', '  name: one-off'].join('\n');
    expect(only('scheduled-automation', detectConceptFilePatterns('k8s/job.yaml', src))).toEqual([]);
  });

  it('near-miss: does NOT fire on a workflow file triggered only by push (no schedule)', () => {
    const src = ['on: push', 'jobs:', '  build:', '    runs-on: ubuntu-latest'].join('\n');
    expect(only('scheduled-automation', detectConceptFilePatterns('.github/workflows/ci.yaml', src))).toEqual([]);
  });

  // Real-shape regression: live repos declare CronJobs as Helm templates. `{{ }}`
  // interpolations break strict YAML parsing (verified: `tryParseYamlObject` returns
  // null, several "Block collections are not allowed within flow collections" /
  // "Missing , or : between flow map items" errors) -- before this fix the detector
  // returned null right there and never saw `kind: CronJob`, which is why it could
  // structurally never fire against a real Helm chart.
  it('fires on a Helm-templated CronJob manifest (fails strict YAML parse, sniffed by literal kind: line)', () => {
    const src = [
      'apiVersion: batch/v1',
      'kind: CronJob',
      'metadata:',
      '  name: {{ include "myapp.fullname" . }}',
      '  labels:',
      '    {{- include "myapp.labels" . | nindent 4 }}',
      'spec:',
      '  schedule: "{{ .Values.cron.schedule }}"',
      '  jobTemplate:',
      '    spec:',
      '      template:',
      '        spec:',
      '          containers:',
      '            - name: {{ .Chart.Name }}',
      '              image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"',
      '              {{- if .Values.env }}',
      '              env:',
      '                {{- toYaml .Values.env | nindent 16 }}',
      '              {{- end }}',
      '          restartPolicy: OnFailure',
    ].join('\n');
    expect(only('scheduled-automation', detectConceptFilePatterns('charts/myapp/templates/cronjob.yaml', src))).toEqual([
      { conceptAlias: 'process automation', detector: 'scheduled-automation', filePath: 'charts/myapp/templates/cronjob.yaml', confidence: 1.0 },
    ]);
  });

  it('near-miss: does NOT fire on a Helm-templated Deployment manifest (same parse failure, no CronJob kind line)', () => {
    const src = [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: {{ include "myapp.fullname" . }}',
      '  labels:',
      '    {{- include "myapp.labels" . | nindent 4 }}',
      'spec:',
      '  replicas: {{ .Values.replicaCount }}',
      '  template:',
      '    spec:',
      '      containers:',
      '        - name: {{ .Chart.Name }}',
      '          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"',
      '          {{- if .Values.env }}',
      '          env:',
      '            {{- toYaml .Values.env | nindent 12 }}',
      '          {{- end }}',
    ].join('\n');
    expect(only('scheduled-automation', detectConceptFilePatterns('charts/myapp/templates/deployment.yaml', src))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 10. migrations-dir (aggregate)
// ---------------------------------------------------------------------------

describe('migrations-dir', () => {
  it('fires once for a directory with >=3 numbered SQL migration files', () => {
    const files = ['migrations/001_init.sql', 'migrations/002_add_users.sql', 'migrations/003_add_index.sql', 'src/app.ts'];
    expect(detectMigrationsDir(files)).toEqual([
      { conceptAlias: 'database migrations', detector: 'migrations-dir', filePath: 'migrations/001_init.sql', confidence: 1.0 },
    ]);
  });

  it('near-miss: does NOT fire when a directory has only 2 numbered SQL files (count threshold)', () => {
    const files = ['migrations/001_init.sql', 'migrations/002_add_users.sql'];
    expect(detectMigrationsDir(files)).toEqual([]);
  });

  // Real-shape regression: the unit tests above pass a synthetic path list straight
  // to detectMigrationsDir, which masked a real bug -- `walkTextFiles` (fileWalk.ts)
  // never had `.sql` in TEXT_EXT, so on an ACTUAL repo tree the walk never surfaced
  // migration files to this detector at all, no matter the count. Exercise the real
  // filesystem walk end to end to prove the fix.
  describe('via a real walkTextFiles() scan (not a synthetic list)', () => {
    let root: string;

    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'concept-migrations-'));
    });

    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    it('fires migrations-dir for a real trio of numbered .sql files on disk', async () => {
      const dir = path.join(root, 'applications', 'x', 'migrations');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, '001_a.sql'), 'CREATE TABLE a (id int);\n');
      await fs.writeFile(path.join(dir, '002_b.sql'), 'CREATE TABLE b (id int);\n');
      await fs.writeFile(path.join(dir, '003_c.sql'), 'CREATE TABLE c (id int);\n');

      const walked = await walkTextFiles(root);
      expect(walked).toEqual(expect.arrayContaining([
        'applications/x/migrations/001_a.sql',
        'applications/x/migrations/002_b.sql',
        'applications/x/migrations/003_c.sql',
      ]));
      expect(detectMigrationsDir(walked)).toEqual([
        { conceptAlias: 'database migrations', detector: 'migrations-dir', filePath: 'applications/x/migrations/001_a.sql', confidence: 1.0 },
      ]);
    });

    it('near-miss: does NOT fire for only 2 real .sql files on disk', async () => {
      const dir = path.join(root, 'applications', 'x', 'migrations');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, '001_a.sql'), 'CREATE TABLE a (id int);\n');
      await fs.writeFile(path.join(dir, '002_b.sql'), 'CREATE TABLE b (id int);\n');

      const walked = await walkTextFiles(root);
      expect(detectMigrationsDir(walked)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Extractor wiring
// ---------------------------------------------------------------------------

describe('ConceptPatternExtractor.extract', () => {
  it('combines per-file and aggregate detectors over the whole input', async () => {
    const files = ['.github/workflows/ci.yaml', 'migrations/001_a.sql', 'migrations/002_b.sql', 'migrations/003_c.sql'];
    const fileContents: Record<string, string> = {
      '.github/workflows/ci.yaml': ['on: push', 'jobs:', '  build:', '    runs-on: ubuntu-latest'].join('\n'),
    };
    const techEvidence: ConceptTechEvidence[] = [
      { sourceLayer: 'iac', canonicalName: 'kubernetes', filePath: 'k8s/deploy.yaml' },
    ];
    const extractor = new ConceptPatternExtractor();
    const out = await extractor.extract({
      files, readFile: async (rel) => fileContents[rel] ?? null, techEvidence,
    });
    const detectors = out.map((r) => r.detector).sort();
    expect(detectors).toEqual(['iac-presence', 'k8s-orchestration', 'migrations-dir', 'workflow-ci']);
  });
});
