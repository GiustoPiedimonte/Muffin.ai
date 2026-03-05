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
// Helpers
// ---------------------------------------------------------------------------

let db: Firestore;
function getDb(): Firestore {
    if (!db) db = getFirestore();
    return db;
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
        invalidateContextCache(chatId);
    }
}

/**
 * Gets all learned facts for a chat.
 */
export async function getLearnedFacts(chatId: string): Promise<LearnedFact[]> {
    const snap = await getDb()
        .collection("memory_learned")
        .where("chatId", "==", chatId)
        .get();

    const facts = snap.docs.map(docToLearned);
    facts.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return facts;
}

/**
 * Gets the most recent pending confirmation (if any).
 */
export async function getPendingConfirmation(
    chatId: string
): Promise<LearnedFact | null> {
    const snap = await getDb()
        .collection("memory_learned")
        .where("chatId", "==", chatId)
        .where("needsConfirmation", "==", true)
        .get();

    if (snap.empty) return null;

    const facts = snap.docs.map(docToLearned);
    facts.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    return facts[0];
}

/**
 * Searches learned facts by keyword similarity.
 * Returns facts with similarity score > threshold.
 */
export async function searchLearned(
    chatId: string,
    query: string,
    threshold = 0.5
): Promise<LearnedFact[]> {
    const all = await getLearnedFacts(chatId);
    if (all.length === 0) return [];

    try {
        const queryVec = await getEmbedding(query);
        const scored = all.map((f) => {
            // Use stored embedding if available, skip if not
            if (!f.embedding) return { fact: f, score: 0 };
            return {
                fact: f,
                score: cosineSimilarity(queryVec, f.embedding),
            };
        });

        return scored
            .filter((item) => item.score > threshold)
            .sort((a, b) => b.score - a.score)
            .map((item) => item.fact);
    } catch (err) {
        console.error("searchLearned embedding failed:", err);
        return [];
    }
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
