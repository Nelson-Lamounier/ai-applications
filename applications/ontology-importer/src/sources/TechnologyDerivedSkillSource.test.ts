/** @format */
import { describe, it, expect } from '@jest/globals';
import { TechnologyDerivedSkillSource, type TechOntologyRow } from './TechnologyDerivedSkillSource.js';
import type { RawImportEntry } from '@bedrock/shared';

async function collect(src: TechnologyDerivedSkillSource): Promise<RawImportEntry[]> {
    const out: RawImportEntry[] = [];
    for await (const e of src.fetch()) out.push(e);
    return out;
}

const rows: TechOntologyRow[] = [
    { canonical_name: 'React', category: 'framework_web', aliases: ['React.js', 'ReactJS'] },
    { canonical_name: 'aws_cdk', category: 'iac', aliases: ['CDK'] },
    { canonical_name: '  ', category: 'language', aliases: [] }, // blank → skipped
];

describe('TechnologyDerivedSkillSource', () => {
    it('lowercases + maps category; underscore canonicals become spaced with the raw form kept as an alias', async () => {
        const out = await collect(new TechnologyDerivedSkillSource(async () => rows));
        expect(out.map((e) => e.proposed_canonical_name)).toEqual(['react', 'aws cdk']);
        const react = out.find((e) => e.proposed_canonical_name === 'react')!;
        expect(react.keywords).toEqual(['react.js', 'reactjs']);
        expect((react.source_metadata as { category: string }).category).toBe('frontend'); // framework_web -> frontend
        const cdk = out.find((e) => e.proposed_canonical_name === 'aws cdk')!;
        expect(cdk.keywords).toEqual(['aws_cdk', 'cdk']); // raw underscore form kept as alias
        expect((cdk.source_metadata as { category: string }).category).toBe('infrastructure'); // iac -> infrastructure
    });

    it('stamps derived provenance for the audit', async () => {
        const [react] = await collect(new TechnologyDerivedSkillSource(async () => [rows[0]]));
        expect((react.source_metadata as { derived_from: string }).derived_from).toBe('technology_ontology');
    });

    it('declares the derived licence', () => {
        expect(new TechnologyDerivedSkillSource(async () => []).licence).toBe('derived');
    });
});
