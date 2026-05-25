/** @format */
import { describe, it, expect } from '@jest/globals';
import { partitionAliases } from './aliasFilters.js';

describe('partitionAliases', () => {
    it('splits into insertable vs colliding-with-other-tech', () => {
        const existing = new Map<string, string>([['react', 'id-react'], ['s3', 'id-s3']]);
        const { insertable, collisions } = partitionAliases(['react', 'react.js', 's3'], 'id-react', existing);
        // 'react' already maps to this tech (no-op), 'react.js' is new, 's3' collides with a DIFFERENT tech
        expect(insertable).toEqual(['react.js']);
        expect(collisions).toEqual(['s3']);
    });
});
