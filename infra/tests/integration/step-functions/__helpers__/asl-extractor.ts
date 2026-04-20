/**
 * @format
 * ASL Extractor — CDK Stack → State Machine Definition
 *
 * Synthesizes CDK stacks programmatically and extracts state machine ASL
 * definitions with CloudFormation intrinsic functions resolved to stable
 * test-time values.
 *
 * Intrinsic resolution strategy:
 *   AWS::Partition  → 'aws'
 *   AWS::Region     → 'eu-west-1'
 *   AWS::AccountId  → '123456789012'
 *   Ref (resource)  → resolved by CloudFormation resource type lookup
 *   Fn::GetAtt      → resolved by CloudFormation resource type lookup
 *
 * Why programmatic synthesis?
 *   Tests use the actual CDK-generated ASL, not a separately maintained copy.
 *   If a CDK stack changes its state machine definition, these tests catch it.
 */

import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { BedrockPipelineStack } from '../../../../lib/stacks/bedrock/pipeline-stack';
import { StrategistPipelineStack } from '../../../../lib/stacks/bedrock/strategist-pipeline-stack';

// =============================================================================
// Test constants — substituted for CloudFormation resource references
// =============================================================================

export const TEST_CONTENT_TABLE_NAME = 'test-content-table';
export const TEST_STRATEGIST_TABLE_NAME = 'test-strategist-table';
export const TEST_LAMBDA_ARN = 'arn:aws:lambda:eu-west-1:123456789012:function:test-fn';
export const TEST_QUEUE_URL = 'https://sqs.eu-west-1.amazonaws.com/123456789012/test-dlq';

// =============================================================================
// Types
// =============================================================================

export interface StateMachineDefinition {
    StartAt: string;
    States: Record<string, unknown>;
    TimeoutSeconds?: number;
}

// =============================================================================
// Intrinsic function resolver
// =============================================================================

type CfnResources = Record<string, { Type: string; Properties?: Record<string, unknown> }>;

function resolveIntrinsicPart(part: unknown, resources: CfnResources): string {
    if (typeof part === 'string') return part;
    if (typeof part !== 'object' || part === null) return 'test-value';

    const obj = part as Record<string, unknown>;

    // ── Ref ────────────────────────────────────────────────────────────
    if ('Ref' in obj) {
        const ref = obj['Ref'] as string;

        // Pseudo-parameters
        if (ref === 'AWS::Partition') return 'aws';
        if (ref === 'AWS::Region') return 'eu-west-1';
        if (ref === 'AWS::AccountId') return '123456789012';
        if (ref === 'AWS::NoValue') return '';

        // Look up the resource type to choose the right test value
        const resource = resources[ref];
        if (resource) {
            switch (resource.Type) {
                case 'AWS::DynamoDB::Table':
                    // Identify content vs strategist table by name prefix in logical ID
                    return ref.toLowerCase().includes('strategist')
                        ? TEST_STRATEGIST_TABLE_NAME
                        : TEST_CONTENT_TABLE_NAME;
                case 'AWS::SQS::Queue':
                    return TEST_QUEUE_URL;
                case 'AWS::Lambda::Function':
                    return TEST_LAMBDA_ARN;
                default:
                    return `test-${resource.Type.replace(/^AWS::/, '').replace('::', '-').toLowerCase()}`;
            }
        }

        // CloudFormation parameter (no resource found) — return as-is
        return ref;
    }

    // ── Fn::GetAtt ────────────────────────────────────────────────────
    if ('Fn::GetAtt' in obj) {
        const [logicalId, attr] = obj['Fn::GetAtt'] as [string, string];

        const resource = resources[logicalId];
        if (resource) {
            switch (resource.Type) {
                case 'AWS::Lambda::Function':
                    return TEST_LAMBDA_ARN;
                case 'AWS::SQS::Queue':
                    // Arn vs QueueUrl
                    return attr === 'Arn'
                        ? 'arn:aws:sqs:eu-west-1:123456789012:test-dlq'
                        : TEST_QUEUE_URL;
                case 'AWS::DynamoDB::Table':
                    return attr === 'Arn'
                        ? 'arn:aws:dynamodb:eu-west-1:123456789012:table/test-table'
                        : TEST_CONTENT_TABLE_NAME;
                default:
                    return `arn:aws:${resource.Type.replace(/^AWS::/, '').replace('::', ':').toLowerCase()}:eu-west-1:123456789012:test`;
            }
        }

        return TEST_LAMBDA_ARN;
    }

    // ── Fn::Sub ───────────────────────────────────────────────────────
    if ('Fn::Sub' in obj) {
        return 'test-sub-value';
    }

    return 'test-unknown';
}

// =============================================================================
// Template parser
// =============================================================================

function extractDefinitionFromTemplate(
    template: Record<string, unknown>,
    smLogicalIdPrefix?: string,
): StateMachineDefinition {
    const resources = template['Resources'] as CfnResources;

    const smEntries = Object.entries(resources).filter(([id, r]) => {
        if (r.Type !== 'AWS::StepFunctions::StateMachine') return false;
        if (smLogicalIdPrefix) return id.startsWith(smLogicalIdPrefix);
        return true;
    });

    if (smEntries.length === 0) {
        throw new Error(
            `No state machine found in template${smLogicalIdPrefix ? ` with prefix '${smLogicalIdPrefix}'` : ''}. ` +
            `Available state machines: ${Object.entries(resources)
                .filter(([, r]) => r.Type === 'AWS::StepFunctions::StateMachine')
                .map(([id]) => id)
                .join(', ')}`,
        );
    }

    const [id, smResource] = smEntries[0];
    const props = smResource.Properties ?? {};
    const ds = props['DefinitionString'] ?? props['DefinitionBody'];

    if (!ds || typeof ds !== 'object') {
        throw new Error(`State machine ${id}: unexpected DefinitionString format`);
    }

    const fnJoin = (ds as Record<string, unknown>)['Fn::Join'];
    if (!Array.isArray(fnJoin) || fnJoin.length < 2) {
        throw new Error(`State machine ${id}: expected Fn::Join in DefinitionString`);
    }

    const parts = fnJoin[1] as unknown[];
    const resolved = parts.map((p) => resolveIntrinsicPart(p, resources)).join('');

    return JSON.parse(resolved) as StateMachineDefinition;
}

