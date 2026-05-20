#!/usr/bin/env node
/**
 * @format
 * CDK Entry Point — AI Applications
 *
 * Deploys Bedrock AI applications (article pipeline, job strategist, chatbot)
 * and the self-healing agent infrastructure.
 *
 * Usage:
 *   npx cdk synth -c project=bedrock -c environment=dev
 *   npx cdk synth -c project=self-healing -c environment=prod
 */

import * as path from 'path';

import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import * as cdk from 'aws-cdk-lib/core';

import { applyCdkNag, applyCommonSuppressions, CompliancePack, TaggingAspect } from '../lib/aspects';
import { isValidEnvironment, resolveEnvironment } from '../lib/config';
import type { Project } from '../lib/config/projects';
import { isValidProject, getProjectConfig } from '../lib/config/projects';
import { getProjectFactoryFromContext } from '../lib/factories/project-registry';

const app = new cdk.App();

const projectContext = app.node.tryGetContext('project') as string | undefined;
const environmentContext = app.node.tryGetContext('environment') as string | undefined;

if (!projectContext || !isValidProject(projectContext)) {
    throw new Error(
        'Project context required. Use: -c project=bedrock|self-healing -c environment=dev|staging|prod',
    );
}

if (!environmentContext || !isValidEnvironment(environmentContext)) {
    throw new Error(
        `Environment required. Use: -c project=${projectContext} -c environment=dev|staging|prod`,
    );
}

const environment = resolveEnvironment(environmentContext);
const projectConfig = getProjectConfig(projectContext as Project);

console.log(`=== Project: ${projectConfig.namespace} | Environment: ${environment} ===`);

const factory = getProjectFactoryFromContext(projectContext, environment);
const { stacks } = factory.createAllStacks(app, { environment });

const INFRA_VERSION = process.env.INFRA_VERSION ?? '1.0.0';

stacks.forEach(stack => {
    cdk.Aspects.of(stack).add(new TaggingAspect({
        environment,
        project: projectConfig.namespace?.toLowerCase() || projectConfig.displayName.toLowerCase(),
        owner: 'nelson-l',
        component: inferComponent(stack.stackName),
        version: INFRA_VERSION,
        costCentre: inferCostCentre(stack.stackName),
    }));
});

function inferComponent(stackName: string): string {
    const name = stackName.toLowerCase();
    if (name.includes('data') || name.includes('storage')) return 'data';
    if (name.includes('api') || name.includes('cloudfront')) return 'networking';
    if (name.includes('iam') || name.includes('role')) return 'iam';
    return 'compute';
}

function inferCostCentre(stackName: string): 'infrastructure' | 'platform' | 'application' {
    const name = stackName.toLowerCase();
    if (name.includes('api') || name.includes('bedrock') || name.includes('content')) return 'application';
    return 'platform';
}

const enableNagChecks = app.node.tryGetContext('nagChecks') !== 'false';
if (enableNagChecks) {
    applyCdkNag(app, {
        packs: [CompliancePack.AWS_SOLUTIONS],
        verbose: false,
        reports: true,
    });
    stacks.forEach(stack => applyCommonSuppressions(stack));
}

const stackNames = stacks.map(s => `  - ${s.stackName}`).join('\n');
console.log(`\nStacks created:\n${stackNames}\n`);
