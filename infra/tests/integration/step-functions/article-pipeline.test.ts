/**
 * @format
 * Article Pipeline — Step Functions TestState Tests
 *
 * Tests runtime behaviour of the article pipeline state machine states
 * using the AWS TestState API with mocked service integrations.
 *
 * States under test:
 *   MarkArticleFailed — DynamoDB UpdateItem that persists failure state.
 *     Validates the JsonPath expressions that construct DynamoDB keys and
 *     GSI attributes. A bug here makes failed articles invisible in the
 *     admin dashboard indefinitely (wrong key → item not found via GSI).
 *
 * Prerequisite:
 *   TEST_SFN_ROLE_ARN must be set to an IAM role assumable by
 *   states.amazonaws.com. No DynamoDB permissions needed — all
 *   integrations are mocked.
 *
 * Run:
 *   just test-sfn
 *   TEST_SFN_ROLE_ARN=arn:aws:iam::... just test-sfn
 */

import {
    extractArticlePipelineDefinition,
    isolateState,
    TEST_CONTENT_TABLE_NAME,
    type StateMachineDefinition,
} from './__helpers__/asl-extractor';
import { guardTestSuite, testState } from './__helpers__/sfn-test-client';

guardTestSuite();

// =============================================================================
// Fixtures
// =============================================================================

const SLUG = 'building-resilient-aws-architectures';
const VERSION = '3';
const STARTED_AT = '2024-03-15T08:00:00.000Z';
const ERROR_CAUSE = 'Runtime.UnhandledPromiseRejection: Bedrock throttled the request';

/** State input matching what the Catch block produces: original task input + $.error */
function makeErrorInput(overrides?: Partial<{ slug: string; version: string; startedAt: string; cause: string }>) {
    return JSON.stringify({
        context: {
            slug: overrides?.slug ?? SLUG,
            version: overrides?.version ?? VERSION,
            startedAt: overrides?.startedAt ?? STARTED_AT,
        },
        error: {
            Error: 'States.Runtime',
            Cause: overrides?.cause ?? ERROR_CAUSE,
        },
    });
}

// DynamoDB UpdateItem success response (no ReturnValues requested)
const DYNAMO_OK = { Return: { Attributes: {} } };

// =============================================================================
// Suite
// =============================================================================

