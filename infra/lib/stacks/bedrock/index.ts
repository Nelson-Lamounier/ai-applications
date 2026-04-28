/**
 * @format
 * Bedrock Stacks - Central Export
 *
 * Provides modular stacks for the Bedrock Agent infrastructure.
 *
 * **4-Stack Architecture** (post-Phase-5 cleanup):
 * - DataStack: S3 bucket for Knowledge Base documents
 * - KbStack: Bedrock Knowledge Base backed by Pinecone
 * - AgentStack: Bedrock Agent, Guardrail, Action Group
 * - ApiStack: API Gateway + Lambda for agent invocation (chatbot BFF)
 *
 * Article pipeline, job strategist pipeline, ingestion pipeline, RDS,
 * DynamoDB data layers, and the public API have been migrated to
 * Kubernetes (kubernetes-platform / kubernetes-bootstrap repos).
 */

export * from './data-stack';
export * from './kb-stack';
export * from './agent-stack';
export * from './api-stack';
