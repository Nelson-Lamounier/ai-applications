/** @format */
import { z } from 'zod';
import { clampOversizedFields, coerceArchitectureString } from '../case-study-schema-repair.js';

const ArchSchema = z.object({
    architecture: z.object({
        diagramFormat: z.enum(['mermaid', 'svg']),
        diagramSource: z.string().min(1),
        nodes: z.array(z.unknown()),
        edges: z.array(z.unknown()),
    }),
}).strict();

// A miniature schema mirroring the case-study shape: capped strings at the top
// level and inside an array of objects. Enough to exercise nested paths.
const Schema = z.object({
    tagline: z.string().max(10),
    items: z.array(z.object({ name: z.string().max(5) })).max(2),
    tags: z.array(z.string()).max(3),
}).strict();

describe('clampOversizedFields', () => {
    it('clamps a top-level over-length string to its max so re-validation passes', () => {
        const raw = { tagline: 'x'.repeat(40), items: [], tags: [] };
        const issues = Schema.safeParse(raw);
        expect(issues.success).toBe(false);
        if (issues.success) return;

        const repaired = clampOversizedFields(raw, issues.error.issues);
        const reparsed = Schema.safeParse(repaired);

        expect(reparsed.success).toBe(true);
        if (!reparsed.success) return;
        expect(reparsed.data.tagline).toBe('x'.repeat(10));   // truncated, not rejected
    });

    it('clamps an over-length string nested inside an array element (deep path)', () => {
        const raw = { tagline: 'ok', items: [{ name: 'short' }, { name: 'toolongname' }], tags: [] };
        const parsed = Schema.safeParse(raw);
        expect(parsed.success).toBe(false);
        if (parsed.success) return;

        const repaired = clampOversizedFields(raw, parsed.error.issues);
        const reparsed = Schema.safeParse(repaired);

        expect(reparsed.success).toBe(true);
        if (!reparsed.success) return;
        expect(reparsed.data.items[1]?.name).toBe('toolo');    // 5-char cap applied at items.1.name
        expect(reparsed.data.items[0]?.name).toBe('short');    // untouched
    });

    it('slices an over-long array to its max', () => {
        const raw = { tagline: 'ok', items: [], tags: ['a', 'b', 'c', 'd', 'e'] };
        const parsed = Schema.safeParse(raw);
        if (parsed.success) throw new Error('expected failure');

        const repaired = clampOversizedFields(raw, parsed.error.issues) as { tags: string[] };
        expect(repaired.tags).toEqual(['a', 'b', 'c']);        // sliced to max 3
    });

    it('does not invent or drop keys — only clamps the offending values', () => {
        const raw = { tagline: 'x'.repeat(40), items: [{ name: 'short' }], tags: ['a'] };
        const parsed = Schema.safeParse(raw);
        if (parsed.success) throw new Error('expected failure');

        const repaired = clampOversizedFields(raw, parsed.error.issues) as Record<string, unknown>;
        expect(Object.keys(repaired).sort((a, b) => a.localeCompare(b))).toEqual(['items', 'tagline', 'tags']);
        expect((repaired as { items: unknown[] }).items).toHaveLength(1);
    });

    it('leaves an unrepairable violation alone (re-validation still fails -> caller fails fast)', () => {
        // too_small (minLength) is NOT something clamping can fix.
        const MinSchema = z.object({ name: z.string().min(5) }).strict();
        const raw = { name: 'ab' };
        const parsed = MinSchema.safeParse(raw);
        if (parsed.success) throw new Error('expected failure');

        const repaired = clampOversizedFields(raw, parsed.error.issues);
        expect(MinSchema.safeParse(repaired).success).toBe(false);   // still invalid; no silent fabrication
    });

    it('does not mutate the original input', () => {
        const raw = { tagline: 'x'.repeat(40), items: [], tags: [] };
        const parsed = Schema.safeParse(raw);
        if (parsed.success) throw new Error('expected failure');

        clampOversizedFields(raw, parsed.error.issues);
        expect(raw.tagline).toBe('x'.repeat(40));   // original untouched (clone-based)
    });
});

describe('coerceArchitectureString', () => {
    it('wraps a bare-string architecture into the object form so re-validation passes', () => {
        const raw = { architecture: 'graph LR; A-->B' };
        const parsed = ArchSchema.safeParse(raw);
        expect(parsed.success).toBe(false);
        if (parsed.success) return;

        const repaired = coerceArchitectureString(raw, parsed.error.issues);
        const reparsed = ArchSchema.safeParse(repaired);

        expect(reparsed.success).toBe(true);
        if (!reparsed.success) return;
        expect(reparsed.data.architecture).toEqual({
            diagramFormat: 'mermaid', diagramSource: 'graph LR; A-->B', nodes: [], edges: [],
        });
    });

    it('parses a JSON-stringified architecture OBJECT instead of dumping the whole JSON into diagramSource', () => {
        // Sonnet sometimes emits the full architecture object as a JSON *string*
        // (invalid_type: expected object, received string). The string is NOT a
        // bare Mermaid diagram — wrapping it verbatim poisons diagramSource with
        // the entire JSON and leaves nodes/edges empty, which fails to render.
        const inner = {
            diagramFormat: 'mermaid',
            diagramSource: 'graph LR\n  A-->B',
            nodes: [{ id: 'A' }, { id: 'B' }],
            edges: [{ from: 'A', to: 'B' }],
        };
        const raw = { architecture: JSON.stringify(inner) };
        const parsed = ArchSchema.safeParse(raw);
        expect(parsed.success).toBe(false);
        if (parsed.success) return;

        const repaired = coerceArchitectureString(raw, parsed.error.issues);
        const reparsed = ArchSchema.safeParse(repaired);

        expect(reparsed.success).toBe(true);
        if (!reparsed.success) return;
        expect(reparsed.data.architecture.diagramSource).toBe('graph LR\n  A-->B'); // the real diagram, not the JSON
        expect(reparsed.data.architecture.nodes).toHaveLength(2);                    // recovered, not empty
        expect(reparsed.data.architecture.edges).toHaveLength(1);
    });

    it('leaves a valid object architecture untouched (no matching issue)', () => {
        const raw = { architecture: { diagramFormat: 'mermaid', diagramSource: 'x', nodes: [], edges: [] } };
        const parsed = ArchSchema.safeParse(raw);
        if (!parsed.success) throw new Error('fixture should be valid');
        // No issues -> coercion is a no-op passthrough.
        expect(coerceArchitectureString(raw, [])).toBe(raw);
    });

    it('does not coerce an empty string (would fail min(1)) — leaves it for the retry', () => {
        const raw = { architecture: '' };
        const parsed = ArchSchema.safeParse(raw);
        if (parsed.success) throw new Error('expected failure');

        const repaired = coerceArchitectureString(raw, parsed.error.issues);
        expect(repaired).toBe(raw);   // unchanged; structural fix deferred to the bounded retry
    });

    it('does not mutate the original input', () => {
        const raw = { architecture: 'graph TD; X-->Y' };
        const parsed = ArchSchema.safeParse(raw);
        if (parsed.success) throw new Error('expected failure');

        coerceArchitectureString(raw, parsed.error.issues);
        expect(raw.architecture).toBe('graph TD; X-->Y');   // original untouched
    });
});