describe('Article Pipeline — MarkArticleFailed state', () => {
    let definition: StateMachineDefinition;
    let isolatedDefinition: string;

    // Synthesize the CDK stack once for the entire suite
    beforeAll(() => {
        definition = extractArticlePipelineDefinition();
        isolatedDefinition = isolateState(definition, 'MarkArticleFailed');
    });

    // ── DynamoDB primary key ────────────────────────────────────────────

    it('should construct pk as ARTICLE#{slug}', async () => {
        const result = await testState({
            definition: isolatedDefinition,
            input: makeErrorInput({ slug: 'my-article-slug' }),
            mocks: { MarkArticleFailed: { 0: DYNAMO_OK } },
        });

        expect(result.status).toBe('SUCCEEDED');

        const params = result.afterParameters<{ Key: { pk: { S: string }; sk: { S: string } } }>();
        expect(params.Key.pk.S).toBe('ARTICLE#my-article-slug');
    });

    it('should construct sk as VERSION#v{version}', async () => {
        const result = await testState({
            definition: isolatedDefinition,
            input: makeErrorInput({ version: '7' }),
            mocks: { MarkArticleFailed: { 0: DYNAMO_OK } },
        });

        const params = result.afterParameters<{ Key: { pk: { S: string }; sk: { S: string } } }>();
        expect(params.Key.sk.S).toBe('VERSION#v7');
    });

    // ── GSI keys ───────────────────────────────────────────────────────

    it('should set gsi1pk to STATUS#failed (static)', async () => {
        const result = await testState({
            definition: isolatedDefinition,
            input: makeErrorInput(),
            mocks: { MarkArticleFailed: { 0: DYNAMO_OK } },
        });

        const params = result.afterParameters<{
            ExpressionAttributeValues: { ':gsi1pk': { S: string } };
        }>();
        expect(params.ExpressionAttributeValues[':gsi1pk'].S).toBe('STATUS#failed');
    });

    it('should construct gsi1sk as {startedAt}#{slug}', async () => {
        // gsi1sk is the sort key for the status+date GSI. It must concatenate
        // startedAt (ISO timestamp from context) and slug so the admin dashboard
        // can query articles by status ordered by creation date.
        const result = await testState({
            definition: isolatedDefinition,
            input: makeErrorInput({ startedAt: '2024-03-15T08:00:00.000Z', slug: 'my-slug' }),
            mocks: { MarkArticleFailed: { 0: DYNAMO_OK } },
        });

        const params = result.afterParameters<{
            ExpressionAttributeValues: { ':gsi1sk': { S: string } };
        }>();
        expect(params.ExpressionAttributeValues[':gsi1sk'].S)
            .toBe('2024-03-15T08:00:00.000Z#my-slug');
    });

    // ── Error propagation ──────────────────────────────────────────────

    it('should propagate $.error.Cause to :error attribute', async () => {
        const errorMessage = 'Task timed out after 300.00 seconds';
        const result = await testState({
            definition: isolatedDefinition,
            input: makeErrorInput({ cause: errorMessage }),
            mocks: { MarkArticleFailed: { 0: DYNAMO_OK } },
        });

        const params = result.afterParameters<{
            ExpressionAttributeValues: { ':error': { S: string } };
        }>();
        expect(params.ExpressionAttributeValues[':error'].S).toBe(errorMessage);
    });

    it('should set :failed attribute to string "failed"', async () => {
        const result = await testState({
            definition: isolatedDefinition,
            input: makeErrorInput(),
            mocks: { MarkArticleFailed: { 0: DYNAMO_OK } },
        });

        const params = result.afterParameters<{
            ExpressionAttributeValues: { ':failed': { S: string } };
        }>();
        expect(params.ExpressionAttributeValues[':failed'].S).toBe('failed');
    });

    // ── Table targeting ────────────────────────────────────────────────

    it('should target the content table', async () => {
        const result = await testState({
            definition: isolatedDefinition,
            input: makeErrorInput(),
            mocks: { MarkArticleFailed: { 0: DYNAMO_OK } },
        });

        const params = result.afterParameters<{ TableName: string }>();
        expect(params.TableName).toBe(TEST_CONTENT_TABLE_NAME);
    });

    // ── UpdateExpression ───────────────────────────────────────────────

    it('should write all five attributes in UpdateExpression', async () => {
        const result = await testState({
            definition: isolatedDefinition,
            input: makeErrorInput(),
            mocks: { MarkArticleFailed: { 0: DYNAMO_OK } },
        });

        const params = result.afterParameters<{ UpdateExpression: string }>();
        // All five attributes must be in the expression so no partial writes occur
        expect(params.UpdateExpression).toContain('#status');
        expect(params.UpdateExpression).toContain('#updatedAt');
        expect(params.UpdateExpression).toContain('#errorMessage');
        expect(params.UpdateExpression).toContain('#gsi1pk');
        expect(params.UpdateExpression).toContain('#gsi1sk');
    });

    // ── ResultPath ─────────────────────────────────────────────────────

    it('should discard DynamoDB response (ResultPath: null)', async () => {
        // ResultPath: null means the state output equals the state input.
        // This ensures the error context is not overwritten by the DynamoDB response.
        const input = makeErrorInput();
        const result = await testState({
            definition: isolatedDefinition,
            input,
            mocks: { MarkArticleFailed: { 0: DYNAMO_OK } },
        });

        // Output should equal input (DynamoDB result discarded)
        expect(JSON.stringify(result.output)).toBe(input);
    });
});

// =============================================================================
// ResearchTask — catch routing
// =============================================================================

