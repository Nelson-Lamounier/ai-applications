/** @format
 *
 * Concept detectors (P2 cutover, Task 2) — deterministic, per-file (plus a
 * handful of repo-wide aggregate) detectors that surface higher-level
 * "concept" evidence (`concept_evidence`, migration 123) distinct from the
 * technology_evidence tech lane: CI/CD pipelines, container orchestration,
 * infrastructure as code, observability, incident response, secrets
 * management, distributed systems, process automation, database migrations.
 *
 * Same DSA-discipline as `DsaPatternExtractor.ts`: every detector is
 * necessary-not-sufficient, FP-guarded, and covered by a firing fixture +
 * a near-miss non-firing fixture.
 *
 * Aggregate detectors (`iac-presence`, `k8s-orchestration`, `broker-topology`)
 * consume `techEvidence` — the tech lane's already-resolved evidence rows for
 * this run (`{ sourceLayer, canonicalName, filePath }`) — instead of
 * re-parsing manifests the tech lane already parsed. `runFactsStage` (Task 3)
 * wires this from its `EvidenceKey[]` (`sourceLayer` + resolved canonical
 * name + `filePath`).
 */
import { parseDocument, parseAllDocuments } from 'yaml';

export interface RawConceptEvidence {
  readonly conceptAlias: string;
  readonly detector: string;
  readonly filePath: string;
  readonly lineStart?: number;
  readonly confidence: number;
}

/** One tech-lane evidence row, as computed this run (Task 3 wires this from EvidenceKey[]). */
export interface ConceptTechEvidence {
  readonly sourceLayer: string;
  readonly canonicalName: string;
  readonly filePath: string;
}

