/** @format */
import { formatTechTransferContext } from '../tech-transfer-context.js';

const aiProviderGroup = ['anthropic_claude', 'openai', 'aws_bedrock', 'chatgpt', 'codex'];
const containerGroup = ['docker', 'podman', 'containerd'];
const techGroups = [aiProviderGroup, containerGroup];

const aliasMap = new Map<string, string>([
    ['openai api', 'openai'],
    ['openai', 'openai'],
    ['chatgpt', 'chatgpt'],
    ['codex', 'codex'],
    ['anthropic claude', 'anthropic_claude'],
    ['claude', 'anthropic_claude'],
    ['aws bedrock', 'aws_bedrock'],
    ['bedrock', 'aws_bedrock'],
    ['amazon bedrock', 'aws_bedrock'],
    ['docker', 'docker'],
    ['podman', 'podman'],
    ['containerd', 'containerd'],
]);

describe('formatTechTransferContext', () => {
    it('returns a non-empty context block when a JD tool is in a group', () => {
        const result = formatTechTransferContext(['AWS Bedrock'], techGroups, aliasMap);
        expect(result).toContain('## Technology Transferability');
        expect(result).toContain('aws bedrock');
        expect(result).toContain('openai');
        expect(result).toContain('anthropic claude');
    });

    it('returns "" when no JD tool intersects any group', () => {
        const result = formatTechTransferContext(['Salesforce', 'COBOL'], techGroups, aliasMap);
        expect(result).toBe('');
    });

    it('returns "" for empty jdTools', () => {
        expect(formatTechTransferContext([], techGroups, aliasMap)).toBe('');
    });

    it('returns "" for empty techGroups', () => {
        expect(formatTechTransferContext(['AWS Bedrock'], [], aliasMap)).toBe('');
    });

    it('includes only the groups that intersect the JD tools — not the full ontology', () => {
        // Only AWS Bedrock in JD — should include AI provider group but NOT container group
        const result = formatTechTransferContext(['AWS Bedrock'], techGroups, aliasMap);
        expect(result).not.toContain('docker');
        expect(result).not.toContain('podman');
        expect(result).not.toContain('containerd');
    });

    it('includes multiple groups when multiple JD tools span multiple groups', () => {
        const result = formatTechTransferContext(['AWS Bedrock', 'Docker'], techGroups, aliasMap);
        expect(result).toContain('aws bedrock');
        expect(result).toContain('docker');
        expect(result).toContain('podman');
    });

    it('header is present once regardless of number of matching groups', () => {
        const result = formatTechTransferContext(['AWS Bedrock', 'Docker'], techGroups, aliasMap);
        const headerCount = (result.match(/## Technology Transferability/g) ?? []).length;
        expect(headerCount).toBe(1);
    });

    it('each matching group emits exactly one line', () => {
        const result = formatTechTransferContext(['AWS Bedrock', 'Docker'], techGroups, aliasMap);
        const bulletLines = result.split('\n').filter((l) => l.startsWith('- '));
        expect(bulletLines).toHaveLength(2);
    });

    it('canonicalisation divergence fix: a punctuation-bearing JD term with no alias hit resolves via the shared normalizeTerm-based fallback (Node.js -> node_js), matching a group containing that canonical', () => {
        const runtimeGroup = ['node_js', 'deno', 'bun'];
        const result = formatTechTransferContext(['Node.js'], [runtimeGroup], new Map());
        expect(result).toContain('## Technology Transferability');
        expect(result).toContain('deno');
        expect(result).toContain('bun');
    });
});
