/**
 * @format
 * preserveResumeFields — repair lossy rewrite round-trips.
 *
 * Every refinement pass re-emits the FULL resume through a tool schema, and
 * any field that schema under-specifies is silently dropped (observed live:
 * both projects[].github links vanished between the writer's original and
 * the persisted resume). Restore what a rewrite dropped, never touching what
 * it changed: rewritten values always win; only ABSENT fields are restored.
 * Pure + total; a null original is a no-op.
 */
import type { StructuredResumeData } from '@bedrock/shared';

interface LooseProject { readonly name?: unknown; readonly github?: unknown; [k: string]: unknown }
interface LooseResume { projects?: readonly LooseProject[]; [k: string]: unknown }

function restoreProjectGithub(
	origProjects: readonly LooseProject[],
	current: readonly LooseProject[],
): LooseProject[] {
	return current.map((p, i) => {
		if (p.github != null) return p;
		// Same index first (rewrites preserve order), then name match.
		const byIndex = origProjects[i];
		const source = (byIndex && byIndex.name === p.name ? byIndex : undefined)
			?? origProjects.find((o) => o.name != null && o.name === p.name)
			?? byIndex;
		return source?.github != null ? { ...p, github: source.github } : p;
	});
}

export function preserveResumeFields(
	original: StructuredResumeData | null | undefined,
	current: StructuredResumeData,
): StructuredResumeData {
	if (!original) return current;
	const o = original as unknown as LooseResume;
	const c = current as unknown as LooseResume;
	const merged: LooseResume = { ...c };
	// Top-level keys the rewrite dropped entirely.
	for (const key of Object.keys(o)) {
		if (!(key in c)) merged[key] = o[key];
	}
	if (Array.isArray(o.projects) && Array.isArray(c.projects)) {
		merged.projects = restoreProjectGithub(o.projects, c.projects);
	}
	return merged as unknown as StructuredResumeData;
}
