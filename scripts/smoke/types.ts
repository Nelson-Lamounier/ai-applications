/** @format */
export type FlowName =
  | 'job-strategist' | 'article-pipeline' | 'resume-import'
  | 'ingestion' | 'chatbots';

export const ALL_FLOWS: readonly FlowName[] = [
  'job-strategist', 'article-pipeline', 'resume-import', 'ingestion', 'chatbots',
] as const;

export interface Endpoints {
  adminApiBaseUrl: string;
  adminApiToken: string;
  chatbotUrl: string;
  chatbotPublicUrl: string;
  chatbotAuthenticatedUrl: string;
  chatbotAuthJwt: string | null;
  pgPassword: string;
  pgHost: string;
  pgPort: number;
  pgDatabase: string;
  pgUser: string;
}

export interface CleanupTarget {
  flow: FlowName;
  pipelineRunId?: string;
  slug?: string;
  s3Keys: string[];
  chatSessionId?: string;
}

export class SmokeSetupError extends Error {
  constructor(message: string) { super(message); this.name = 'SmokeSetupError'; }
}
export class SmokeInfraError extends Error {
  constructor(message: string) { super(message); this.name = 'SmokeInfraError'; }
}
export class SmokeAssertionError extends Error {
  constructor(message: string) { super(message); this.name = 'SmokeAssertionError'; }
}
