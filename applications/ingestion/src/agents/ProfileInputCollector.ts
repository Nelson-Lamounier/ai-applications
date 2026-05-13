export interface ProfileInputBundle {
    repo_full_name:          string;
    primary_language:        string | null;
    description:             string | null;
    topics:                  string[];
    stars:                   number;
    forks:                   number;
    is_fork:                 boolean;
    created_at:              string | null;
    pushed_at:               string | null;
    commit_count:            number;
    readme:                  string | null;
    manifests:               Record<string, string>;
    changelog:               string | null;
    workflows:               Record<string, string>;
    recent_commit_messages:  string[];
}

// Full implementation added in Task 7.
export class ProfileInputCollector {
    collect(_repoFullName: string): Promise<ProfileInputBundle> {
        throw new Error('ProfileInputCollector: not yet implemented');
    }
}
