/**
 * @format
 * Aurora Serverless v2 + pgvector — Resource Allocations
 *
 * Controls ACU (Aurora Capacity Unit) sizing per environment.
 * Allocations are "how much" — min/max compute capacity.
 *
 * ACU scale-to-zero:
 *   minAcu: 0  → cluster pauses after ~5 min inactivity (true zero cost)
 *   minAcu: 0.5 → always-on warm standby (~$43/month baseline)
 *
 * Cold-start penalty when minAcu=0: 20–30 s on first query after pause.
 * Acceptable for ingestion pipelines (batch). Add a keep-warm mechanism
 * for resume generation when real users exist.
 *
 * Usage:
 * ```typescript
 * import { getAuroraAllocations } from '../../config/bedrock/aurora-allocations';
 * const allocs = getAuroraAllocations(Environment.DEVELOPMENT);
 * ```
 */

import { type DeployableEnvironment, Environment } from '../environments';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

export interface AuroraAllocation {
    /**
     * Minimum ACU capacity.
     * Use 0 for true scale-to-zero/pause behaviour (cold-start on first query).
     * Use 0.5 to keep cluster always warm (incurs baseline cost).
     */
    readonly minAcu: number;
    /** Maximum ACU capacity. Cluster scales up to this limit under load. */
    readonly maxAcu: number;
}

// =============================================================================
// ENVIRONMENT ALLOCATIONS
// =============================================================================

const AURORA_ALLOCATIONS: Record<DeployableEnvironment, AuroraAllocation> = {
    [Environment.DEVELOPMENT]: {
        minAcu: 0,  // pause after inactivity — zero idle cost in dev
        maxAcu: 4,
    },
    [Environment.STAGING]: {
        minAcu: 0,  // pause after inactivity — zero idle cost in staging
        maxAcu: 4,
    },
    [Environment.PRODUCTION]: {
        minAcu: 0,  // pause after inactivity — add keep-warm when real users warrant it
        maxAcu: 8,
    },
};

// =============================================================================
// ACCESSOR
// =============================================================================

export function getAuroraAllocations(environment: Environment): AuroraAllocation {
    return AURORA_ALLOCATIONS[environment as DeployableEnvironment];
}
