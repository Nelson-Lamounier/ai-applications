export interface PublicChatbotEnv {
    readonly portfolioOwnerUserId: string;
    readonly chatbotModel:         string;
    readonly allowedOrigins:       string;
}

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

let cached: PublicChatbotEnv | undefined;

export function getEnv(): PublicChatbotEnv {
    if (cached) return cached;
    cached = {
        portfolioOwnerUserId: required('PORTFOLIO_OWNER_USER_ID'),
        chatbotModel:         required('CHATBOT_MODEL'),
        allowedOrigins:       process.env['ALLOWED_ORIGINS'] ?? '*',
    };
    return cached;
}

export function resetEnvCache(): void { cached = undefined; }