export interface ConceptPatternExtractorInput {
  readonly files: string[];
  readonly readFile: (rel: string) => Promise<string | null>;
  readonly techEvidence: ConceptTechEvidence[];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Parse YAML text to a plain object; returns null on parse failure or non-object result
 *  (e.g. a Jenkinsfile's Groovy DSL either throws or resolves to a bare scalar string —
 *  either way it is NOT a YAML mapping, so detectors keyed on YAML keys never fire). */
function tryParseYamlObject(src: string): Record<string, unknown> | null {
  try {
    const doc = parseDocument(src, { prettyErrors: false });
    if (doc.errors.length > 0) return null;
    const obj = doc.toJSON();
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const WORKFLOW_DIR = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i;

/** Files eligible for the two workflow detectors: GH Actions workflows, GitLab CI, Jenkinsfile. */
function isWorkflowPath(rel: string): boolean {
  const base = rel.split('/').pop() ?? '';
  return WORKFLOW_DIR.test(rel) || base === '.gitlab-ci.yml' || base === 'Jenkinsfile';
}

/** FP guard shared by workflow-ci / workflow-deploy: never fire on docs/fixtures. */
const EXCLUDED_PATH = /(^|\/)(__tests__|fixtures)\//i;
function isExcludedWorkflowPath(rel: string): boolean {
  return EXCLUDED_PATH.test(rel) || rel.toLowerCase().endsWith('.md');
}

/** A workflow doc must actually declare jobs/stages to count as a real pipeline. */
function asWorkflowDoc(rel: string, content: string): Record<string, unknown> | null {
  if (!isWorkflowPath(rel) || isExcludedWorkflowPath(rel)) return null;
  const obj = tryParseYamlObject(content);
  if (!obj) return null;
  if (!('jobs' in obj) && !('stages' in obj)) return null;
  return obj;
}

// ---------------------------------------------------------------------------
// Per-file detectors
// ---------------------------------------------------------------------------

type FileDetector = (filePath: string, content: string) => RawConceptEvidence | null;

/** workflow-ci -> 'ci/cd pipelines': a workflow/CI file that parses as YAML with jobs:/stages:. */
const workflowCi: FileDetector = (rel, content) => {
  if (!asWorkflowDoc(rel, content)) return null;
  return { conceptAlias: 'ci/cd pipelines', detector: 'workflow-ci', filePath: rel, confidence: 1.0 };
};

const DEPLOY_MARKER = /\b(deploy|ecr|helm\s+upgrade|kubectl\s+apply|argocd)\b/i;

/** Trimmed, non-comment lines from one `run:`/`uses:` step value. */
function actionableLines(scriptValue: string): string[] {
  return scriptValue
    .split('\n')
    .map((line) => line.trim())
    .filter((trimmed) => trimmed && !trimmed.startsWith('#'));
}

/** Collect trimmed, non-comment lines from every `run:`/`uses:` step value in a workflow doc. */
function collectStepLines(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectStepLines(n, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if ((k === 'run' || k === 'uses') && typeof v === 'string') out.push(...actionableLines(v));
    else collectStepLines(v, out);
  }
}

/** workflow-deploy -> 'ci/cd pipelines' (distinct detector from workflow-ci): a deploy marker
 *  inside an actionable `run:`/`uses:` step line (comments inside the script are stripped first). */
const workflowDeploy: FileDetector = (rel, content) => {
  const doc = asWorkflowDoc(rel, content);
  if (!doc) return null;
  const lines: string[] = [];
  collectStepLines(doc, lines);
  if (!lines.some((l) => DEPLOY_MARKER.test(l))) return null;
  return { conceptAlias: 'ci/cd pipelines', detector: 'workflow-deploy', filePath: rel, confidence: 1.0 };
};

const MONITORING_PATH = /(grafana|dashboards\/|alert|prometheus\.ya?ml|alloy|otel-collector)/i;
const MONITORING_CONTENT = /("panels"\s*:|'panels'\s*:|\bpanels\s*:|\bgroups\s*:|\breceivers\s*:|\bscrape_configs\s*:)/;

/** monitoring-config -> 'observability': Grafana/alerting/Prometheus/otel path AND content sniff. */
const monitoringConfig: FileDetector = (rel, content) => {
  if (!MONITORING_PATH.test(rel)) return null;
  if (!MONITORING_CONTENT.test(content)) return null;
  return { conceptAlias: 'observability', detector: 'monitoring-config', filePath: rel, confidence: 1.0 };
};

const RUNBOOKS_DIR = /(^|\/)(docs\/)?runbooks\//i;
const RUNBOOK_SEVERITY = /\bseverity\b/;
const RUNBOOK_CONTEXT = /\balert\b|\bon-?call\b|\bincident\b/;

/** runbooks -> 'incident response': markdown only. Either under a runbooks/ dir, or the
 *  first 30 lines carry BOTH `severity` and an alert/on-call/incident token (both-token
 *  rule — a single generic mention of "severity" in an unrelated doc never fires). */
const runbooks: FileDetector = (rel, content) => {
  if (!rel.toLowerCase().endsWith('.md')) return null;
  if (RUNBOOKS_DIR.test(rel)) {
    return { conceptAlias: 'incident response', detector: 'runbooks', filePath: rel, confidence: 1.0 };
  }
  const first30 = content.split('\n').slice(0, 30).join('\n').toLowerCase();
  if (RUNBOOK_SEVERITY.test(first30) && RUNBOOK_CONTEXT.test(first30)) {
    return { conceptAlias: 'incident response', detector: 'runbooks', filePath: rel, confidence: 1.0 };
  }
  return null;
};

const SECRET_KINDS = new Set(['ExternalSecret', 'SecretStore', 'ClusterSecretStore']);
const SECRET_FILENAMES = new Set(['vault.hcl', '.sops.yaml', 'sops.yaml']);

/** secrets-config -> 'secrets management': ExternalSecret/SecretStore kind: sniff, or an
 *  exact vault/SOPS config filename match. */
const secretsConfig: FileDetector = (rel, content) => {
  const base = (rel.split('/').pop() ?? '').toLowerCase();
  if (SECRET_FILENAMES.has(base)) {
    return { conceptAlias: 'secrets management', detector: 'secrets-config', filePath: rel, confidence: 1.0 };
  }
  if (!/\.ya?ml$/i.test(rel)) return null;
  const obj = tryParseYamlObject(content);
  const kind = obj?.['kind'];
  if (typeof kind === 'string' && SECRET_KINDS.has(kind)) {
    return { conceptAlias: 'secrets management', detector: 'secrets-config', filePath: rel, confidence: 1.0 };
  }
  return null;
};

/** scheduled-automation -> 'process automation': a CronJob manifest, or a workflow file
 *  with an `on.schedule` trigger. */
const scheduledAutomation: FileDetector = (rel, content) => {
  if (!/\.ya?ml$/i.test(rel)) return null;
  const obj = tryParseYamlObject(content);
  if (!obj) return null;
  if (obj['kind'] === 'CronJob') {
    return { conceptAlias: 'process automation', detector: 'scheduled-automation', filePath: rel, confidence: 1.0 };
  }
  if (isWorkflowPath(rel) && !isExcludedWorkflowPath(rel)) {
    const on = obj['on'];
    if (on && typeof on === 'object' && !Array.isArray(on) && 'schedule' in (on as Record<string, unknown>)) {
      return { conceptAlias: 'process automation', detector: 'scheduled-automation', filePath: rel, confidence: 1.0 };
    }
  }
  return null;
};

const FILE_DETECTORS: FileDetector[] = [
  workflowCi, workflowDeploy, monitoringConfig, runbooks, secretsConfig, scheduledAutomation,
];

/** Pure: run every per-file detector over one file's content. Exported for per-detector testing. */
export function detectConceptFilePatterns(filePath: string, content: string): RawConceptEvidence[] {
  const out: RawConceptEvidence[] = [];
  for (const d of FILE_DETECTORS) {
    const hit = d(filePath, content);
    if (hit) out.push(hit);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregate detectors
// ---------------------------------------------------------------------------

const K8S_ORCH_CANONICALS = new Set(['kubernetes', 'argocd']);

/** k8s-orchestration -> 'container orchestration': reuses the tech lane's already-resolved
 *  IaC evidence (K8sManifestParser / ArgoHelmParser) rather than re-parsing manifests — a
 *  'kubernetes'/'argocd' README *mention* carries source_layer 'readme', not 'iac', so it
 *  is excluded by construction. */
export function detectK8sOrchestration(techEvidence: readonly ConceptTechEvidence[]): RawConceptEvidence[] {
  const seen = new Set<string>();
  const out: RawConceptEvidence[] = [];
  for (const e of techEvidence) {
    if (e.sourceLayer !== 'iac') continue;
    if (!K8S_ORCH_CANONICALS.has(e.canonicalName.toLowerCase())) continue;
    if (seen.has(e.filePath)) continue;
    seen.add(e.filePath);
    out.push({ conceptAlias: 'container orchestration', detector: 'k8s-orchestration', filePath: e.filePath, confidence: 1.0 });
  }
  return out;
}

/** iac-presence -> 'infrastructure as code': fires once per repo, only when the tech lane
 *  computed at least one real 'iac' source-layer evidence row this run. */
export function detectIacPresence(techEvidence: readonly ConceptTechEvidence[]): RawConceptEvidence[] {
  const first = techEvidence.find((e) => e.sourceLayer === 'iac');
  if (!first) return [];
  return [{ conceptAlias: 'infrastructure as code', detector: 'iac-presence', filePath: first.filePath, confidence: 1.0 }];
}

const MIGRATION_FILE = /^\d+_.*\.sql$/;

/** migrations-dir -> 'database migrations': >=3 numbered SQL files in one directory
 *  (count threshold prevents a single ad-hoc script firing). */
export function detectMigrationsDir(files: readonly string[]): RawConceptEvidence[] {
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const base = f.split('/').pop() ?? '';
    if (!MIGRATION_FILE.test(base)) continue;
    const dir = f.slice(0, f.length - base.length - 1) || '.';
    const list = byDir.get(dir) ?? [];
    list.push(f);
    byDir.set(dir, list);
  }
  const out: RawConceptEvidence[] = [];
  for (const list of byDir.values()) {
    if (list.length < 3) continue;
    const first = [...list].sort((a, b) => a.localeCompare(b))[0];
    out.push({ conceptAlias: 'database migrations', detector: 'migrations-dir', filePath: first, confidence: 1.0 });
  }
  return out;
}

const MESSAGE_BROKER_CANONICALS = new Set(['kafka', 'rabbitmq', 'aws_sqs', 'aws_sns', 'aws_eventbridge']);
const COMPOSE_FILE = /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/i;

/** Count docker-compose `services:` entries declared in one compose file. */
function countComposeServices(content: string): number {
  const services = tryParseYamlObject(content)?.['services'];
  return services && typeof services === 'object' && !Array.isArray(services) ? Object.keys(services).length : 0;
}

/** Count k8s `kind: Deployment` documents declared in one (possibly multi-doc) manifest file. */
function countK8sDeployments(content: string): number {
  let docs;
  try {
    docs = parseAllDocuments(content);
  } catch {
    return 0;
  }
  let count = 0;
  for (const d of docs) {
    let obj: unknown;
    try {
      obj = d.toJSON();
    } catch {
      continue;
    }
    if (obj && typeof obj === 'object' && (obj as Record<string, unknown>)['kind'] === 'Deployment') count += 1;
  }
  return count;
}

/** Count distinct "service manifests" across the repo: docker-compose services + k8s
 *  Deployment documents (each is one deployable service). */
async function countServiceManifests(
  files: readonly string[], readFile: (rel: string) => Promise<string | null>,
): Promise<number> {
  let count = 0;
  for (const rel of files) {
    if (!/\.ya?ml$/i.test(rel)) continue;
    const content = await readFile(rel);
    if (content === null) continue;
    count += COMPOSE_FILE.test(rel) ? countComposeServices(content) : countK8sDeployments(content);
  }
  return count;
}

/** broker-topology -> 'distributed systems': aggregate, BOTH conditions required —
 *  >= 2 distinct service manifests (compose services or k8s Deployments) AND >= 1
 *  message-broker/queue technology evidence row computed this run. */
export async function detectBrokerTopology(
  files: readonly string[],
  readFile: (rel: string) => Promise<string | null>,
  techEvidence: readonly ConceptTechEvidence[],
): Promise<RawConceptEvidence[]> {
  const broker = techEvidence.find((e) => MESSAGE_BROKER_CANONICALS.has(e.canonicalName.toLowerCase()));
  if (!broker) return [];
  const serviceCount = await countServiceManifests(files, readFile);
  if (serviceCount < 2) return [];
  return [{ conceptAlias: 'distributed systems', detector: 'broker-topology', filePath: broker.filePath, confidence: 1.0 }];
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export class ConceptPatternExtractor {
  readonly name = 'concept-pattern';

  async extract(input: ConceptPatternExtractorInput): Promise<RawConceptEvidence[]> {
    const { files, readFile, techEvidence } = input;
    const perFile: RawConceptEvidence[] = [];
    for (const rel of files) {
      const content = await readFile(rel);
      if (content === null) continue;
      perFile.push(...detectConceptFilePatterns(rel, content));
    }
    return [
      ...perFile,
      ...detectK8sOrchestration(techEvidence),
      ...detectIacPresence(techEvidence),
      ...detectMigrationsDir(files),
      ...(await detectBrokerTopology(files, readFile, techEvidence)),
    ];
  }
}
