/**
 * @format
 * Project Configuration
 *
 * Defines available projects and their metadata.
 * Scoped to Bedrock AI applications and self-healing agent only.
 */

/**
 * Available projects in this repository.
 */
export enum Project {
    /** Amazon Bedrock AI applications (article pipeline, job strategist, chatbot) */
    BEDROCK = 'bedrock',
    /** Agentic self-healing pipeline using AgentCore Gateway */
    SELF_HEALING = 'self-healing',
}

/**
 * Project metadata configuration
 */
export interface ProjectConfig {
    /** Display name for the project */
    readonly displayName: string;
    /** Short description */
    readonly description: string;
    /** Stack namespace prefix */
    readonly namespace: string;
    /** Whether this project requires the shared VPC */
    readonly requiresSharedVpc: boolean;
}

/**
 * Project configurations mapped by project enum
 */
export const PROJECT_CONFIGS: Record<Project, ProjectConfig> = {
    [Project.BEDROCK]: {
        displayName: 'Bedrock',
        description: 'Amazon Bedrock AI applications with Knowledge Bases and API Gateway',
        namespace: 'Bedrock',
        requiresSharedVpc: false,
    },
    [Project.SELF_HEALING]: {
        displayName: 'Self-Healing',
        description: 'Agentic self-healing pipeline using AgentCore Gateway',
        namespace: 'SelfHealing',
        requiresSharedVpc: false,
    },
} as const;

export function getProjectConfig(project: Project): ProjectConfig {
    return PROJECT_CONFIGS[project];
}

export function isValidProject(value: string): value is Project {
    return Object.values(Project).includes(value as Project);
}

export function getAvailableProjects(): Project[] {
    return Object.values(Project);
}
