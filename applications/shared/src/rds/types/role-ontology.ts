/** @format */
export type RoleClass = 'customer_facing' | 'builder' | 'ops' | 'hybrid';

export interface RoleFamily {
    familyKey:                 string;
    displayName:               string;
    roleClass:                 RoleClass;
    canonicalResponsibilities: string[];
    vocabulary:                string[];
    transferableSkills:        string[];
    industryNotes:             string;
}

export type RoleCandidateType = 'alias' | 'vocabulary' | 'transferable_skill' | 'family';

export type CompanyType = 'saas' | 'infra_provider' | 'fintech' | 'hardware' | 'agency' | 'enterprise' | 'marketplace' | 'other';

export interface NewFamily {
    familyKey:                 string;
    displayName:               string;
    roleClass:                 RoleClass;
    canonicalResponsibilities: string[];
    vocabulary:                string[];
    transferableSkills:        string[];
}

export interface RoleLearningCandidate {
    familyKey:          string;
    candidateType:      RoleCandidateType;
    value:              string;
    contributingUserId: string;
}
