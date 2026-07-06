/**
 * disclosure-gate.ts
 *
 * Pure predicate: does the structural-lint output contain a disclosure finding
 * that must HARD-BLOCK publish? Kept separate from run-pipeline.ts so it is unit
 * testable without Bedrock/RDS. Only `error`-severity identifier leaks block;
 * security-claim findings are `warn` (routed to QA, not blocking).
 */
import type { Finding } from './article-lint-rules.js';

/** True if any finding is an error-severity reachable-identifier leak. */
export function hasDisclosureBlocker(findings: readonly Finding[]): boolean {
  return findings.some(
    (f) => f.severity === 'error' && f.rule.startsWith('identifier-leak:'),
  );
}
