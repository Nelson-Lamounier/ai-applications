export type CallerRole = 'recruiter' | 'engineer' | 'unknown';

export interface InvokeRequestBody {
    readonly prompt:      string;
    readonly sessionId?:  string;
    readonly callerRole?: CallerRole;
}

export interface InvokeResponseBody {
    readonly response:  string;
    readonly sessionId: string;
}

export interface ErrorResponseBody {
    readonly error:   string;
    readonly message: string;
}
