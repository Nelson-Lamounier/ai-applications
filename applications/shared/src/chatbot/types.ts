export interface Metric {
    readonly label: string;
    readonly value: string;
}

export interface ChatbotResponse {
    readonly prose:    string;
    readonly metrics:  Metric[];
    readonly tags:     string[];
    readonly followUp: string;
}
