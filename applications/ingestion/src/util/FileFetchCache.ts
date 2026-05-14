export class FileFetchCache {
    private readonly cache = new Map<string, string | null>();

    get(path: string): { hit: boolean; value: string | null | undefined } {
        if (this.cache.has(path)) return { hit: true, value: this.cache.get(path) };
        return { hit: false, value: undefined };
    }

    set(path: string, content: string | null): void {
        this.cache.set(path, content);
    }

    clear(): void {
        this.cache.clear();
    }

    size(): number {
        return this.cache.size;
    }
}
