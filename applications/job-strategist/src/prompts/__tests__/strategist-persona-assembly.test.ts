/** @format */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleStrategistBody } from '../strategist-persona.js';

const golden = readFileSync(join(__dirname, '__fixtures__/strategist-persona-golden.txt'), 'utf8');

describe('strategist body persona assembly', () => {
    it('assembled modules reproduce the pre-split persona body byte-for-byte', () => {
        expect(assembleStrategistBody()).toBe(golden);
    });
});
