/**
 * @format
 * Step Functions TestState Client
 *
 * Wrapper around the AWS SDK TestState API for use in integration tests.
 *
 * Prerequisites:
 *   TEST_SFN_ROLE_ARN — IAM role ARN that Step Functions assumes during test
 *                       execution. For mocked tests, the role only needs to
 *                       be assumable by states.amazonaws.com. No service
 *                       permissions are required when all integrations are
 *                       mocked via mockConfiguration.
 *
 * Usage:
 *   const result = await testState({
 *     definition: isolateState(definition, 'MarkArticleFailed'),
 *     input: JSON.stringify({ context: { slug: 'foo', version: '1' }, error: { Cause: '...' } }),
 *     mocks: { 'MarkArticleFailed': { 0: { Return: { Attributes: {} } } } },
 *   });
 *   expect(result.status).toBe('SUCCEEDED');
 *   const params = result.afterParameters<DynamoUpdateItemParams>();
 */

import {
    SFNClient,
    TestStateCommand,
    type TestStateCommandInput,
    type InspectionData,
} from '@aws-sdk/client-sfn';

// =============================================================================
// Env guard
// =============================================================================

export const TEST_SFN_ROLE_ARN = process.env['TEST_SFN_ROLE_ARN'] ?? '';

/**
 * Skip the current test suite if TEST_SFN_ROLE_ARN is not set.
 * Call this at the top of each integration test file:
 *
 *   guardTestSuite();
 *   describe('...', () => { ... });
 */
export function guardTestSuite(): void {
    if (!TEST_SFN_ROLE_ARN) {
        // Using describe/it nesting gives jest a proper skip rather than a no-op
        describe.skip('Step Functions integration tests', () => {
            it.todo('Set TEST_SFN_ROLE_ARN to run these tests');
        });
    }
}

// =============================================================================
// Client
// =============================================================================

export const sfnClient = new SFNClient({
    region: process.env['AWS_REGION'] ?? 'eu-west-1',
});

// =============================================================================
// TestState wrapper
// =============================================================================

export interface TestStateOptions {
    /** Isolated state machine definition JSON string (from isolateState()). */
    definition: string;
    /** JSON string of the state input. */
    input?: string;
    /**
     * Mock configuration for service integrations.
     * Key: state name. Value: attempt index → Return or Throw.
     *
     * Example:
     *   { 'MarkArticleFailed': { 0: { Return: { Attributes: {} } } } }
     */
    mocks?: Record<string, Record<number, { Return?: unknown; Throw?: { Error: string; Cause: string } }>>;
}

export interface TestStateResult {
    status: string;
    output: unknown;
    error?: string;
    cause?: string;
    /** Resolved parameters sent to the service integration (TRACE level). */
    afterParameters: <T = unknown>() => T;
    /** Raw InspectionData from the TestState response. */
    inspectionData: InspectionData | undefined;
}

/**
 * Executes a single isolated state against the Step Functions TestState API
 * with TRACE-level inspection and optional mock service responses.
 *
 * @throws if the AWS API call itself fails (not if the state fails — that
 *         is surfaced via result.status and result.error/cause).
 */
export async function testState(opts: TestStateOptions): Promise<TestStateResult> {
    const mockConfiguration = opts.mocks
        ? buildMockConfiguration(opts.mocks)
        : undefined;

    const input: TestStateCommandInput = {
        definition: opts.definition,
        input: opts.input,
        roleArn: TEST_SFN_ROLE_ARN,
        inspectionLevel: 'TRACE',
        ...(mockConfiguration && { mockConfiguration }),
    };

    const response = await sfnClient.send(new TestStateCommand(input));

    return {
        status: response.status ?? 'UNKNOWN',
        output: response.output ? JSON.parse(response.output) : undefined,
        error: response.error,
        cause: response.cause,
        afterParameters: <T = unknown>() => {
            const raw = response.inspectionData?.afterParameters;
            if (!raw) throw new Error('afterParameters not available — inspectionLevel must be TRACE');
            return JSON.parse(raw) as T;
        },
        inspectionData: response.inspectionData,
    };
}

// =============================================================================
// Mock configuration builder
// =============================================================================

type MockEntry =
    | { Return: unknown }
    | { Throw: { Error: string; Cause: string } };

function buildMockConfiguration(
    mocks: Record<string, Record<number, { Return?: unknown; Throw?: { Error: string; Cause: string } }>>,
): Record<string, unknown> {
    const mockedResponse: Record<string, Record<string, MockEntry>> = {};

    for (const [stateName, attempts] of Object.entries(mocks)) {
        mockedResponse[stateName] = {};
        for (const [attempt, response] of Object.entries(attempts)) {
            if (response.Throw) {
                mockedResponse[stateName][attempt] = { Throw: response.Throw };
            } else {
                mockedResponse[stateName][attempt] = { Return: response.Return ?? {} };
            }
        }
    }

    return { MockedResponse: mockedResponse };
}
