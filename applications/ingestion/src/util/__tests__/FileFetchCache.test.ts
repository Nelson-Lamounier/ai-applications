import { FileFetchCache } from '../FileFetchCache';

describe('FileFetchCache', () => {
    it('returns miss for unseen path', () => {
        const cache = new FileFetchCache();
        const result = cache.get('README.md');
        expect(result.hit).toBe(false);
        expect(result.value).toBeUndefined();
    });

    it('returns hit and value after set with string', () => {
        const cache = new FileFetchCache();
        cache.set('README.md', '# Hello');
        const result = cache.get('README.md');
        expect(result.hit).toBe(true);
        expect(result.value).toBe('# Hello');
    });

    it('caches null (absent files)', () => {
        const cache = new FileFetchCache();
        cache.set('CHANGELOG.md', null);
        const result = cache.get('CHANGELOG.md');
        expect(result.hit).toBe(true);
        expect(result.value).toBeNull();
    });

    it('clear removes all entries', () => {
        const cache = new FileFetchCache();
        cache.set('a', 'content');
        cache.clear();
        expect(cache.size()).toBe(0);
        expect(cache.get('a').hit).toBe(false);
    });

    it('size returns entry count', () => {
        const cache = new FileFetchCache();
        cache.set('a', 'x');
        cache.set('b', null);
        expect(cache.size()).toBe(2);
    });
});
