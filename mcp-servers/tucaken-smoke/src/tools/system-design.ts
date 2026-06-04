/** @format */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionLogger } from '../logger.js';
import type { RdsClient, CleanupTarget } from '../../../../scripts/smoke/lib/index.js';
import { AdminApiClient } from '../../../../scripts/smoke/lib/index.js';
import { tool } from './register.js';
import { session, requireAuth } from '../session.js';
import { connectDev } from './primitives.js';
import { validateSystemDesign } from '../validators.js';

// project_components.kind CHECK enum (migration 030_projects.sql).
const COMPONENT_KINDS = [
  'frontend', 'backend', 'infra', 'mobile', 'data', 'ml', 'docs', 'shared',
] as const;

const ComponentInput = z.object({
  name: z.string().min(1),
  kind: z.enum(COMPONENT_KINDS),
});

interface SeedComponent { name: string; kind: string }
interface SeedArgs { projectName?: string; components: SeedComponent[] }

/** A stable-but-unique slug for the seeded project. projects.slug is
 *  NOT NULL and UNIQUE per user, so suffix a timestamp to avoid collisions
 *  across repeated smoke runs. */
function slugFor(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'project';
  return `smoke-${base}-${Date.now()}`;
}

/** INSERT the project row for the test user; returns its id. */
async function insertProject(client: RdsClient, userId: string, name: string): Promise<string> {
  const rows = await client.assertRows(
    `INSERT INTO projects (user_id, slug, name, is_ai_suggested, is_user_confirmed)
     VALUES ($1, $2, $3, FALSE, TRUE) RETURNING id`,
    [userId, slugFor(name), name], 'seed project',
  );
  return (rows[0] as { id: string }).id;
}

