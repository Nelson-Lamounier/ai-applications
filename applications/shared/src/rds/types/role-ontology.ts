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

export type RoleCandidateType = 'alias' | 'vocabulary' | 'transferable_skill';

export interface RoleLearningCandidate {
    familyKey:          string;
    candidateType:      RoleCandidateType;
    value:              string;
    contributingUserId: string;
}
