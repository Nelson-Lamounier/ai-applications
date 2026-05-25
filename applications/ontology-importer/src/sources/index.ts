/** @format */
import type { Source } from './Source.js';
import { AwsBotocoreSource } from './AwsBotocoreSource.js';
import { GcpServiceUsageSource } from './GcpServiceUsageSource.js';
import { AzureRestSpecsSource } from './AzureRestSpecsSource.js';
import { NpmRegistrySource } from './NpmRegistrySource.js';
import { PypiBigQuerySource } from './PypiBigQuerySource.js';
import { CratesIoSource } from './CratesIoSource.js';
import { MavenCentralSource } from './MavenCentralSource.js';
import npmTop from './data/npm-top-5k.json';
import pypiTop from './data/pypi-top-5k.json';

export * from './Source.js';
export {
    AwsBotocoreSource,
    GcpServiceUsageSource,
    AzureRestSpecsSource,
    NpmRegistrySource,
    PypiBigQuerySource,
    CratesIoSource,
    MavenCentralSource,
};

/** Factory: the seven registry sources, configured from env/committed data. */
export function ALL_SOURCES(): Source[] {
    return [
        new AwsBotocoreSource(),
        new GcpServiceUsageSource(),
        new AzureRestSpecsSource(),
        new NpmRegistrySource(npmTop as string[]),
        new PypiBigQuerySource(pypiTop as string[]),
        new CratesIoSource(),
        new MavenCentralSource(),
    ];
}
