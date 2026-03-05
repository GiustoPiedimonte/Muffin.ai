import { getFirestore, type Firestore } from "firebase-admin/firestore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FactCategory =
    | "identity"
    | "projects"
    | "tech_stack"
    | "interests"
    | "priorities"
    | "preferences";

export type FactImportance = "high" | "medium" | "low";

export interface SemanticFact {
    id?: string;
    key: string;
    value: string;
    category: FactCategory;
    lastUpdated: Date;
    importance: FactImportance;
    source: "explicit" | "inferred" | "learned";
    chatId: string;
}

// ---------------------------------------------------------------------------
// Explicit memory trigger patterns
// ---------------------------------------------------------------------------

const EXPLICIT_PATTERNS = [
    /^ricordati\s+che\s+/i,
    /^salva\s+che\s+/i,
    /^tieni\s+a\s+mente\s+che\s+/i,
    /^memorizza\s+che\s+/i,
];

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
    facts: SemanticFact[];
    loadedAt: number;
}

const cache = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: Firestore;

function getDb(): Firestore {
    if (!db) db = getFirestore();
    return db;
}

function isCacheValid(chatId: string): boolean {
    const entry = cache.get(chatId);
    if (!entry) return false;
    return Date.now() - entry.loadedAt < CACHE_TTL_MS;
}

function invalidateCache(chatId: string): void {
    cache.delete(chatId);
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Loads all semantic facts for a chat, using a 5-minute in-memory cache.
 */
export async function loadFacts(chatId: string): Promise<SemanticFact[]> {
    if (isCacheValid(chatId)) {
        return cache.get(chatId)!.facts;
    }

    const snap = await getDb()
        .collection("memory_facts")
        .where("chatId", "==", chatId)
        .orderBy("lastUpdated", "desc")
        .get();

    const facts: SemanticFact[] = snap.docs.map((doc) => {
        const d = doc.data();
        return {
            id: doc.id,
            key: d.key || d.fact || "",
            value: d.value || d.fact || "",
            category: d.category || "preferences",
            lastUpdated: d.lastUpdated?.toDate?.() ?? d.timestamp?.toDate?.() ?? new Date(),
            importance: d.importance || "medium",
            source: d.source || "inferred",
            chatId: d.chatId,
        };
    });

    cache.set(chatId, { facts, loadedAt: Date.now() });
    return facts;
}

/**
 * Saves a new semantic fact. Invalidates cache.
 */
export async function saveFact(
    chatId: string,
    fact: Omit<SemanticFact, "id" | "chatId" | "lastUpdated">
): Promise<string> {
    const docRef = await getDb().collection("memory_facts").add({
        ...fact,
        chatId,
        lastUpdated: new Date(),
    });

    invalidateCache(chatId);
    return docRef.id;
}

/**
 * Returns facts filtered by category.
 */
export async function getFactsByCategory(
    chatId: string,
    category: FactCategory
): Promise<SemanticFact[]> {
    const all = await loadFacts(chatId);
    return all.filter((f) => f.category === category);
}

// ---------------------------------------------------------------------------
// Explicit memory (migrated from memory_facts.ts)
// ---------------------------------------------------------------------------

/**
 * Checks if the user message matches an explicit memory trigger.
 * Returns the extracted fact text, or null.
 */
export function checkExplicitMemory(text: string): string | null {
    for (const pattern of EXPLICIT_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
            const fact = text.slice(match[0].length).trim();
            return fact.length > 0 ? fact : null;
        }
    }
    return null;
}

/**
 * Saves a fact triggered by an explicit user command.
 */
export async function saveExplicitFact(
    chatId: string,
    factText: string
): Promise<void> {
    await saveFact(chatId, {
        key: factText,
        value: factText,
        category: "preferences",
        importance: "high",
        source: "explicit",
    });
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

/**
 * Builds a formatted context string from all semantic facts.
 * This is injected into Claude's system prompt.
 */
export async function buildSemanticContext(chatId: string): Promise<string> {
    const facts = await loadFacts(chatId);
    if (facts.length === 0) return "";

    // Group by category for readability
    const grouped = new Map<string, string[]>();

    for (const f of facts) {
        const cat = f.category;
        if (!grouped.has(cat)) grouped.set(cat, []);
        grouped.get(cat)!.push(f.value);
    }

    const CATEGORY_LABELS: Record<string, string> = {
        identity: "Identità",
        projects: "Progetti",
        tech_stack: "Stack tecnico",
        interests: "Interessi",
        priorities: "Priorità",
        preferences: "Preferenze",
    };

    const sections: string[] = [];
    for (const [cat, items] of grouped) {
        const label = CATEGORY_LABELS[cat] || cat;
        const lines = items.map((i) => `- ${i}`).join("\n");
        sections.push(`### ${label}\n${lines}`);
    }

    return `\n\n## Cose che so su di te\n${sections.join("\n\n")}`;
}
