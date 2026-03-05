import { buildSemanticContext } from "./memory_semantic.js";
import { searchLearned, type LearnedFact } from "./memory_learned.js";
import { getRecentEpisodes, getLastEpisodeTimestamp } from "./memory_episodic.js";
import { getMemorySummary } from "./memory_compression.js";

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
 * 3. Recent episodes (always, but quantity varies by time gap)
 */
export async function getRelevantContext(
    chatId: string,
    userMessage: string
): Promise<string> {
    const parts: string[] = [];

    // 1. Semantic facts — always loaded
    const semanticCtx = await buildSemanticContext(chatId);
    if (semanticCtx) parts.push(semanticCtx);

    // 2. Compressed historical memory summary if exists
    const summaryCtx = await getMemorySummary(chatId);
    if (summaryCtx) parts.push(`\n\n## Riassunto Storico\n${summaryCtx}`);

    // 3. Learned facts — filtered by relevance to current message
    const learnedCtx = await buildLearnedContext(chatId, userMessage);
    if (learnedCtx) parts.push(learnedCtx);

    // 4. Recent episodes — always included, but quantity varies by time gap
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
    // Determine time gap — vary episode count based on recency
    const lastTimestamp = await getLastEpisodeTimestamp(chatId);
    const gap = lastTimestamp ? Date.now() - lastTimestamp.getTime() : null;
    const isRecent = gap !== null && gap < GAP_THRESHOLD_MS;

    // Always include episodes, but vary quantity based on time gap
    const episodeCount = isRecent ? 3 : MAX_EPISODES_IN_CONTEXT;
    const episodes = await getRecentEpisodes(chatId, episodeCount);
    if (episodes.length === 0) return "";

    const lines = episodes
        .map((e) => {
            const who = e.direction === "user" ? "Giusto" : "Muffin";
            return `- ${who}: ${e.contentParaphrased}`;
        })
        .join("\n");

    const header = isRecent
        ? "## Ultimi messaggi\n"
        : "## Riassunto conversazione recente\n";
    return `\n\n${header}${lines}`;
}
