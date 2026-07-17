/** @format */
import type { TechTransferGroup } from '@bedrock/shared';
import { formatTechTransferContext } from '../tech-transfer-context.js';

/** Untyped test fixture group — mirrors an ontology component with no relationship-graph metadata. */
const asGroup = (members: string[]): TechTransferGroup =>
    ({ members, transferClass: null, transferTier: null, transferBasis: null });

const aiProviderGroup = ['anthropic_claude', 'openai', 'aws_bedrock', 'chatgpt', 'codex'];
const containerGroup = ['docker', 'podman', 'containerd'];
const techGroups: TechTransferGroup[] = [asGroup(aiProviderGroup), asGroup(containerGroup)];

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
        const result = formatTechTransferContext(['Node.js'], [asGroup(runtimeGroup)], new Map());
        expect(result).toContain('## Technology Transferability');
        expect(result).toContain('deno');
        expect(result).toContain('bun');
    });

    describe('tier + basis rendering', () => {
        const iacMembers = ['terraform', 'aws_cdk', 'cloudformation'];
        const iacGroupFull: TechTransferGroup = {
            members: iacMembers,
            transferClass: 'infra-as-code',
            transferTier: 'full',
            transferBasis: 'Declarative infrastructure-as-code',
        };
        const iacGroupPartial: TechTransferGroup = {
            members: iacMembers,
            transferClass: 'infra-as-code',
            transferTier: 'partial',
            transferBasis: 'Declarative infrastructure-as-code',
        };
        const iacAliasMap = new Map<string, string>([
            ['terraform', 'terraform'],
            ['aws cdk', 'aws_cdk'],
            ['cloudformation', 'cloudformation'],
        ]);

        it('appends "(full transfer: <basis>)" to the group line for a full tier group', () => {
            const result = formatTechTransferContext(['Terraform'], [iacGroupFull], iacAliasMap);
            expect(result).toContain('(full transfer: Declarative infrastructure-as-code)');
        });

        it('appends the PARTIAL-evidence warning line for a partial tier group', () => {
            const result = formatTechTransferContext(['Terraform'], [iacGroupPartial], iacAliasMap);
            expect(result).toContain('Treat as PARTIAL evidence only - never claim direct experience.');
        });

        it('a full tier group does NOT emit the partial-evidence warning line', () => {
            const result = formatTechTransferContext(['Terraform'], [iacGroupFull], iacAliasMap);
            expect(result).not.toContain('Treat as PARTIAL evidence only');
        });

        it('groups with null metadata render exactly as today (no tier/basis suffix, no warning line)', () => {
            const result = formatTechTransferContext(['AWS Bedrock'], techGroups, aliasMap);
            expect(result).not.toContain('full transfer:');
            expect(result).not.toContain('Treat as PARTIAL evidence only');
        });

        it('appends "(partial transfer: <basis>)" to the group line for a partial tier group, ahead of the warning line', () => {
            const result = formatTechTransferContext(['Terraform'], [iacGroupPartial], iacAliasMap);
            expect(result).toContain('(partial transfer: Declarative infrastructure-as-code)');
            const basisIndex = result.indexOf('(partial transfer:');
            const warningIndex = result.indexOf('Treat as PARTIAL evidence only');
            expect(basisIndex).toBeGreaterThan(-1);
            expect(warningIndex).toBeGreaterThan(basisIndex);
        });
    });

    describe('typed-vs-untyped dedup — a canonical present in both a typed group and an untyped component', () => {
        const typedGroup: TechTransferGroup = {
            members: ['aws_bedrock', 'anthropic_claude'],
            transferClass: 'ai-provider',
            transferTier: 'full',
            transferBasis: 'LLM API usage patterns transfer directly',
        };
        const untypedBridgedComponent = asGroup(['aws_bedrock', 'aws_vpc', 'terraform']);
        const bridgedAliasMap = new Map<string, string>([
            ['aws bedrock', 'aws_bedrock'],
            ['bedrock', 'aws_bedrock'],
            ['anthropic claude', 'anthropic_claude'],
            ['claude', 'anthropic_claude'],
            ['aws vpc', 'aws_vpc'],
            ['terraform', 'terraform'],
        ]);

        it('typed group takes precedence: the untyped component is skipped when every JD canonical it matches is already covered by the typed group', () => {
            const result = formatTechTransferContext(
                ['AWS Bedrock'],
                [typedGroup, untypedBridgedComponent],
                bridgedAliasMap,
            );
            const bulletLines = result.split('\n').filter((l) => l.startsWith('- '));
            expect(bulletLines).toHaveLength(1);
            expect(result).toContain('anthropic claude');
            // The untyped component's own line (with aws_vpc/terraform) is skipped.
            expect(result).not.toContain('aws vpc');
        });

        it('the untyped component IS still emitted when it surfaces a JD canonical the typed group does not cover', () => {
            const result = formatTechTransferContext(
                ['AWS Bedrock', 'Terraform'],
                [typedGroup, untypedBridgedComponent],
                bridgedAliasMap,
            );
            const bulletLines = result.split('\n').filter((l) => l.startsWith('- '));
            expect(bulletLines).toHaveLength(2);
            expect(result).toContain('anthropic claude');
            expect(result).toContain('aws vpc');
        });
    });
});
