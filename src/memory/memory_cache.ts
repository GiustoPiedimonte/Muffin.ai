/**
 * memory_cache.ts
 * 
 * Local in-memory cache for getRelevantContext() output.
 * Reduces Firebase queries and embedding computations by caching the entire
 * context string for each chat, with smart invalidation on new fact saves.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CacheEntry {
    context: string;
    timestamp: number;
}

// ---------------------------------------------------------------------------
// Cache storage
// ---------------------------------------------------------------------------

const contextCache = new Map<string, CacheEntry>();
const CONTEXT_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Gets the cached context for a chat, or returns null if expired.
 * Does NOT fetch fresh data — just returns what's cached.
 */
export function getCachedContext(chatId: string): string | null {
    const cached = contextCache.get(chatId);

    if (!cached) {
        return null;
    }

    if (Date.now() - cached.timestamp >= CONTEXT_TTL_MS) {
        contextCache.delete(chatId);
        return null;
    }

    return cached.context;
}

/**
 * Sets the context cache for a chat.
 * Called after successfully fetching fresh context from memory modules.
 */
export function setCachedContext(chatId: string, context: string): void {
    contextCache.set(chatId, {
        context,
        timestamp: Date.now(),
    });
}

/**
 * Invalidates the context cache for a specific chat.
 * Called whenever a new fact is saved to any memory module.
 */
export function invalidateContextCache(chatId: string): void {
    contextCache.delete(chatId);
}

/**
 * Clears the entire cache (mainly for testing/cleanup).
 */
export function clearContextCache(): void {
    contextCache.clear();
}

/**
 * Wrapper that checks cache first, then calls the memory-retrieval module
 * if no cached result is found.
 */
export async function getCachedRelevantContext(
    chatId: string,
    userMessage: string,
    fetcher: (chatId: string, message: string) => Promise<string>
): Promise<string> {
    const cached = getCachedContext(chatId);
    if (cached !== null) {
        return cached;
    }

    // Fetch fresh
    const freshContext = await fetcher(chatId, userMessage);
    setCachedContext(chatId, freshContext);
    return freshContext;
}

/**
 * Returns cache stats for debugging.
 */
export function getCacheStats(): { size: number; entries: string[] } {
    return {
        size: contextCache.size,
        entries: Array.from(contextCache.keys()),
    };
}
