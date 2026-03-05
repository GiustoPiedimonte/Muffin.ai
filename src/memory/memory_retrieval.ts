import { buildSemanticContext } from "./memory_semantic.js";
import { searchLearned, type LearnedFact } from "./memory_learned.js";
import { getRecentEpisodes, getLastEpisodeTimestamp } from "./memory_episodic.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GAP_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_LEARNED_IN_CONTEXT = 10;
const MAX_EPISODES_IN_CONTEXT = 6;

// ---------------------------------------------------------------------------
// Main retrieval function
// ---------------------------------------------------------------------------

/**
 * Builds the full relevant context string for Claude's system prompt.
 *
 * Always includes:
 * 1. Semantic facts (identity, preferences, etc.)
 *
 * Conditionally includes:
 * 2. Learned facts matching the current message (similarity search)
 * 3. Recent episodes (only if significant time gap or topic change)
 */
export async function getRelevantContext(
    chatId: string,
    userMessage: string
): Promise<string> {
    const parts: string[] = [];

    // 1. Semantic facts — always loaded
    const semanticCtx = await buildSemanticContext(chatId);
    if (semanticCtx) parts.push(semanticCtx);

    // 2. Learned facts — filtered by relevance to current message
    const learnedCtx = await buildLearnedContext(chatId, userMessage);
    if (learnedCtx) parts.push(learnedCtx);

    // 3. Recent episodes — only if there's a significant time gap
    const episodicCtx = await buildEpisodicContext(chatId);
    if (episodicCtx) parts.push(episodicCtx);

    return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

async function buildLearnedContext(
    chatId: string,
    userMessage: string
): Promise<string> {
    const relevant = await searchLearned(chatId, userMessage, 0.25);
    if (relevant.length === 0) return "";

    const top = relevant.slice(0, MAX_LEARNED_IN_CONTEXT);
    const lines = top
        .map((f: LearnedFact) => `- ${f.learnedFact}`)
        .join("\n");

    return `\n\n## Cose che ho imparato di recente\n${lines}`;
}

async function buildEpisodicContext(chatId: string): Promise<string> {
    // Check time gap — only include episodes if last message was > 6h ago
    const lastTimestamp = await getLastEpisodeTimestamp(chatId);

    if (lastTimestamp) {
        const gap = Date.now() - lastTimestamp.getTime();
        if (gap < GAP_THRESHOLD_MS) {
            // Recent conversation — Claude already has the messages in history
            return "";
        }
    }

    // Significant gap — include recent paraphrased episodes as recap
    const episodes = await getRecentEpisodes(chatId, MAX_EPISODES_IN_CONTEXT);
    if (episodes.length === 0) return "";

    const lines = episodes
        .map((e) => {
            const who = e.direction === "user" ? "Giusto" : "Muffin";
            return `- ${who}: ${e.contentParaphrased}`;
        })
        .join("\n");

    return `\n\n## Riassunto conversazione recente\n${lines}`;
}
