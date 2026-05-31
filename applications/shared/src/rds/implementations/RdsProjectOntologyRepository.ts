/** @format */
import type { Pool } from 'pg';
import type { ArchetypeDef, StageOverlay, StageId } from '../../projects/archetype-types.js';

interface ArchetypeRow {
    id: string; name: string; description: string;
    classification_signals: { required_any?: string[]; positive?: string[]; negative?: string[] };
    expected_sections: string[]; expected_artifacts: string[];
}
interface OverlayRow {
    archetype_id: string; stage: string;
    priority_sections: string[]; deemphasized_sections: string[];
    stage_suggestions: Array<{ title: string; description: string }>;
}
function toArchetype(r: ArchetypeRow): ArchetypeDef {
    return {
        id: r.id, name: r.name, description: r.description,
        classificationSignals: r.classification_signals ?? {},
        expectedSections: r.expected_sections ?? [],
        expectedArtifacts: r.expected_artifacts ?? [],
    };
}
export class RdsProjectOntologyRepository {
    constructor(private readonly pool: Pool) {}
    async getArchetype(id: string): Promise<ArchetypeDef | null> {
        const r = await this.pool.query<ArchetypeRow>(
            `SELECT id, name, description, classification_signals, expected_sections, expected_artifacts
               FROM project_archetypes WHERE id = $1`, [id]);
        return r.rows[0] ? toArchetype(r.rows[0]) : null;
    }
    async listArchetypes(): Promise<ArchetypeDef[]> {
        const r = await this.pool.query<ArchetypeRow>(
            `SELECT id, name, description, classification_signals, expected_sections, expected_artifacts
               FROM project_archetypes`);
        return r.rows.map(toArchetype);
    }
    async getStageOverlay(archetypeId: string, stage: StageId): Promise<StageOverlay | null> {
        const r = await this.pool.query<OverlayRow>(
            `SELECT archetype_id, stage, priority_sections, deemphasized_sections, stage_suggestions
               FROM project_stage_overlays WHERE archetype_id = $1 AND stage = $2`, [archetypeId, stage]);
        const row = r.rows[0];
        if (!row) return null;
        return {
            archetypeId: row.archetype_id, stage: row.stage as StageId,
            prioritySections: row.priority_sections ?? [],
            deemphasizedSections: row.deemphasized_sections ?? [],
            stageSuggestions: (row.stage_suggestions ?? []).map(s => ({ title: s.title, description: s.description })),
        };
    }
}
