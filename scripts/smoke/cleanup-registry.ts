/** @format */
import type { CleanupTarget } from './types.js';

export class CleanupRegistry {
  private readonly targets: CleanupTarget[] = [];
  register(t: CleanupTarget): void { this.targets.push(t); }
  list(): readonly CleanupTarget[] { return this.targets; }
  isEmpty(): boolean { return this.targets.length === 0; }
}
