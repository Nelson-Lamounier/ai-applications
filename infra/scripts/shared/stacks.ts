/**
 * Stack Configuration — CDK Layer
 *
 * Registers bedrock and self-healing projects into the shared
 * `@repo/script-utils/stacks.js` registry at import time.
 *
 * Consumer scripts import from this file. It re-exports everything
 * from the shared module so existing `./stacks.js` imports work unchanged.
 */

export {
  type DefaultConfig,
  type Environment,
  type ExtraContext,
  type ProjectConfig,
  type StackConfig,
  defaults,
  getAllStacksForProject,
  getEffectiveStacks,
  getProject,
  getRequiredContextMessage,
  getRequiredStacksForProject,
  getStack,
  isCloudFrontStack,
  profileMap,
  projectsMap,
} from '@repo/script-utils/stacks.js';

import {
  registerProject,
  type Environment,
  type StackConfig,
} from '@repo/script-utils/stacks.js';

import { Project } from '../../lib/config/projects.js';
import { getStackId } from '../../lib/utilities/naming.js';

// =============================================================================
// BEDROCK PROJECT
// =============================================================================

const bedrockStacks: StackConfig[] = [
  {
    id: 'data',
    name: 'Bedrock Data Stack',
    getStackName: (env) => getStackId(Project.BEDROCK, 'data', env),
    description: 'DynamoDB tables and S3 buckets for Bedrock AI applications',
  },
  {
    id: 'kb',
    name: 'Knowledge Base Stack',
    getStackName: (env) => getStackId(Project.BEDROCK, 'kb', env),
    description: 'Bedrock Knowledge Base with OpenSearch Serverless',
    dependsOn: ['data'],
  },
  {
    id: 'agent',
    name: 'Bedrock Agent Stack',
    getStackName: (env) => getStackId(Project.BEDROCK, 'agent', env),
    description: 'Bedrock Agent with action groups',
    dependsOn: ['kb'],
  },
  {
    id: 'api',
    name: 'Bedrock API Stack',
    getStackName: (env) => getStackId(Project.BEDROCK, 'api', env),
    description: 'API Gateway + Lambda for Bedrock AI endpoints',
    dependsOn: ['data'],
  },
  {
    id: 'content',
    name: 'Content Pipeline Stack',
    getStackName: (env) => getStackId(Project.BEDROCK, 'content', env),
    description: 'Article ingestion and content processing pipeline',
    dependsOn: ['data'],
  },
  {
    id: 'pipeline',
    name: 'Bedrock Pipeline Stack',
    getStackName: (env) => getStackId(Project.BEDROCK, 'pipeline', env),
    description: 'Bedrock article generation pipeline',
    dependsOn: ['data'],
  },
  {
    id: 'strategistData',
    name: 'Strategist Data Stack',
    getStackName: (env) => getStackId(Project.BEDROCK, 'strategistData', env),
    description: 'DynamoDB tables for job strategist application',
  },
  {
    id: 'strategistPipeline',
    name: 'Strategist Pipeline Stack',
    getStackName: (env) => getStackId(Project.BEDROCK, 'strategistPipeline', env),
    description: 'Step Functions + Lambda for job strategist pipeline',
    dependsOn: ['strategistData'],
  },
];

registerProject({
  id: 'bedrock',
  name: 'Bedrock',
  description: 'Bedrock AI applications (article pipeline, job strategist, chatbot)',
  stacks: bedrockStacks,
  cdkContext: (env) => ({
    project: 'bedrock',
    environment: env,
  }),
});

// =============================================================================
// SELF-HEALING PROJECT
// =============================================================================

const selfHealingStacks: StackConfig[] = [
  {
    id: 'gateway',
    name: 'Self-Healing Gateway Stack',
    getStackName: (env) => getStackId(Project.SELF_HEALING, 'gateway', env),
    description: 'API Gateway for self-healing agent',
  },
  {
    id: 'agent',
    name: 'Self-Healing Agent Stack',
    getStackName: (env) => getStackId(Project.SELF_HEALING, 'agent', env),
    description: 'Self-healing agent Lambda + Step Functions',
    dependsOn: ['gateway'],
  },
];

registerProject({
  id: 'self-healing',
  name: 'Self-Healing',
  description: 'Self-healing agent for automated incident remediation',
  stacks: selfHealingStacks,
  cdkContext: (env) => ({
    project: 'self-healing',
    environment: env,
  }),
});
