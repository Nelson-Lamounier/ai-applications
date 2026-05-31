import { describe, it, expect } from '@jest/globals';
import { deriveSignals, classifyArchetype } from './archetype-classifier.js';
import type { ArchetypeDef, ClassifyInput } from './archetype-types.js';

const ARCHETYPES: ArchetypeDef[] = [
    { id: 'production_saas', name: 'P', description: '', expectedSections: [], expectedArtifacts: [],
      classificationSignals: { required_any: ['has_iac','has_dockerfile'], positive: ['has_ci'], negative: ['notebook_heavy'] } },
    { id: 'ml_research', name: 'M', description: '', expectedSections: [], expectedArtifacts: [],
      classificationSignals: { required_any: ['has_notebooks'], positive: ['has_data_dir'], negative: ['has_iac'] } },
    { id: 'cli_tool', name: 'C', description: '', expectedSections: [], expectedArtifacts: [],
      classificationSignals: { required_any: ['has_bin_field'], positive: [], negative: ['has_iac'] } },
];

describe('deriveSignals', () => {
    it('detects notebooks + iac from file paths and tech stack', () => {
        const s = deriveSignals({ projectType: 'side_project', projectShape: 'single_repo',
            repos: [{ primaryLanguage: 'Python', topics: ['ml'], techStack: ['pytorch'], filePaths: ['train.ipynb', 'data/x.csv'] }] });
        expect(s.has_notebooks).toBe(true);
        expect(s.has_iac).toBe(false);
    });
    it('detects iac from infra-ish paths', () => {
        const s = deriveSignals({ projectType: 'production_saas', projectShape: 'multi_repo',
            repos: [{ primaryLanguage: 'TypeScript', topics: [], techStack: ['kubernetes'], filePaths: ['infra/terraform/main.tf', 'src/app.ts'] }] });
        expect(s.has_iac).toBe(true);
    });
});
describe('classifyArchetype', () => {
    it('classifies an ML repo (notebooks) over production_saas', () => {
        const r = classifyArchetype({ projectType: 'learning_project', projectShape: 'single_repo',
            repos: [{ primaryLanguage: 'Python', topics: ['machine-learning'], techStack: ['pytorch','jupyter'], filePaths: ['notebooks/explore.ipynb', 'data/train.csv'] }] }, ARCHETYPES);
        expect(r?.archetypeId).toBe('ml_research');
    });
    it('classifies a SaaS repo (iac + ci) and applies projectType prior', () => {
        const r = classifyArchetype({ projectType: 'production_saas', projectShape: 'multi_repo',
            repos: [{ primaryLanguage: 'TypeScript', topics: [], techStack: ['docker','github-actions'], filePaths: ['infra/k8s/deploy.yaml', '.github/workflows/ci.yml'] }] }, ARCHETYPES);
        expect(r?.archetypeId).toBe('production_saas');
    });
    it('returns null when no archetype scores positively', () => {
        const r = classifyArchetype({ projectType: 'side_project', projectShape: 'single_repo',
            repos: [{ primaryLanguage: 'TypeScript', topics: [], techStack: [], filePaths: ['README.md'] }] }, ARCHETYPES);
        expect(r).toBeNull();
    });
    it('tolerates empty repos array (returns null, no throw)', () => {
        expect(classifyArchetype({ projectType: 'side_project', projectShape: 'single_repo', repos: [] }, ARCHETYPES)).toBeNull();
    });
});