/** INSERT each component (user_id + project_id + name + kind, all NOT NULL). */
async function insertComponents(
  client: RdsClient, userId: string, projectId: string, components: SeedComponent[],
): Promise<number> {
  for (const c of components) {
    await client.assertRows(
      `INSERT INTO project_components (user_id, project_id, name, kind)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, projectId, c.name, c.kind], `seed component ${c.name}`,
    );
  }
  return components.length;
}

async function handleSeed(args: SeedArgs): Promise<{ projectId: string; components: number }> {
  const { testUserId } = requireAuth();
  const name = args.projectName ?? 'Smoke System Design Project';
  const client = await connectDev();
  try {
    const projectId = await insertProject(client, testUserId, name);
    const components = await insertComponents(client, testUserId, projectId, args.components);
    const target: CleanupTarget = { flow: 'ingestion', s3Keys: [], projectId };
    session.cleanup.push(target);
    return { projectId, components };
  } finally {
    await client.close();
  }
}

// --- flow tools (dispatch Bedrock-spending pipelines) -----------------------
//
// These trigger real Bedrock spend, so they are gated behind `confirm:true`.
// Without it they are a no-op (no auth, no admin-api call, no DB write).

const SKIPPED = { skipped: true, reason: 'confirm:true required — triggers Bedrock spend' } as const;
type Skipped = typeof SKIPPED;

const RUN_TIMEOUT_MS = 600000;
const RUN_INTERVAL_MS = 5000;

interface RunStrategistArgs { company: string; role: string; jobDescription: string; confirm: boolean }
interface RunCoachArgs { slug: string; interviewStage: string; confirm: boolean }

/** Build an AdminApiClient bound to the session's admin-api base url + JWT. */
function adminApi(): AdminApiClient {
  const { endpoints, idToken } = requireAuth();
  return new AdminApiClient(endpoints.adminApiBaseUrl, idToken);
}

/** Look up the application row created by the strategist run, scoped to the
 *  resolved platform user. When applicationId is known we pin to it; otherwise
 *  we take the most recent. Returns the row or null. */
async function findApplication(
  client: RdsClient, userId: string, applicationId: string | undefined,
): Promise<unknown> {
  const rows = await client.maybeRows(
    `SELECT id, slug FROM job_applications
     WHERE user_id = $1 AND ($2::uuid IS NULL OR id = $2)
     ORDER BY created_at DESC LIMIT 1`,
    [userId, applicationId ?? null],
  );
  return rows[0] ?? null;
}

async function handleRunStrategist(
  args: RunStrategistArgs,
): Promise<Skipped | { pipelineRunId: string; status: string; application: unknown }> {
  if (args.confirm !== true) return SKIPPED;
  requireAuth();
  const { pipelineRunId, applicationId } = await adminApi().startStrategist({
    targetCompany: args.company, targetRole: args.role, jobDescription: args.jobDescription,
  });
  const target: CleanupTarget = { flow: 'job-strategist', pipelineRunId, applicationId, s3Keys: [] };
  session.cleanup.push(target);
  const client = await connectDev();
  try {
    const status = await client.waitForPipelineStatus(pipelineRunId, RUN_TIMEOUT_MS, RUN_INTERVAL_MS);
    const { testUserId } = requireAuth();
    const application = await findApplication(client, testUserId, applicationId);
    return { pipelineRunId, status, application };
  } finally {
    await client.close();
  }
}

async function handleRunCoach(
  args: RunCoachArgs,
): Promise<Skipped | { pipelineRunId: string; status: string }> {
  if (args.confirm !== true) return SKIPPED;
  requireAuth();
  const { pipelineRunId } = await adminApi().startCoach(args.slug, args.interviewStage);
  const target: CleanupTarget = { flow: 'job-strategist', pipelineRunId, slug: args.slug, s3Keys: [] };
  session.cleanup.push(target);
  const client = await connectDev();
  try {
    const status = await client.waitForPipelineStatus(pipelineRunId, RUN_TIMEOUT_MS, RUN_INTERVAL_MS);
    return { pipelineRunId, status };
  } finally {
    await client.close();
  }
}

interface AssertSystemDesignArgs { slug: string; tier: 'A' | 'B'; applicationId: string }

// The validator's `Coaching` shape is structural; pass the extracted payload.
type CoachResult = Parameters<typeof validateSystemDesign>[1];

/** The admin-api GET /:slug/coaching/:stage wraps the InterviewCoachResult
 *  (topics_to_study) under `coaching`. Stay robust to alternate shapes
 *  (topics_to_study / topicsToStudy / the row directly). */
function extractCoachResult(resp: unknown): CoachResult {
  const r = (resp ?? {}) as Record<string, unknown>;
  const payload = r.coaching ?? r.topics_to_study ?? r.topicsToStudy ?? resp;
  return (payload ?? {}) as CoachResult;
}

async function handleAssertSystemDesign(
  args: AssertSystemDesignArgs,
): Promise<{ tier: 'A' | 'B'; verdict: ReturnType<typeof validateSystemDesign>; coaching: CoachResult }> {
  requireAuth();
  const resp = await adminApi().getCoaching(args.slug, 'system-design', args.applicationId);
  const coaching = extractCoachResult(resp);
  const verdict = validateSystemDesign(args.tier, coaching);
  return { tier: args.tier, verdict, coaching };
}

export function registerSystemDesign(server: McpServer, logger: SessionLogger): void {
  tool(server, logger, 'smoke_seed_project_evidence', {
    projectName: z.string().optional(),
    components: z.array(ComponentInput).min(1),
  }, (args) => handleSeed(args as unknown as SeedArgs));

  tool(server, logger, 'smoke_run_strategist', {
    company: z.string(), role: z.string(), jobDescription: z.string(), confirm: z.boolean(),
  }, (args) => handleRunStrategist(args as unknown as RunStrategistArgs));

  tool(server, logger, 'smoke_run_coach', {
    slug: z.string(), interviewStage: z.string(), confirm: z.boolean(),
  }, (args) => handleRunCoach(args as unknown as RunCoachArgs));

  tool(server, logger, 'smoke_assert_system_design', {
    slug: z.string(), tier: z.enum(['A', 'B']), applicationId: z.string(),
  }, (args) => handleAssertSystemDesign(args as unknown as AssertSystemDesignArgs));
}
