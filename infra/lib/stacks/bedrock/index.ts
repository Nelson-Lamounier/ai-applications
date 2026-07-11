/**
 * @format
 * Bedrock Stacks - Central Export
 *
 * Provides modular stacks for the Bedrock Agent infrastructure.
 *
 * **2-Stack Architecture** (post Pinecone/Agent decommission):
 * - DataStack: S3 bucket + inference profiles
 * - ApiStack: API Gateway + RAG chatbot Lambdas (RDS pgvector, chatbot BFF)
 *
 * Article pipeline, job strategist pipeline, ingestion pipeline, RDS,
 * DynamoDB data layers, and the public API have been migrated to
 * Kubernetes (kubernetes-platform / kubernetes-bootstrap repos).
 */

export * from './data-stack';
export * from './api-stack';
