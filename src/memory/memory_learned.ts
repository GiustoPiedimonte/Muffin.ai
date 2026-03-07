import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getEmbedding, cosineSimilarity } from "./memory_embeddings.js";
import { invalidateContextCache } from "./memory_cache.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LearnedFact {
    id?: string;
    learnedFact: string;
    sourceMessage: string;
    confidence: "high" | "medium" | "low";
    needsConfirmation: boolean;
    confirmedAt: Date | null;
    timestamp: Date;
    chatId: string;
    embedding?: number[];
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
    facts: LearnedFact[];
    loadedAt: number;
}

const cache = new Map<string, CacheEntry>();

function isCacheValid(chatId: string): boolean {
    const entry = cache.get(chatId);
    if (!entry) return false;
    return Date.now() - entry.loadedAt < CACHE_TTL_MS;
}

function invalidateCache(chatId: string): void {
    cache.delete(chatId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: Firestore;
function getDb(): Firestore {
    if (!db) db = getFirestore();
    return db;
}

/**
 * Simple keyword similarity: measures overlap between query and text.
 * Returns value between 0 and 1.
 */
function keywordSimilarity(query: string, text: string): number {
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const textWords = text.toLowerCase().split(/\s+/);

    if (queryWords.length === 0) return 0;

    const matches = queryWords.filter(qw =>
        textWords.some(tw => tw.includes(qw) || qw.includes(tw))
    );

    return matches.length / queryWords.length;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Saves a learned fact to Firestore.
 * Invalidates context cache so next message reloads memory.
 */
export async function saveLearned(
    chatId: string,
    fact: {
        learnedFact: string;
        sourceMessage: string;
        confidence: "high" | "medium" | "low";
        needsConfirmation: boolean;
    }
): Promise<string> {
    let embedding: number[] | undefined;
    try {
        embedding = await getEmbedding(fact.learnedFact);
    } catch (err) {
        console.error("Failed to compute embedding for learned fact:", err);
    }

    const docRef = await getDb().collection("memory_learned").add({
        ...fact,
        embedding: embedding ?? null,
        confirmedAt: null,
        timestamp: new Date(),
        chatId,
    });

    invalidateCache(chatId);
    invalidateContextCache(chatId);
    return docRef.id;
}

/**
 * Confirms a pending learned fact.
 * Invalidates context cache.
 */
export async function confirmLearned(factId: string): Promise<void> {
    const docRef = getDb().collection("memory_learned").doc(factId);
    const doc = await docRef.get();
    const chatId = doc.data()?.chatId;

    await docRef.update({
        confirmedAt: new Date(),
        needsConfirmation: false,
    });

    if (chatId) {
        invalidateCache(chatId);
        invalidateContextCache(chatId);
    }
}

/**
 * Rejects a pending learned fact — deletes it.
 * Invalidates context cache.
 */
export async function rejectLearned(factId: string): Promise<void> {
    const docRef = getDb().collection("memory_learned").doc(factId);
    const doc = await docRef.get();
    const chatId = doc.data()?.chatId;

    await docRef.delete();

    if (chatId) {
        invalidateCache(chatId);
        invalidateContextCache(chatId);
    }
}

/**
 * Gets all learned facts for a chat.
 */
export async function getLearnedFacts(chatId: string): Promise<LearnedFact[]> {
    if (isCacheValid(chatId)) {
        return cache.get(chatId)!.facts;
    }

    const snap = await getDb()
        .collection("memory_learned")
        .where("chatId", "==", chatId)
        .get();

    const facts = snap.docs.map(docToLearned);
    facts.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    cache.set(chatId, { facts, loadedAt: Date.now() });
    return facts;
}

/**
 * Gets the most recent pending confirmation (if any).
 */
export async function getPendingConfirmation(
    chatId: string
): Promise<LearnedFact | null> {
    const facts = await getLearnedFacts(chatId);
    const pending = facts.filter((f) => f.needsConfirmation);

    if (pending.length === 0) return null;

    return pending[0];
}

/**
 * Searches learned facts with hybrid approach:
 * 1. Try semantic search with embeddings
 * 2. Fallback to keyword matching if embedding missing
 * 3. Save computed embeddings to Firestore for future use
 */
export async function searchLearned(
    chatId: string,
    query: string,
    threshold = 0.5
): Promise<LearnedFact[]> {
    const all = await getLearnedFacts(chatId);
    if (all.length === 0) return [];

    let queryVec: number[] | null = null;
    try {
        queryVec = await getEmbedding(query, "query");
    } catch (err) {
        console.error("searchLearned: Failed to compute query embedding:", err);
        // Continue with keyword matching fallback
    }

    const scored = await Promise.all(
        all.map(async (f) => {
            let embedding = f.embedding;

            // If embedding is missing, try to compute it
            if (!embedding && queryVec) {
                try {
                    embedding = await getEmbedding(f.learnedFact);
                    // Save the computed embedding to Firestore for future use
                    if (f.id) {
                        await getDb()
                            .collection("memory_learned")
                            .doc(f.id)
                            .update({ embedding })
                            .catch((err) =>
                                console.warn(
                                    `Failed to save computed embedding for fact ${f.id}:`,
                                    err
                                )
                            );
                    }
                } catch (err) {
                    console.warn(
                        `Failed to compute embedding for fact "${f.learnedFact.substring(0, 30)}...":`,
                        err
                    );
                    // Fall through to keyword matching
                }
            }

            // Compute score based on what we have
            let score = 0;
            if (embedding && queryVec) {
                score = cosineSimilarity(queryVec, embedding);
            } else {
                // Fallback to keyword similarity
                score = keywordSimilarity(query, f.learnedFact);
            }

            return { fact: f, score };
        })
    );

    return scored
        .filter((item) => item.score > threshold)
        .sort((a, b) => b.score - a.score)
        .map((item) => item.fact);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function docToLearned(doc: FirebaseFirestore.QueryDocumentSnapshot): LearnedFact {
    const d = doc.data();
    return {
        id: doc.id,
        learnedFact: d.learnedFact,
        sourceMessage: d.sourceMessage,
        confidence: d.confidence,
        needsConfirmation: d.needsConfirmation ?? false,
        confirmedAt: d.confirmedAt?.toDate?.() ?? null,
        timestamp: d.timestamp?.toDate?.() ?? new Date(),
        chatId: d.chatId,
        embedding: d.embedding ?? undefined,
    };
}
