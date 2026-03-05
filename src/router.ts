import type { Message } from "./memory/memory_messages.js";

type ClaudeModel = "claude-haiku-4-5-20251001" | "claude-sonnet-4-6" | "claude-sonnet-4-5-20250929";

interface RouterDecision {
    model: ClaudeModel;
    reason: string;
    estimatedPromptTokens: number;
}

const HAIKU_MODEL: ClaudeModel = "claude-haiku-4-5-20251001";
const SONNET_MODEL: ClaudeModel = "claude-sonnet-4-6"; // Latest available Sonnet 4.6

// Rough token estimation: 1 token ~= 4 chars (good enough for English/Italian mixed text without tiktoken)
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/**
 * Dynamically selects the best Claude model based on the request context length and content.
 */
export function selectModel(
    userMessage: string,
    history: Message[],
    systemPromptLength: number
): RouterDecision {
    const historyText = history.map((m) => m.content).join("\n");
    const historyTokens = estimateTokens(historyText);
    const userTokens = estimateTokens(userMessage);
    const systemTokens = estimateTokens("a".repeat(systemPromptLength)); // mock string just to get length est
    const estimatedPromptTokens = systemTokens + historyTokens + userTokens;

    // 1. Long context -> Sonnet handles large contexts better and summarizes better
    if (estimatedPromptTokens > 40000) {
        return {
            model: SONNET_MODEL,
            reason: "High context length (> 40k tokens)",
            estimatedPromptTokens
        };
    }

    // 2. Complex tasks (Code, Debugging, Auditing) -> Sonnet
    // Using a regex to detect code/tech-heavy requests
    const techReqPattern = /(codice|errore|debug|audit|analiz|typescript|javascript|react|vue|funzione|architettura)/i;
    // Also check if there are raw code blocks in the message
    const hasCodeBlocks = /```[\s\S]*?```/.test(userMessage);

    if (techReqPattern.test(userMessage) || hasCodeBlocks) {
        return {
            model: SONNET_MODEL,
            reason: "Technical/Code task detected",
            estimatedPromptTokens
        };
    }

    // Default -> Haiku 3.5 (fast & cheap)
    return {
        model: HAIKU_MODEL,
        reason: "Standard conversation query",
        estimatedPromptTokens
    };
}
