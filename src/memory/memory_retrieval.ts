import { buildSemanticContext } from "./memory_semantic.js";
import { searchLearned, type LearnedFact } from "./memory_learned.js";
import { getMemorySummary } from "./memory_compression.js";
import { buildNarrativeContext } from "./memory_narratives.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GAP_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_LEARNED_IN_CONTEXT = 5;

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
 */
export async function getRelevantContext(
    chatId: string,
    userMessage: string
): Promise<{ staticCtx: string; dynamicCtx: string }> {
    // Fetch all parts in parallel to reduce absolute wait time
    const [semanticCtx, summaryCtx, learnedCtx, narrativeCtx] = await Promise.all([
        buildSemanticContext(chatId),
        getMemorySummary(chatId),
        buildLearnedContext(chatId, userMessage),
        buildNarrativeContext(chatId, userMessage)
    ]);

    const staticParts: string[] = [];

    // 1. Semantic facts — always loaded
    if (semanticCtx) staticParts.push(semanticCtx);

    // 2. Compressed historical memory summary if exists
    if (summaryCtx) staticParts.push(`\n\n## Riassunto Storico\n${summaryCtx}`);

    // Dynamic context that goes near the user message (or system block)
    const dynamicParts: string[] = [];
    if (learnedCtx) dynamicParts.push(learnedCtx);
    if (narrativeCtx) dynamicParts.push(narrativeCtx);
    const dynamicCtx = dynamicParts.join("\n");

    return { staticCtx: staticParts.join("\n"), dynamicCtx };
}

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

async function buildLearnedContext(
    chatId: string,
    userMessage: string
): Promise<string> {
    const relevant = await searchLearned(chatId, userMessage, 0.40);
    if (relevant.length === 0) return "";

    const top = relevant.slice(0, MAX_LEARNED_IN_CONTEXT);
    const lines = top
        .map((f: LearnedFact) => `- ${f.learnedFact}`)
        .join("\n");

    return `\n\n## Cose che ho imparato di recente\n${lines}`;
}
