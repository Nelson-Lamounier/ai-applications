/** @format */
import { toPurl } from './purl.js';

describe('toPurl', () => {
    it('builds an npm Package URL from ecosystem + name', () => {
        expect(toPurl({ ecosystem: 'npm', name: 'cors' })).toBe('pkg:npm/cors');
    });

    it('appends the version when present', () => {
        expect(toPurl({ ecosystem: 'npm', name: 'cors', version: '2.8.5' })).toBe('pkg:npm/cors@2.8.5');
    });

    it('maps a non-package ecosystem to the generic purl type', () => {
        expect(toPurl({ ecosystem: 'aws', name: 's3' })).toBe('pkg:generic/s3');
    });

    it('falls back to generic when the ecosystem is missing', () => {
        expect(toPurl({ ecosystem: '', name: 'traefik' })).toBe('pkg:generic/traefik');
    });

    it('percent-encodes the @ in an npm scope but keeps the scope separator', () => {
        expect(toPurl({ ecosystem: 'npm', name: '@aws-sdk/client-s3', version: '3.0.0' }))
            .toBe('pkg:npm/%40aws-sdk/client-s3@3.0.0');
    });
});
