const STOP_WORDS = [
    "what's", 'what is', 'what are', 'what does', 'tell me about',
    'describe', 'explain', 'who', 'where', 'when', 'why', 'how',
    'does', 'is', 'can', 'has', 'have', 'was', 'were', 'did', 'do',
    "nelson's", 'nelson', 'about', 'the', 'his', 'he', 'your', 'you', 'a', 'an',
];

export function expandQuery(userQuestion: string): [string, string] {
    const noQ    = userQuestion.replace(/\?$/, '').trim();
    const lower  = noQ.toLowerCase();
    let stripped = noQ;
    for (const word of STOP_WORDS) {
        if (lower.startsWith(word + ' ')) {
            stripped = noQ.slice(word.length).trim();
            break;
        }
    }
    const topic = (stripped.length > 0 ? stripped : userQuestion).trim();
    const join  = (suffix: string): string => topic ? `${topic} ${suffix}` : suffix;

    return [
        join('deployment reliability outcomes production results'),
        join('infrastructure architecture design patterns tools'),
    ];
}
