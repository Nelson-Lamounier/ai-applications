/**
 * @format
 * Project Registry
 *
 * Maps project + environment combinations to their respective factories.
 * Scoped to Bedrock AI applications and self-healing agent.
 */

import { Environment, isValidEnvironment, resolveEnvironment } from '../config/environments';
import { Project, isValidProject, getAvailableProjects } from '../config/projects';
import { BedrockProjectFactory } from '../projects/bedrock';
import { SelfHealingProjectFactory } from '../projects/self-healing';

import { IProjectFactory, ProjectFactoryConstructor } from './project-interfaces';

const projectFactoryRegistry: Record<Project, ProjectFactoryConstructor> = {
    [Project.BEDROCK]: BedrockProjectFactory,
    [Project.SELF_HEALING]: SelfHealingProjectFactory,
};

export function getProjectFactory(project: Project, environment: Environment): IProjectFactory {
    const FactoryClass = projectFactoryRegistry[project];
    if (!FactoryClass) {
        const available = getAvailableProjects().join(', ');
        throw new Error(`Unknown project: ${project}. Available: ${available}`);
    }
    return new FactoryClass(environment);
}

export function getProjectFactoryFromContext(
    projectStr: string,
    environmentStr: string,
): IProjectFactory {
    if (!isValidProject(projectStr)) {
        const available = getAvailableProjects().join(', ');
        throw new Error(`Invalid project: '${projectStr}'. Valid projects: ${available}`);
    }
    if (!isValidEnvironment(environmentStr)) {
        const available = Object.values(Environment).join(', ');
        throw new Error(`Invalid environment: '${environmentStr}'. Valid environments: ${available}`);
    }
    const resolvedEnv = resolveEnvironment(environmentStr);
    return getProjectFactory(projectStr as Project, resolvedEnv);
}

export function hasProjectFactory(project: Project): boolean {
    return project in projectFactoryRegistry;
}
