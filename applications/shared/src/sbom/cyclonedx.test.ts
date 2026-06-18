/** @format */
import { buildCycloneDxBom, technologyEvidenceToComponents } from './cyclonedx.js';

describe('buildCycloneDxBom', () => {
    it('wraps components in a CycloneDX 1.6 envelope', () => {
        const bom = buildCycloneDxBom(
            [{ name: 'cors', purl: 'pkg:npm/cors' }],
            { repoFullName: 'owner/repo' },
        );
        expect(bom.bomFormat).toBe('CycloneDX');
        expect(bom.specVersion).toBe('1.6');
        expect(bom.components).toHaveLength(1);
        expect(bom.components[0]).toMatchObject({ type: 'library', name: 'cors', purl: 'pkg:npm/cors' });
    });

    it('identifies the subject repository in metadata.component', () => {
        const bom = buildCycloneDxBom([], { repoFullName: 'owner/repo', commitSha: 'abc123' });
        expect(bom.metadata.component).toEqual({
            type: 'application',
            name: 'owner/repo',
            version: 'abc123',
        });
    });
});

describe('technologyEvidenceToComponents', () => {
    it('maps evidence rows to purl-identified components, deduped by purl', () => {
        const comps = technologyEvidenceToComponents([
            { rawName: 'cors', ecosystem: 'npm' },
            { rawName: 'cors', ecosystem: 'npm' }, // same tech, another file → one component
            { rawName: 's3', ecosystem: 'aws' },
        ]);
        expect(comps).toEqual([
            { name: 'cors', purl: 'pkg:npm/cors' },
            { name: 's3', purl: 'pkg:generic/s3' },
        ]);
    });
});
