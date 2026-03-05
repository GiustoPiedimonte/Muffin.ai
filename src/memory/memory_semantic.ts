import { getFirestore, type Firestore } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "./memory_messages.js";
import { getEmbedding, cosineSimilarity } from "./memory_embeddings.js";

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
    embedding?: number[];
}

export interface BatchResult {
    newFacts: string[];
    duplicatesIgnored: number;
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

/**
 * Returns true if newFact is semantically very similar to existingFact (cosine > 0.85).
 */
async function isDuplicate(
    newFact: string,
    existingFact: string,
    existingEmbedding?: number[]
): Promise<boolean> {
    try {
        const vecNew = await getEmbedding(newFact);
        const vecExisting = existingEmbedding ?? await getEmbedding(existingFact);
        const sim = cosineSimilarity(vecNew, vecExisting);
        return sim > 0.85;
    } catch (err) {
        console.error("Embedding failed, falling back to strict equality", err);
        return newFact.trim().toLowerCase() === existingFact.trim().toLowerCase();
    }
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
        .get();

    let facts: SemanticFact[] = snap.docs.map((doc: FirebaseFirestore.QueryDocumentSnapshot) => {
        const d = doc.data();
        return {
            id: doc.id,
            key: d.key || d.fact || "", // support old format 'fact'
            value: d.value || d.fact || "",
            category: d.category || "preferences",
            lastUpdated: d.lastUpdated?.toDate?.() ?? d.timestamp?.toDate?.() ?? new Date(),
            importance: d.importance || "medium",
            source: d.source || "inferred",
            chatId: d.chatId,
            embedding: d.embedding ?? undefined,
        };
    });

    facts.sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime());

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
    let embedding = fact.embedding;
    if (!embedding) {
        try {
            embedding = await getEmbedding(fact.value);
        } catch (err) {
            console.error("Failed to compute embedding for fact, saving without:", err);
        }
    }

    const docRef = await getDb().collection("memory_facts").add({
        ...fact,
        embedding: embedding ?? null,
        chatId,
        lastUpdated: new Date(),
    });

    invalidateCache(chatId);
    return docRef.id;
}

/**
 * Deletes a semantic fact by ID. Invalidates cache.
 */
export async function deleteFact(factId: string): Promise<void> {
    const docRef = getDb().collection("memory_facts").doc(factId);
    const doc = await docRef.get();
    const chatId = doc.data()?.chatId;

    await docRef.delete();

    if (chatId) invalidateCache(chatId);
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
// Explicit memory
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
// Batch Manual Extraction
// ---------------------------------------------------------------------------

const BATCH_SYSTEM_PROMPT = `Analizza queste conversazioni ed estrai fatti permanenti e rilevanti sull'utente.
Cerca: preferenze, abitudini, obiettivi, informazioni personali, pattern ricorrenti.
Ignora domande casuali e task one-shot.
Rispondi SOLO con bullet points brevi (uno per riga, prefisso "- ").
Se non trovi niente di rilevante: NIENTE`;

/**
 * Runs the batch extraction pipeline:
 * 1. Loads last 24h conversations
 * 2. Calls Claude to extract facts
 * 3. Deduplicates against existing memory_facts
 * 4. Saves new facts
 */
export async function runBatch(chatId: string): Promise<BatchResult> {
    const db = getDb();

    // 1. Load conversation
    const convSnap = await db
        .collection("conversations")
        .doc(chatId)
        .get();

    if (!convSnap.exists) {
        return { newFacts: [], duplicatesIgnored: 0 };
    }

    const convData = convSnap.data();
    const messages = (convData?.messages ?? []) as Message[];

    if (messages.length === 0) {
        return { newFacts: [], duplicatesIgnored: 0 };
    }

    // Format conversation for Claude
    const conversationText = messages
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");

    // 2. Call Claude to extract facts
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: BATCH_SYSTEM_PROMPT,
        messages: [{ role: "user", content: conversationText }],
    });

    const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text"
    );
    const rawOutput = textBlocks.map((b) => b.text).join("\n").trim();

    // If Claude says NIENTE or returns empty
    if (!rawOutput || rawOutput.toUpperCase() === "NIENTE") {
        return { newFacts: [], duplicatesIgnored: 0 };
    }

    // Parse bullet points
    const extractedFacts = rawOutput
        .split("\n")
        .map((line) => line.replace(/^[-•*]\s*/, "").trim())
        .filter((line) => line.length > 0);

    if (extractedFacts.length === 0) {
        return { newFacts: [], duplicatesIgnored: 0 };
    }

    // 3. Load existing facts for dedup (with stored embeddings)
    const existingSnap = await db
        .collection("memory_facts")
        .where("chatId", "==", chatId)
        .get();

    const existingFacts = existingSnap.docs.map((doc: FirebaseFirestore.QueryDocumentSnapshot) => {
        const d = doc.data();
        return {
            text: (d.value || d.fact || "") as string,
            embedding: (d.embedding ?? undefined) as number[] | undefined,
        };
    });

    // 4. Deduplicate and save
    const newFacts: string[] = [];
    let duplicatesIgnored = 0;

    for (const fact of extractedFacts) {
        let isDup = false;
        for (const existing of existingFacts) {
            if (await isDuplicate(fact, existing.text, existing.embedding)) {
                isDup = true;
                break;
            }
        }

        if (isDup) {
            duplicatesIgnored++;
        } else {
            // Save using new format
            await saveFact(chatId, {
                key: fact,
                value: fact,
                category: "inferred" as unknown as FactCategory, // fallback
                importance: "medium",
                source: "inferred",
            });
            newFacts.push(fact);
            existingFacts.push({ text: fact, embedding: undefined });
        }
    }

    return { newFacts, duplicatesIgnored };
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
        inferred: "Informazioni Aggiuntive" // For older 'inferred' data or untyped batch
    };

    const sections: string[] = [];
    for (const [cat, items] of grouped) {
        const label = CATEGORY_LABELS[cat] || cat;
        const lines = items.map((i) => `- ${i}`).join("\n");
        sections.push(`### ${label}\n${lines}`);
    }

    return `\n\n## Cose che so su di te\n${sections.join("\n\n")}`;
}
