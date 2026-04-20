/**
 * @format
 * Strategist Pipeline — Step Functions TestState Tests
 *
 * Tests runtime behaviour of the strategist pipeline state machines using
 * the AWS TestState API with mocked service integrations.
 *
 * Two state machines tested:
 *   Analysis SM  — Research → Strategist → ResumeBuilder → AnalysisPersist
 *   Coaching SM  — CoachLoader → Coach
 *
 * States under test:
 *   MarkAnalysisFailed  — the critical state: gsi1sk uses
 *                         States.ArrayGetItem(States.StringSplit(enteredTime, 'T'), 0)
 *                         to extract the date from an ISO timestamp. If this
 *                         expression is wrong, all failed applications become
 *                         invisible in the job board admin GSI queries.
 *
 *   SendAnalysisErrorToDlq — verifies execution context fields ($$.StateMachine.Name,
 *                            $$.Execution.Name) resolve correctly from the
 *                            Step Functions context object.
 *
 *   MarkCoachingFailed  — same gsi1sk pattern as MarkAnalysisFailed but for
 *                         the coaching pipeline.
 *
 * Prerequisite:
 *   TEST_SFN_ROLE_ARN must be set to an IAM role assumable by
 *   states.amazonaws.com. No DynamoDB/SQS permissions needed — all
 *   integrations are mocked.
 *
 * Run:
 *   just test-sfn
 *   TEST_SFN_ROLE_ARN=arn:aws:iam::... just test-sfn
 */

import {
    extractStrategistPipelineDefinitions,
    isolateState,
    TEST_STRATEGIST_TABLE_NAME,
    TEST_QUEUE_URL,
    type StateMachineDefinition,
} from './__helpers__/asl-extractor';
import { guardTestSuite, testState } from './__helpers__/sfn-test-client';

guardTestSuite();

// =============================================================================
// Shared fixtures
// =============================================================================

const APPLICATION_SLUG = 'senior-engineer-at-stripe-2024-03';
const ERROR_CAUSE = 'Bedrock: ThrottlingException — rate limit exceeded';

function makeAnalysisErrorInput(overrides?: Partial<{ applicationSlug: string; cause: string }>) {
    return JSON.stringify({
        context: {
            applicationSlug: overrides?.applicationSlug ?? APPLICATION_SLUG,
        },
        error: {
            Error: 'States.TaskFailed',
            Cause: overrides?.cause ?? ERROR_CAUSE,
        },
    });
}

const DYNAMO_OK = { Return: { Attributes: {} } };
const SQS_OK = { Return: { MessageId: 'test-msg-id', MD5OfMessageBody: 'abc' } };

// =============================================================================
// Analysis Pipeline — MarkAnalysisFailed
// =============================================================================

