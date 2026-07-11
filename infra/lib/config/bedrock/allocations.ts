/**
 * @format
 * Bedrock Project - Resource Allocations
 *
 * Centralized resource allocations by environment.
 * Allocations are "how much" - model selection, Lambda sizing, timeouts.
 *
 * Usage:
 * ```typescript
 * import { getBedrockAllocations } from '../../config/bedrock';
 * const allocs = getBedrockAllocations(Environment.PRODUCTION);
 * const model = allocs.apiLambda.chatbotModel;
 * ```
 */

import { type DeployableEnvironment, Environment } from '../environments';
import { MODELS } from '../shared/model-registry';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Lambda allocation for API invoke handler
 */
export interface ApiLambdaAllocation {
    /** Lambda memory in MB */
    readonly memoryMb: number;
    /** Lambda timeout in seconds */
    readonly timeoutSeconds: number;
    /** Bedrock model ID for RAG-based chatbot Lambdas (chatbot-public + chatbot-authenticated) */
    readonly chatbotModel: string;
}

/**
 * API Gateway throttling allocation
 */
export interface ApiGatewayAllocation {
    /** Sustained request rate limit (requests/second) */
    readonly throttlingRateLimit: number;
    /** Burst capacity (maximum concurrent requests) */
    readonly throttlingBurstLimit: number;
}

/**
 * Complete resource allocations for Bedrock project
 */
export interface BedrockAllocations {
    readonly apiLambda: ApiLambdaAllocation;
    readonly apiGateway: ApiGatewayAllocation;
}

// =============================================================================
// ALLOCATIONS BY ENVIRONMENT
// =============================================================================

/**
 * Bedrock resource allocations by environment
 */
export const BEDROCK_ALLOCATIONS: Record<DeployableEnvironment, BedrockAllocations> = {
    [Environment.DEVELOPMENT]: {
        apiLambda: {
            memoryMb: 256,
            timeoutSeconds: 60,
            chatbotModel: MODELS.CHATBOT_CONVERSE,
        },
        apiGateway: {
            throttlingRateLimit: 10,
            throttlingBurstLimit: 20,
        },
    },

    [Environment.STAGING]: {
        apiLambda: {
            memoryMb: 512,
            timeoutSeconds: 60,
            chatbotModel: MODELS.CHATBOT_CONVERSE,
        },
        apiGateway: {
            throttlingRateLimit: 50,
            throttlingBurstLimit: 100,
        },
    },

    [Environment.PRODUCTION]: {
        apiLambda: {
            memoryMb: 1024,
            timeoutSeconds: 120,
            chatbotModel: MODELS.CHATBOT_CONVERSE,
        },
        apiGateway: {
            throttlingRateLimit: 100,
            throttlingBurstLimit: 200,
        },
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get Bedrock allocations for an environment
 */
export function getBedrockAllocations(env: Environment): BedrockAllocations {
    return BEDROCK_ALLOCATIONS[env as DeployableEnvironment];
}
