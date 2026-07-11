/**
 * @format
 * Bedrock Project Factory
 *
 * Creates the Bedrock chatbot infrastructure using a 2-stack architecture
 * (post Pinecone/Agent decommission — every chatbot serves from RDS pgvector):
 * - DataStack: S3 bucket + inference profiles
 * - ApiStack:  API Gateway + RAG chatbot Lambdas (BFF, API key protected)
 *
 * Stacks created:
 * - Bedrock-Data-{environment}
 * - Bedrock-Api-{environment}
 *
 * The former KbStack (Pinecone-backed Bedrock KB) and AgentStack (Bedrock
 * Agent + Guardrail) were decommissioned 2026-07 — retrieval moved to the
 * platform RDS pgvector store.
 *
 * Article pipeline, job strategist pipeline, ingestion pipeline, RDS,
 * DynamoDB data layers, and the public API have been migrated to
 * Kubernetes (kubernetes-platform / kubernetes-bootstrap repos).
 */

import * as cdk from 'aws-cdk-lib/core';

import { getBedrockAllocations } from '../../config/bedrock/allocations';
import { getBedrockConfigs } from '../../config/bedrock/configurations';
import type { Environment} from '../../config/environments';
import { cdkEnvironment } from '../../config/environments';
import { Project, getProjectConfig } from '../../config/projects';
import { SYSTEM_INFERENCE_PROFILES } from '../../config/shared/model-registry';
import type {
    IProjectFactory,
    ProjectFactoryContext,
    ProjectStackFamily,
} from '../../factories/project-interfaces';
import {
    BedrockDataStack,
    BedrockApiStack,
} from '../../stacks/bedrock';
import { stackId, flatName } from '../../utilities/naming';

// =========================================================================
// Factory Context
// =========================================================================

/** Bedrock factory context — no project-specific overrides remain. */
export type BedrockFactoryContext = ProjectFactoryContext;

/**
 * Bedrock project factory.
 * Creates the pgvector-backed chatbot infrastructure: data layer plus the
 * API Gateway + Lambda frontend.
 */
export class BedrockProjectFactory implements IProjectFactory<BedrockFactoryContext> {
    readonly project = Project.BEDROCK;
    readonly environment: Environment;
    readonly namespace: string;

    constructor(environment: Environment) {
        this.environment = environment;
        this.namespace = getProjectConfig(Project.BEDROCK).namespace;
    }

    createAllStacks(scope: cdk.App, _context: BedrockFactoryContext): ProjectStackFamily {
        // -------------------------------------------------------------
        // Load typed config for this environment
        // -------------------------------------------------------------
        const allocs = getBedrockAllocations(this.environment);
        const configs = getBedrockConfigs(this.environment);

        // CDK environment: resolved from env vars via config
        const env = cdkEnvironment(this.environment);

        const namePrefix = flatName('bedrock', '', this.environment);

        // =================================================================
        // Stack 1: Data (S3 bucket for Knowledge Base source documents)
        //
        // Stateful resources with independent lifecycle.
        // =================================================================
        const dataStack = new BedrockDataStack(
            scope,
            stackId(this.namespace, 'Data', this.environment),
            {
                namePrefix,
                createEncryptionKey: configs.createKmsKeys,
                removalPolicy: configs.removalPolicy,
                haikuProfileSourceArn: SYSTEM_INFERENCE_PROFILES.CLAUDE_HAIKU_4_5,
                sonnetProfileSourceArn: SYSTEM_INFERENCE_PROFILES.CLAUDE_SONNET_4_6,
                environmentName: this.environment,
                articleAssetsAdminRoleName: configs.articleAssets.adminRoleName,
                articleAssetsReaderRoleName: configs.articleAssets.readerRoleName,
                // Gap C3: Wire monthly budget alarm when a notification email is configured.
                // Consistent with the NOTIFICATION_EMAIL convention in shared/factory.ts.
                budgetAlertEmail: process.env.NOTIFICATION_EMAIL,
                env,
            }
        );

        // =================================================================
        // Stack 2: API (API Gateway + RAG chatbot Lambdas)
        //
        // Serverless frontend over the RDS pgvector store.
        // =================================================================
        const apiStack = new BedrockApiStack(
            scope,
            stackId(this.namespace, 'Api', this.environment),
            {
                namePrefix,
                environmentName: this.environment,
                lambdaMemoryMb: allocs.apiLambda.memoryMb,
                lambdaTimeoutSeconds: allocs.apiLambda.timeoutSeconds,
                logRetention: configs.logRetention,
                removalPolicy: configs.removalPolicy,
                enableApiKey: configs.api.enableApiKey,
                allowedOrigins: configs.api.allowedOrigins,
                throttlingRateLimit: allocs.apiGateway.throttlingRateLimit,
                throttlingBurstLimit: allocs.apiGateway.throttlingBurstLimit,
                chatbotModel: allocs.apiLambda.chatbotModel,
                portfolioOwnerUserId: process.env['PORTFOLIO_OWNER_USER_ID'],
                portfolioOwnerUserIdParameterName: configs.api.portfolioOwnerUserIdParameterName,
                rdsSsmPrefix: configs.api.rdsSsmPrefix,
                rdsCredentialsSecretName: configs.api.rdsCredentialsSecretName,
                chatbotVpc: configs.api.chatbotVpc,
                env,
            }
        );

        const stacks: cdk.Stack[] = [
            dataStack,
            apiStack,
        ];

        cdk.Annotations.of(scope).addInfo(
            `Bedrock factory created ${stacks.length} stacks for ${this.environment}`,
        );

        return {
            stacks,
            stackMap: {
                data: dataStack,
                api: apiStack,
            },
        };
    }
}
