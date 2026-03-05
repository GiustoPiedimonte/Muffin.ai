// ---------------------------------------------------------------------------
// Context Cache Layer
// ---------------------------------------------------------------------------
// Purpose: Cache the full output of getRelevantContext() to avoid repeated
// Firebase queries and embedding computations within the same chat session.
//
// How it works:
// 1. On first message, context is fetched via getRelevantContext()
// 2. Result is cached per chatId with TTL of 10 minutes
// 3. Subsequent messages reuse cache if not expired
// 4. Cache is automatically invalidated when new facts are saved
// 5. Manual invalidation available for testing/debugging

interface CacheEntry {
    context: string;
    timestamp: number;
}

const contextCache = new Map<string, CacheEntry>();
const CONTEXT_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Gets relevant context for a chat, using cache if valid.
 * If cache miss or expired, calls getRelevantContext() and caches result.
 *
 * @param chatId - The chat identifier
 * @param userMessage - Current user message (for context building, but cache is per-chat)
 * @param getRelevantContextFn - Function to call on cache miss
 * @returns The formatted context string to inject into Claude's system prompt
 */
export async function getCachedRelevantContext(
    chatId: string,
    userMessage: string,
    getRelevantContextFn: (chatId: string, userMessage: string) => Promise<string>
): Promise<string> {
    const cached = contextCache.get(chatId);

    // Hit: return cached
    if (cached && Date.now() - cached.timestamp < CONTEXT_TTL_MS) {
        return cached.context;
    }

    // Miss: fetch and cache
    const context = await getRelevantContextFn(chatId, userMessage);
    contextCache.set(chatId, { context, timestamp: Date.now() });

    return context;
}

/**
 * Invalidates context cache for a specific chat.
 * Called automatically when new facts are saved.
 */
export function invalidateContextCache(chatId: string): void {
    contextCache.delete(chatId);
}

/**
 * Clears all context cache entries.
 * Useful for testing or on startup.
 */
export function clearAllContextCache(): void {
    contextCache.clear();
}

/**
 * Returns cache statistics for debugging.
 */
export function getContextCacheStats(): {
    entriesCount: number;
    entries: Array<{ chatId: string; ageMs: number; isValid: boolean }>;
} {
    const now = Date.now();
    const entries = Array.from(contextCache.entries()).map(([chatId, entry]) => {
        const ageMs = now - entry.timestamp;
        const isValid = ageMs < CONTEXT_TTL_MS;
        return { chatId, ageMs, isValid };
    });

    return {
        entriesCount: entries.length,
        entries,
    };
}
