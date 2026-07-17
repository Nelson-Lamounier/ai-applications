import { describe, it, expect } from '@jest/globals';
import { classifyArchetype } from './archetype-classifier.js';
import type { ArchetypeDef } from './archetype-types.js';

const ARCHETYPES: ArchetypeDef[] = [
    { id: 'production_saas', name: 'P', description: '', expectedSections: [], expectedArtifacts: [],
      classificationSignals: { required_any: ['has_iac','has_dockerfile'], positive: ['has_ci'], negative: ['notebook_heavy'] } },
    { id: 'ml_research', name: 'M', description: '', expectedSections: [], expectedArtifacts: [],
      classificationSignals: { required_any: ['has_notebooks'], positive: ['has_data_dir'], negative: ['has_iac'] } },
    { id: 'cli_tool', name: 'C', description: '', expectedSections: [], expectedArtifacts: [],
      classificationSignals: { required_any: ['has_bin_field'], positive: [], negative: ['has_iac'] } },
];

describe('classifyArchetype', () => {
    it('classifies an ML repo (notebooks) over production_saas', () => {
        const r = classifyArchetype({ has_notebooks: true, has_data_dir: true }, 'learning_project', ARCHETYPES);
        expect(r?.archetypeId).toBe('ml_research');
    });
    it('classifies a SaaS repo (iac + ci) and applies projectType prior', () => {
        const r = classifyArchetype({ has_iac: true, has_ci: true }, 'production_saas', ARCHETYPES);
        expect(r?.archetypeId).toBe('production_saas');
    });
    it('returns null when no archetype scores positively', () => {
        const r = classifyArchetype({}, 'side_project', ARCHETYPES);
        expect(r).toBeNull();
    });
    it('tolerates empty signals (returns null, no throw)', () => {
        expect(classifyArchetype({}, 'side_project', ARCHETYPES)).toBeNull();
    });
});