describe('Analysis Pipeline — MarkAnalysisFailed state', () => {
    let definition: StateMachineDefinition;
    let isolatedDefinition: string;

    beforeAll(() => {
        ({ analysis: definition } = extractStrategistPipelineDefinitions());
        isolatedDefinition = isolateState(definition, 'MarkAnalysisFailed');
    });

    // ── DynamoDB primary key ────────────────────────────────────────────

    it('should construct pk as APPLICATION#{applicationSlug}', async () => {
        const result = await testState({
            definition: isolatedDefinition,
            input: makeAnalysisErrorInput({ applicationSlug: 'frontend-lead-at-vercel-2024' }),
            mocks: { MarkAnalysisFailed: { 0: DYNAMO_OK } },
        });

        expect(result.status).toBe('SUCCEEDED');

        const params = result.afterParameters<{ Key: { pk: { S: string } } }>();
        expect(params.Key.pk.S).toBe('APPLICATION#frontend-lead-at-vercel-2024');
    });

    it('should target the METADATA sort key (static — not version-based)', async () => {
        // Unlike the article pipeline (VERSION#v{n}), the strategist uses a
        // single METADATA record per application, overwritten on each failure.
        const result = await testState({
            definition: isolatedDefinition,
            input: makeAnalysisErrorInput(),
            mocks: { MarkAnalysisFailed: { 0: DYNAMO_OK } },
        });

        const params = result.afterParameters<{ Key: { sk: { S: string } } }>();
        expect(params.Key.sk.S).toBe('METADATA');
    });

    // ── GSI date extraction — the critical JsonPath ────────────────────

    it('should extract date from ISO timestamp for gsi1sk (morning UTC)', async () => {
        // gsi1sk = States.Format('{}#{}',
        //   States.ArrayGetItem(States.StringSplit($$.State.EnteredTime, 'T'), 0),
        //   $.context.applicationSlug
        // )
        // EnteredTime '2024-03-15T08:30:00.000Z' → splits on 'T' → ['2024-03-15', '08:30:00.000Z']
        // → ArrayGetItem index 0 → '2024-03-15'
        // → Format → '2024-03-15#senior-engineer-at-stripe-2024-03'
        //
        // Step Functions sets EnteredTime to when the state was entered (context object).
        // In TestState, $$.State.EnteredTime is the actual time the state ran —
        // we can't control it, but we CAN assert the format is DATE#SLUG.
        const result = await testState({
            definition: isolatedDefinition,
            input: makeAnalysisErrorInput({ applicationSlug: 'test-app' }),
            mocks: { MarkAnalysisFailed: { 0: DYNAMO_OK } },
        });

        const params = result.afterParameters<{
            ExpressionAttributeValues: { ':gsi1sk': { S: string } };
        }>();

        const gsi1sk = params.ExpressionAttributeValues[':gsi1sk'].S;

        // Assert format: YYYY-MM-DD#applicationSlug
        expect(gsi1sk).toMatch(/^\d{4}-\d{2}-\d{2}#test-app$/);
    });

    it('should set gsi1sk date portion to today UTC', async () => {
        // $$.State.EnteredTime is set by Step Functions to the current timestamp.
        // The date portion should be today's date in UTC.
        const todayUtc = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

        const result = await testState({
            definition: isolatedDefinition,
            input: makeAnalysisErrorInput({ applicationSlug: 'app-slug' }),
            mocks: { MarkAnalysisFailed: { 0: DYNAMO_OK } },
        });

        const params = result.afterParameters<{
            ExpressionAttributeValues: { ':gsi1sk': { S: string } };
        }>();

        const gsi1sk = params.ExpressionAttributeValues[':gsi1sk'].S;
        const datePart = gsi1sk.split('#')[0];

        expect(datePart).toBe(todayUtc);
    });

    it('should set gsi1sk slug portion from applicationSlug', async () => {
        const slug = 'staff-engineer-at-anthropic-2025-01';

        const result = await testState({
            definition: isolatedDefinition,
            input: makeAnalysisErrorInput({ applicationSlug: slug }),
            mocks: { MarkAnalysisFailed: { 0: DYNAMO_OK } },
        });

        const params = result.afterParameters<{
            ExpressionAttributeValues: { ':gsi1sk': { S: string } };
        }>();

        const gsi1sk = params.ExpressionAttributeValues[':gsi1sk'].S;
        const slugPart = gsi1sk.split('#')[1];

        expect(slugPart).toBe(slug);
    });

    // ── GSI partition key ───────────────────────────────────────────────

    it('should set gsi1pk to APP_STATUS#failed (static)', async () => {
        const result = await testState({
            definition: isolatedDefinition,
            input: makeAnalysisErrorInput(),
            mocks: { MarkAnalysisFailed: { 0: DYNAMO_OK } },
        });

        const params = result.afterParameters<{
            ExpressionAttributeValues: { ':gsi1pk': { S: string } };
        }>();
        expect(params.ExpressionAttributeValues[':gsi1pk'].S).toBe('APP_STATUS#failed');
    });

    // ── Error propagation ──────────────────────────────────────────────

    it('should propagate $.error.Cause to :error attribute', async () => {
        const errorMessage = 'Step Functions execution timed out';

        const result = await testState({
            definition: isolatedDefinition,
            input: makeAnalysisErrorInput({ cause: errorMessage }),
            mocks: { MarkAnalysisFailed: { 0: DYNAMO_OK } },
        });

        const params = result.afterParameters<{
            ExpressionAttributeValues: { ':error': { S: string } };
        }>();
        expect(params.ExpressionAttributeValues[':error'].S).toBe(errorMessage);
    });

    // ── Table targeting ────────────────────────────────────────────────

    it('should target the strategist table (not the content table)', async () => {
        const result = await testState({
            definition: isolatedDefinition,
            input: makeAnalysisErrorInput(),
            mocks: { MarkAnalysisFailed: { 0: DYNAMO_OK } },
        });

        const params = result.afterParameters<{ TableName: string }>();
        expect(params.TableName).toBe(TEST_STRATEGIST_TABLE_NAME);
    });
});

// =============================================================================
// Analysis Pipeline — SendAnalysisErrorToDlq
// =============================================================================

describe('Analysis Pipeline — SendAnalysisErrorToDlq state', () => {
    let definition: StateMachineDefinition;
    let isolatedDefinition: string;

    beforeAll(() => {
        ({ analysis: definition } = extractStrategistPipelineDefinitions());
        isolatedDefinition = isolateState(definition, 'SendAnalysisErrorToDlq');
    });

    it('should send to the analysis DLQ URL', async () => {
        const result = await testState({
            definition: isolatedDefinition,
            input: makeAnalysisErrorInput(),
            mocks: { SendAnalysisErrorToDlq: { 0: SQS_OK } },
        });

        expect(result.status).toBe('SUCCEEDED');

        const params = result.afterParameters<{ QueueUrl: string }>();
        expect(params.QueueUrl).toBe(TEST_QUEUE_URL);
    });

    it('should include pipeline name as "analysis" in message body', async () => {
        const result = await testState({
            definition: isolatedDefinition,
            input: makeAnalysisErrorInput(),
            mocks: { SendAnalysisErrorToDlq: { 0: SQS_OK } },
        });

        const params = result.afterParameters<{
            MessageBody: { pipeline: string };
        }>();
        expect(params.MessageBody.pipeline).toBe('analysis');
    });

    it('should include applicationSlug in message body', async () => {
        const result = await testState({
            definition: isolatedDefinition,
            input: makeAnalysisErrorInput({ applicationSlug: 'my-application' }),
            mocks: { SendAnalysisErrorToDlq: { 0: SQS_OK } },
        });

        const params = result.afterParameters<{
            MessageBody: { applicationSlug: string };
        }>();
        expect(params.MessageBody.applicationSlug).toBe('my-application');
    });

    it('should include error and cause from $.error in message body', async () => {
        const result = await testState({
            definition: isolatedDefinition,
            input: makeAnalysisErrorInput({ cause: 'Lambda out of memory' }),
            mocks: { SendAnalysisErrorToDlq: { 0: SQS_OK } },
        });

        const params = result.afterParameters<{
            MessageBody: { error: string; cause: string };
        }>();
        expect(params.MessageBody.error).toBe('States.TaskFailed');
        expect(params.MessageBody.cause).toBe('Lambda out of memory');
    });

    it('should resolve $$.StateMachine.Name from execution context', async () => {
        // $$.StateMachine.Name is set by Step Functions at runtime.
        // TestState populates this from the execution context (non-empty string).
        const result = await testState({
            definition: isolatedDefinition,
            input: makeAnalysisErrorInput(),
            mocks: { SendAnalysisErrorToDlq: { 0: SQS_OK } },
        });

        const params = result.afterParameters<{
            MessageBody: { stateMachine: string; executionId: string; failedAt: string };
        }>();
        expect(typeof params.MessageBody.stateMachine).toBe('string');
        expect(params.MessageBody.stateMachine.length).toBeGreaterThan(0);
    });

    it('should resolve $$.Execution.Name from execution context', async () => {
        const result = await testState({
            definition: isolatedDefinition,
            input: makeAnalysisErrorInput(),
            mocks: { SendAnalysisErrorToDlq: { 0: SQS_OK } },
        });

        const params = result.afterParameters<{
            MessageBody: { executionId: string };
        }>();
        expect(typeof params.MessageBody.executionId).toBe('string');
        expect(params.MessageBody.executionId.length).toBeGreaterThan(0);
    });

    it('should resolve $$.State.EnteredTime as ISO timestamp', async () => {
        const result = await testState({
            definition: isolatedDefinition,
            input: makeAnalysisErrorInput(),
            mocks: { SendAnalysisErrorToDlq: { 0: SQS_OK } },
        });

        const params = result.afterParameters<{
            MessageBody: { failedAt: string };
        }>();
        // Should be a valid ISO 8601 timestamp
        expect(params.MessageBody.failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
});

// =============================================================================
// Coaching Pipeline — MarkCoachingFailed
// =============================================================================

describe('Coaching Pipeline — MarkCoachingFailed state', () => {
    let definition: StateMachineDefinition;
    let isolatedDefinition: string;

    beforeAll(() => {
        ({ coaching: definition } = extractStrategistPipelineDefinitions());
        isolatedDefinition = isolateState(definition, 'MarkCoachingFailed');
    });

    it('should construct pk as APPLICATION#{applicationSlug}', async () => {
        const result = await testState({
            definition: isolatedDefinition,
            input: makeAnalysisErrorInput({ applicationSlug: 'stripe-eng-2024' }),
            mocks: { MarkCoachingFailed: { 0: DYNAMO_OK } },
        });

        expect(result.status).toBe('SUCCEEDED');

        const params = result.afterParameters<{ Key: { pk: { S: string } } }>();
        expect(params.Key.pk.S).toBe('APPLICATION#stripe-eng-2024');
    });

    it('should use same date-extraction pattern as analysis pipeline', async () => {
        // Both pipelines must use the same gsi1sk format (DATE#SLUG) so
        // admin GSI queries for APP_STATUS#failed return results from both.
        const result = await testState({
            definition: isolatedDefinition,
            input: makeAnalysisErrorInput({ applicationSlug: 'coaching-test-app' }),
            mocks: { MarkCoachingFailed: { 0: DYNAMO_OK } },
        });

        const params = result.afterParameters<{
            ExpressionAttributeValues: { ':gsi1sk': { S: string } };
        }>();

        const gsi1sk = params.ExpressionAttributeValues[':gsi1sk'].S;
        expect(gsi1sk).toMatch(/^\d{4}-\d{2}-\d{2}#coaching-test-app$/);
    });

    it('should set gsi1pk to APP_STATUS#failed (same as analysis)', async () => {
        const result = await testState({
            definition: isolatedDefinition,
            input: makeAnalysisErrorInput(),
            mocks: { MarkCoachingFailed: { 0: DYNAMO_OK } },
        });

        const params = result.afterParameters<{
            ExpressionAttributeValues: { ':gsi1pk': { S: string } };
        }>();
        expect(params.ExpressionAttributeValues[':gsi1pk'].S).toBe('APP_STATUS#failed');
    });
});

// =============================================================================
// Analysis Pipeline — ASL structure (offline — no AWS needed)
// =============================================================================

describe('Strategist Pipelines — ASL structure (extracted from CDK)', () => {
    let analysis: StateMachineDefinition;
    let coaching: StateMachineDefinition;

    beforeAll(() => {
        ({ analysis, coaching } = extractStrategistPipelineDefinitions());
    });

    it('should have all required states in analysis SM', () => {
        const states = Object.keys(analysis.States);
        expect(states).toContain('ResearchTask');
        expect(states).toContain('StrategistTask');
        expect(states).toContain('ResumeBuilderTask');
        expect(states).toContain('MarkAnalysisFailed');
        expect(states).toContain('SendAnalysisErrorToDlq');
        expect(states).toContain('AnalysisPipelineFailed');
    });

    it('should have all required states in coaching SM', () => {
        const states = Object.keys(coaching.States);
        expect(states).toContain('CoachLoaderTask');
        expect(states).toContain('CoachTask');
        expect(states).toContain('MarkCoachingFailed');
        expect(states).toContain('SendCoachingErrorToDlq');
        expect(states).toContain('CoachingPipelineFailed');
    });

    it('should configure retry on all analysis Lambda tasks', () => {
        for (const taskName of ['ResearchTask', 'StrategistTask', 'ResumeBuilderTask']) {
            const state = analysis.States[taskName] as Record<string, unknown>;
            const retries = state['Retry'] as Array<{ ErrorEquals: string[]; MaxAttempts: number }>;
            expect(retries).toBeDefined();
            expect(retries.length).toBeGreaterThan(0);
            // At least one retry clause must cover Lambda service errors
            const hasLambdaRetry = retries.some((r) =>
                r.ErrorEquals.some((e) => e.startsWith('Lambda.')),
            );
            expect(hasLambdaRetry).toBe(true);
        }
    });

    it('should route all analysis task errors to MarkAnalysisFailed', () => {
        for (const taskName of ['ResearchTask', 'StrategistTask', 'ResumeBuilderTask']) {
            const state = analysis.States[taskName] as Record<string, unknown>;
            const catchClauses = state['Catch'] as Array<{ ErrorEquals: string[]; Next: string }>;
            const catchAll = catchClauses.find((c) => c.ErrorEquals.includes('States.ALL'));
            expect(catchAll?.Next).toBe('MarkAnalysisFailed');
        }
    });

    it('should route MarkAnalysisFailed to SendAnalysisErrorToDlq (two-phase error handling)', () => {
        const markFailed = analysis.States['MarkAnalysisFailed'] as Record<string, unknown>;
        // First persist failure to DynamoDB, then forward to DLQ for ops visibility
        expect(markFailed['Next']).toBe('SendAnalysisErrorToDlq');
    });

    it('should route SendAnalysisErrorToDlq to AnalysisPipelineFailed', () => {
        const sendDlq = analysis.States['SendAnalysisErrorToDlq'] as Record<string, unknown>;
        expect(sendDlq['Next']).toBe('AnalysisPipelineFailed');
    });
});
