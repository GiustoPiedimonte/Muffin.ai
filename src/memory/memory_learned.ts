import { getFirestore, type Firestore } from "firebase-admin/firestore";

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
 * Keyword extraction for similarity search.
 */
function extractKeywords(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .replace(/[^\w\sàèéìòù]/g, "")
            .split(/\s+/)
            .filter((w) => w.length > 3)
    );
}

/**
 * Keyword overlap similarity (0-1).
 */
export function computeSimilarity(text1: string, text2: string): number {
    const kw1 = extractKeywords(text1);
    const kw2 = extractKeywords(text2);

    if (kw1.size === 0 || kw2.size === 0) return 0;

    let matches = 0;
    for (const kw of kw1) {
        if (kw2.has(kw)) matches++;
    }

    return matches / Math.max(kw1.size, kw2.size);
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Saves a learned fact to Firestore.
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
    const docRef = await getDb().collection("memory_learned").add({
        ...fact,
        confirmedAt: null,
        timestamp: new Date(),
        chatId,
    });

    return docRef.id;
}

/**
 * Confirms a pending learned fact.
 */
export async function confirmLearned(factId: string): Promise<void> {
    await getDb().collection("memory_learned").doc(factId).update({
        confirmedAt: new Date(),
        needsConfirmation: false,
    });
}

/**
 * Rejects a pending learned fact — deletes it.
 */
export async function rejectLearned(factId: string): Promise<void> {
    await getDb().collection("memory_learned").doc(factId).delete();
}

/**
 * Gets all learned facts for a chat.
 */
export async function getLearnedFacts(chatId: string): Promise<LearnedFact[]> {
    const snap = await getDb()
        .collection("memory_learned")
        .where("chatId", "==", chatId)
        .orderBy("timestamp", "desc")
        .get();

    return snap.docs.map(docToLearned);
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
        .orderBy("timestamp", "desc")
        .limit(1)
        .get();

    if (snap.empty) return null;
    return docToLearned(snap.docs[0]);
}

/**
 * Searches learned facts by keyword similarity.
 * Returns facts with similarity score > threshold.
 */
export async function searchLearned(
    chatId: string,
    query: string,
    threshold = 0.3
): Promise<LearnedFact[]> {
    const all = await getLearnedFacts(chatId);

    return all
        .map((f) => ({
            fact: f,
            score: computeSimilarity(query, f.learnedFact),
        }))
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
    };
}
