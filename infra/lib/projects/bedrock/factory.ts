/**
 * @format
 * Bedrock Project Factory
 *
 * Creates the Amazon Bedrock Agent (chatbot) infrastructure using a
 * 4-stack architecture (post-Phase-5 cleanup):
 * - DataStack:  S3 bucket for Knowledge Base source documents
 * - KbStack:    Bedrock Knowledge Base backed by Pinecone
 * - AgentStack: Bedrock Agent, Guardrail, Action Group
 * - ApiStack:   API Gateway + Lambda for agent invocation (BFF, API key protected)
 *
 * Stacks created:
 * - Bedrock-Data-{environment}
 * - Bedrock-Kb-{environment}
 * - Bedrock-Agent-{environment}
 * - Bedrock-Api-{environment}
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
    BedrockKbStack,
    BedrockAgentStack,
    BedrockApiStack,
} from '../../stacks/bedrock';
import { stackId, flatName } from '../../utilities/naming';

// =========================================================================
// Factory Context
// =========================================================================

/**
 * Extended factory context with Bedrock-specific overrides.
 */
export interface BedrockFactoryContext extends ProjectFactoryContext {
    /** Override agent instruction from config */
    agentInstruction?: string;
    /** Override foundation model from config */
    foundationModel?: string;
}

/**
 * Bedrock project factory.
 * Creates Amazon Bedrock Agent (chatbot) infrastructure with Guardrails,
 * Action Groups, Knowledge Base, and an API Gateway frontend.
 */
export class BedrockProjectFactory implements IProjectFactory<BedrockFactoryContext> {
    readonly project = Project.BEDROCK;
    readonly environment: Environment;
    readonly namespace: string;

    constructor(environment: Environment) {
        this.environment = environment;
        this.namespace = getProjectConfig(Project.BEDROCK).namespace;
    }

    createAllStacks(scope: cdk.App, context: BedrockFactoryContext): ProjectStackFamily {
        // -------------------------------------------------------------
        // Load typed config for this environment
        // -------------------------------------------------------------
        const allocs = getBedrockAllocations(this.environment);
        const configs = getBedrockConfigs(this.environment);

        // CDK environment: resolved from env vars via config
        const env = cdkEnvironment(this.environment);

        const namePrefix = flatName('bedrock', '', this.environment);

        // Context overrides > typed config defaults
        const agentInstruction = context.agentInstruction ?? configs.agentInstruction;
        const foundationModel = context.foundationModel ?? allocs.agent.foundationModel;

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
                // Gap C3: Wire monthly budget alarm when a notification email is configured.
                // Consistent with the NOTIFICATION_EMAIL convention in shared/factory.ts.
                budgetAlertEmail: process.env.NOTIFICATION_EMAIL,
                env,
            }
        );

        // =================================================================
        // Stack 2: Knowledge Base (Pinecone-backed vector store)
        //
        // Creates the Bedrock KB that embeds and retrieves repo docs.
        // Uses Pinecone free tier — zero idle cost.
        // Must be created before Agent so it can be associated.
        // =================================================================
        const kbStack = new BedrockKbStack(
            scope,
            stackId(this.namespace, 'Kb', this.environment),
            {
                namePrefix,
                embeddingsModel: allocs.knowledgeBase.embeddingsModel,
                // dataBucketArn omitted — KbStack reads from SSM at deploy time
                pineconeConnectionString: allocs.knowledgeBase.pineconeConnectionString,
                pineconeSecretName: configs.knowledgeBase.pineconeSecretName,
                pineconeNamespace: allocs.knowledgeBase.pineconeNamespace,
                kbDescription: configs.knowledgeBase.description,
                kbInstruction: configs.knowledgeBase.instruction,
                removalPolicy: configs.removalPolicy,
                env,
            }
        );

        // =================================================================
        // Stack 3: Agent (Bedrock Agent + Guardrail + KB)
        //
        // Core AI resources. Knowledge Base is wired here so the chatbot
        // can answer portfolio questions from Pinecone-indexed documents.
        // =================================================================
        const agentStack = new BedrockAgentStack(
            scope,
            stackId(this.namespace, 'Agent', this.environment),
            {
                namePrefix,
                foundationModel,
                agentInstruction,
                agentDescription: configs.agentDescription,
                idleSessionTtlInSeconds: allocs.agent.idleSessionTtlInSeconds,
                enableContentFilters: configs.guardrail.enableContentFilters,
                blockedInputMessaging: configs.guardrail.blockedInputMessaging,
                blockedOutputsMessaging: configs.guardrail.blockedOutputMessaging,
                removalPolicy: configs.removalPolicy,
                // knowledgeBase omitted — AgentStack reads KB ID/ARN from SSM at deploy time
                knowledgeBaseDescription: configs.knowledgeBase.description,
                env,
            },
        );

        // =================================================================
        // Stack 4: API (API Gateway + Lambda for agent invocation)
        //
        // Serverless frontend. References Agent stack outputs.
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
                portfolioOwnerUserId: configs.api.portfolioOwnerUserId,
                rdsSsmPrefix: configs.api.rdsSsmPrefix,
                rdsCredentialsSecretName: configs.api.rdsCredentialsSecretName,
                chatbotRetrievalSource: configs.api.chatbotRetrievalSource,
                vpcId: configs.api.vpcId,
                lambdaSubnetIds: configs.api.lambdaSubnetIds,
                lambdaSubnetAzs: configs.api.lambdaSubnetAzs,
                vpcCidrBlock: configs.api.vpcCidrBlock,
                dbSecurityGroupId: configs.api.dbSecurityGroupId,
                env,
            }
        );

        const stacks: cdk.Stack[] = [
            dataStack,
            kbStack,
            agentStack,
            apiStack,
        ];

        cdk.Annotations.of(scope).addInfo(
            `Bedrock factory created ${stacks.length} stacks for ${this.environment}`,
        );

        return {
            stacks,
            stackMap: {
                data: dataStack,
                kb: kbStack,
                agent: agentStack,
                api: apiStack,
            },
        };
    }
}
