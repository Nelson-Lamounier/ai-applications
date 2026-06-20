import { context, trace, SpanStatusCode, type Attributes } from '@opentelemetry/api';

import { currentTraceContext, withWorkflowTrace } from './workflow-trace';

type WorkflowTraceHarness = {
    traceId: string;
    stage<T>(name: string, attributes: Attributes, work: () => Promise<T>): Promise<T>;
};

type MockSpan = {
    readonly name: string;
    readonly setAttributes: jest.Mock<void, [Attributes]>;
    readonly recordException: jest.Mock<void, [Error]>;
    readonly setStatus: jest.Mock<void, [{ code: SpanStatusCode; message?: string }]>;
    readonly end: jest.Mock<void, []>;
    readonly spanContext: () => { traceId: string; spanId: string };
};

function buildMockSpan(name: string, traceId: string, spanId: string): MockSpan {
    return {
        name,
        setAttributes: jest.fn(),
        recordException: jest.fn(),
        setStatus: jest.fn(),
        end: jest.fn(),
        spanContext: () => ({ traceId, spanId }),
    };
}

describe('currentTraceContext', () => {
    const originalXrayTrace = process.env['_X_AMZN_TRACE_ID'];

    afterEach(() => {
        jest.restoreAllMocks();
        if (originalXrayTrace === undefined) delete process.env['_X_AMZN_TRACE_ID'];
        else process.env['_X_AMZN_TRACE_ID'] = originalXrayTrace;
    });

    it('returns the active OTel trace and span ids', () => {
        const traceId = '0123456789abcdef0123456789abcdef';
        const spanId = '0123456789abcdef';
        jest.spyOn(trace, 'getSpan').mockReturnValue({
            spanContext: () => ({ traceId, spanId }),
        } as never);

        expect(currentTraceContext()).toEqual({ traceId, spanId });
    });

    it('falls back to the Lambda X-Ray environment when no OTel span is active', () => {
        process.env['_X_AMZN_TRACE_ID'] =
            'Root=1-5e1b4151-5ac6c58dc39a6f7d8b1c;Parent=53995c3f42cd8ad8;Sampled=1';

        expect(currentTraceContext()).toEqual({
            traceId: '1-5e1b4151-5ac6c58dc39a6f7d8b1c',
            spanId: '53995c3f42cd8ad8',
        });
    });
});

describe('withWorkflowTrace', () => {
    const traceId = '0123456789abcdef0123456789abcdef';
    let rootSpan: MockSpan;
    let stageSpan: MockSpan;

    beforeEach(() => {
        rootSpan = buildMockSpan('project-generation', traceId, '1111111111111111');
        stageSpan = buildMockSpan('project-generation.cluster', traceId, '2222222222222222');

        jest.spyOn(trace, 'getTracer').mockReturnValue({
            startSpan: jest.fn(() => rootSpan),
            startActiveSpan: jest.fn((
                name: string,
                _options: { attributes: Attributes },
                _activeContext: unknown,
                callback: (span: MockSpan) => Promise<unknown>,
            ) => {
                stageSpan = buildMockSpan(name, traceId, '2222222222222222');
                return callback(stageSpan);
            }),
        } as never);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('keeps the workflow root and stage spans on the same trace id', async () => {
        const { result, traceId: workflowTraceId } = await withWorkflowTrace(
            {
                name: 'project-generation',
                parentContext: context.active(),
                attributes: { 'workflow.name': 'project-generation' },
            },
            async (workflow: WorkflowTraceHarness) => {
                const stageResult = await workflow.stage(
                    'project-generation.cluster',
                    { 'workflow.stage': 'cluster' },
                    async () => 'clustered',
                );

                return {
                    workflowTraceId: workflow.traceId,
                    stageResult,
                };
            },
        );

        expect(workflowTraceId).toBe(traceId);
        expect(result.workflowTraceId).toBe(traceId);
        expect(result.stageResult).toBe('clustered');
        expect(rootSpan.spanContext().traceId).toBe(traceId);
        expect(stageSpan.spanContext().traceId).toBe(traceId);
        expect(rootSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
        expect(rootSpan.end).toHaveBeenCalled();
        expect(stageSpan.end).toHaveBeenCalled();
    });

    it('marks the stage and workflow spans as errors when a stage throws', async () => {
        const boom = new Error('stage failed');

        await expect(withWorkflowTrace(
            {
                name: 'project-generation',
                parentContext: context.active(),
                attributes: { 'workflow.name': 'project-generation' },
            },
            async (workflow: WorkflowTraceHarness) => workflow.stage(
                'project-generation.case-study',
                { 'workflow.stage': 'case-study' },
                async () => {
                    throw boom;
                },
            ),
        )).rejects.toBe(boom);

        expect(stageSpan.recordException).toHaveBeenCalledWith(boom);
        expect(stageSpan.setStatus).toHaveBeenCalledWith({
            code: SpanStatusCode.ERROR,
            message: 'stage failed',
        });
        expect(rootSpan.recordException).toHaveBeenCalledWith(boom);
        expect(rootSpan.setStatus).toHaveBeenCalledWith({
            code: SpanStatusCode.ERROR,
            message: 'stage failed',
        });
        expect(rootSpan.end).toHaveBeenCalled();
        expect(stageSpan.end).toHaveBeenCalled();
    });
});
