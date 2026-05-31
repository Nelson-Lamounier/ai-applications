import { describe, it, expect } from '@jest/globals';
import { mapSeniorityLevel, pickStage } from './derive-stage.js';

describe('mapSeniorityLevel', () => {
    it('maps the 5 source levels to 4 ontology stages', () => {
        expect(mapSeniorityLevel('junior')).toBe('junior');
        expect(mapSeniorityLevel('mid')).toBe('mid');
        expect(mapSeniorityLevel('mid-senior')).toBe('senior');
        expect(mapSeniorityLevel('senior')).toBe('senior');
        expect(mapSeniorityLevel('staff+')).toBe('staff');
    });
    it('returns null for an unknown level', () => { expect(mapSeniorityLevel('wizard')).toBeNull(); });
});
describe('pickStage', () => {
    it('returns null for empty seniority', () => { expect(pickStage([])).toBeNull(); });
    it('picks the highest area level', () => {
        expect(pickStage([{ area: 'frontend', level: 'mid' }, { area: 'backend', level: 'staff+' }, { area: 'infra', level: 'senior' }])).toBe('staff');
    });
    it('ignores unmappable levels but still picks the highest valid', () => {
        expect(pickStage([{ area: 'x', level: 'wizard' }, { area: 'y', level: 'mid' }])).toBe('mid');
        expect(pickStage([{ area: 'x', level: 'wizard' }])).toBeNull();
    });
});