// =============================================================================
// Public extractors
// =============================================================================

let _articlePipelineDefinition: StateMachineDefinition | null = null;

/**
 * Synthesizes BedrockPipelineStack once and returns the article pipeline
 * state machine ASL definition. Cached after first call.
 */
export function extractArticlePipelineDefinition(): StateMachineDefinition {
    if (_articlePipelineDefinition) return _articlePipelineDefinition;

    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });

    new BedrockPipelineStack(app, 'TestPipelineStack', {
        namePrefix: 'test-bedrock',
        assetsBucketName: 'test-assets-bucket',
        tableName: TEST_CONTENT_TABLE_NAME,
        researchModel: 'anthropic.claude-haiku-4-5-20251001-v1:0',
        writerModel: 'anthropic.claude-sonnet-4-6',
        qaModel: 'anthropic.claude-sonnet-4-6',
        writerMaxTokens: 16000,
        writerThinkingBudgetTokens: 10000,
        agentLambdaMemoryMb: 1024,
        agentLambdaTimeoutSeconds: 300,
        triggerLambdaMemoryMb: 256,
        publishLambdaMemoryMb: 256,
        logRetention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        environmentName: 'test',
        draftPrefix: 'drafts/',
        publishedPrefix: 'published/',
        contentPrefix: 'content/',
        reviewPrefix: 'review/',
        archivedPrefix: 'archived/',
        researchProfileArn: 'arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/test-research',
        writerProfileArn: 'arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/test-writer',
        qaProfileArn: 'arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/test-qa',
        env: { account: '123456789012', region: 'eu-west-1' },
    });

    const assembly = app.synth();
    const template = assembly.getStackByName('TestPipelineStack').template as Record<string, unknown>;
    _articlePipelineDefinition = extractDefinitionFromTemplate(template);
    return _articlePipelineDefinition;
}

let _analysisDefinition: StateMachineDefinition | null = null;
let _coachingDefinition: StateMachineDefinition | null = null;

/**
 * Synthesizes StrategistPipelineStack once and returns both state machine
 * definitions. The Analysis SM is the multi-agent pipeline (Research →
 * Strategist → ResumeBuilder). The Coaching SM is CoachLoader → Coach.
 * Both are cached after first call.
 */
export function extractStrategistPipelineDefinitions(): {
    analysis: StateMachineDefinition;
    coaching: StateMachineDefinition;
} {
    if (_analysisDefinition && _coachingDefinition) {
        return { analysis: _analysisDefinition, coaching: _coachingDefinition };
    }

    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });

    new StrategistPipelineStack(app, 'TestStrategistPipelineStack', {
        namePrefix: 'test-bedrock',
        assetsBucketName: 'test-assets-bucket',
        tableName: TEST_STRATEGIST_TABLE_NAME,
        researchModel: 'anthropic.claude-haiku-4-5-20251001-v1:0',
        strategistModel: 'anthropic.claude-sonnet-4-6',
        strategistMaxTokens: 16000,
        strategistThinkingBudgetTokens: 10000,
        coachModel: 'anthropic.claude-sonnet-4-6',
        coachMaxTokens: 16000,
        coachThinkingBudgetTokens: 10000,
        agentLambdaMemoryMb: 2048,
        agentLambdaTimeoutSeconds: 600,
        triggerLambdaMemoryMb: 256,
        logRetention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        environmentName: 'test',
        researchProfileArn: 'arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/test-research',
        strategistProfileArn: 'arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/test-strategist',
        resumeBuilderProfileArn: 'arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/test-resume',
        coachProfileArn: 'arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/test-coach',
        env: { account: '123456789012', region: 'eu-west-1' },
    });

    const assembly = app.synth();
    const template = assembly.getStackByName('TestStrategistPipelineStack').template as Record<string, unknown>;

    // The strategist stack has two state machines — identify by logical ID prefix
    _analysisDefinition = extractDefinitionFromTemplate(template, 'AnalysisPipeline');
    _coachingDefinition = extractDefinitionFromTemplate(template, 'CoachingPipeline');

    return { analysis: _analysisDefinition, coaching: _coachingDefinition };
}

/**
 * Extract a single named state from a definition, scoped to just that state
 * with End:true so TestState doesn't try to follow the Next transition.
 *
 * TestState executes only the StartAt state and stops — setting End:true
 * prevents 'next state not defined' validation errors when the downstream
 * state (e.g. PipelineFailed) is pruned from the test definition.
 */
export function isolateState(
    definition: StateMachineDefinition,
    stateName: string,
): string {
    const state = definition.States[stateName];
    if (!state) {
        throw new Error(
            `State '${stateName}' not found. Available states: ${Object.keys(definition.States).join(', ')}`,
        );
    }

    // Shallow-clone the state, remove Next/Catch chain, mark as terminal
    const isolated = { ...(state as Record<string, unknown>) };
    delete isolated['Next'];
    delete isolated['Catch'];
    isolated['End'] = true;

    return JSON.stringify({
        StartAt: stateName,
        States: { [stateName]: isolated },
    });
}