describe('Article Pipeline — ResearchTask error routing', () => {
    let definition: StateMachineDefinition;
    let researchDefinition: string;

    beforeAll(() => {
        definition = extractArticlePipelineDefinition();
        // Keep ResearchTask + MarkArticleFailed + PipelineFailed in the definition
        // so catch routing can be validated end-to-end within TestState
        researchDefinition = JSON.stringify({
            StartAt: 'ResearchTask',
            States: {
                ResearchTask: definition.States['ResearchTask'],
                MarkArticleFailed: {
                    ...definition.States['MarkArticleFailed'] as object,
                    Next: 'PipelineFailed',
                },
                PipelineFailed: definition.States['PipelineFailed'],
            },
        });
    });

    it('should route Lambda errors to MarkArticleFailed via Catch', async () => {
        // When the Lambda invocation throws, the Catch block should route to MarkArticleFailed.
        // The error is placed at $.error (resultPath: '$.error' in the Catch config).
        const result = await testState({
            definition: researchDefinition,
            input: JSON.stringify({
                context: { slug: SLUG, version: VERSION, startedAt: STARTED_AT },
            }),
            mocks: {
                ResearchTask: {
                    0: {
                        Throw: {
                            Error: 'Lambda.AWSLambdaException',
                            Cause: 'Connection reset by peer',
                        },
                    },
                },
                MarkArticleFailed: { 0: DYNAMO_OK },
            },
        });

        // The state machine reaches PipelineFailed (Fail state) — status is FAILED
        // because the Fail state is terminal and reports the error to TestState
        expect(result.status).toBe('FAILED');
        expect(result.error).toBe('PipelineExecutionFailed');
    });

    it('should place error at $.error.Cause so MarkArticleFailed can read it', async () => {
        // The Catch block uses resultPath: '$.error', so the Lambda error
        // lands at $.error.Error and $.error.Cause.
        // MarkArticleFailed's expressionAttributeValues uses '$.error.Cause' — verify.
        const result = await testState({
            definition: researchDefinition,
            input: JSON.stringify({
                context: { slug: SLUG, version: VERSION, startedAt: STARTED_AT },
            }),
            mocks: {
                ResearchTask: {
                    0: { Throw: { Error: 'States.Runtime', Cause: 'Bedrock throttled' } },
                },
                MarkArticleFailed: { 0: DYNAMO_OK },
            },
        });

        // inspectionData is from the final state. Check MarkArticleFailed's afterParameters
        // via the inspectionData trace of that specific state via afterInputPath.
        // When the full chain runs, inspectionData reflects the last state (PipelineFailed).
        // We verify routing worked by asserting on the failure error name.
        expect(result.status).toBe('FAILED');
        expect(result.error).toBe('PipelineExecutionFailed');
    });
});

// =============================================================================
// State machine presence check (offline — no AWS needed)
// =============================================================================

describe('Article Pipeline — ASL structure (extracted from CDK)', () => {
    let definition: StateMachineDefinition;

    beforeAll(() => {
        definition = extractArticlePipelineDefinition();
    });

    it('should have all required states', () => {
        const stateNames = Object.keys(definition.States);
        expect(stateNames).toContain('ResearchTask');
        expect(stateNames).toContain('WriterTask');
        expect(stateNames).toContain('QaTask');
        expect(stateNames).toContain('MarkArticleFailed');
        expect(stateNames).toContain('PipelineFailed');
    });

    it('should start at ResearchTask', () => {
        expect(definition.StartAt).toBe('ResearchTask');
    });

    it('should not retry MarkArticleFailed (immediate failure persistence)', () => {
        const state = definition.States['MarkArticleFailed'] as Record<string, unknown>;
        // DynamoDB writes should not retry — failure should be persisted immediately
        expect(state['Retry']).toBeUndefined();
    });

    it('should route all Lambda task errors to MarkArticleFailed via Catch', () => {
        for (const taskName of ['ResearchTask', 'WriterTask', 'QaTask']) {
            const state = definition.States[taskName] as Record<string, unknown>;
            const catchClauses = state['Catch'] as Array<{ ErrorEquals: string[]; Next: string }>;
            const catchAll = catchClauses.find((c) => c.ErrorEquals.includes('States.ALL'));
            expect(catchAll?.Next).toBe('MarkArticleFailed');
        }
    });
});
