/** @format */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionLogger } from '../logger.js';
import type { RdsClient, CleanupTarget } from '../../../../scripts/smoke/lib/index.js';
import { tool } from './register.js';
import { session, requireAuth } from '../session.js';
import { connectDev } from './primitives.js';

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

export function registerSystemDesign(server: McpServer, logger: SessionLogger): void {
  tool(server, logger, 'smoke_seed_project_evidence', {
    projectName: z.string().optional(),
    components: z.array(ComponentInput).min(1),
  }, (args) => handleSeed(args as unknown as SeedArgs));
}
