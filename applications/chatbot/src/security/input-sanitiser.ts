/**
 * @format
 * Input Sanitiser — Deprecated Facade
 *
 * ⚠️  DEPRECATED: This module is a compatibility shim. All consumers
 * should import from `@bedrock/shared` (or `@bedrock/shared`).
 *
 * Preserved temporarily for any transient imports during migration.
 * Will be removed in the next cleanup pass.
 */

import { InputSanitiser } from '@bedrock/shared';
import type { SanitiseInputResult } from '@bedrock/shared';

const _sanitiser = new InputSanitiser();

/**
 * @deprecated Use `new InputSanitiser().sanitise()` from `@bedrock/shared`.
 */
export function sanitiseInput(raw: string): SanitiseInputResult {
    return _sanitiser.sanitise(raw);
}

export type { SanitiseInputResult };
