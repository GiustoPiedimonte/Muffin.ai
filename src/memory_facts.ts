import { getFirestore } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryFact {
    fact: string;
    source: "explicit" | "inferred";
    timestamp: Date;
    confidence: "high" | "medium";
    chatId: string;
}

export interface BatchResult {
    newFacts: string[];
    duplicatesIgnored: number;
}

// ---------------------------------------------------------------------------
// Patterns for explicit memory
// ---------------------------------------------------------------------------

const EXPLICIT_PATTERNS = [
    /^ricordati\s+che\s+/i,
    /^salva\s+che\s+/i,
    /^tieni\s+a\s+mente\s+che\s+/i,
    /^memorizza\s+che\s+/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDb() {
    return getFirestore();
}

/**
 * Normalize text for keyword comparison:
 * lowercase, strip punctuation, split into words > 3 chars.
 */
function extractKeywords(text: string): Set<string> {
    const normalized = text
        .toLowerCase()
        .replace(/[^\w\sàèéìòù]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 3);
    return new Set(normalized);
}

/**
 * Returns true if >60% of newFact's keywords appear in existingFact.
 */
function isDuplicate(newFact: string, existingFact: string): boolean {
    const newKeywords = extractKeywords(newFact);
    const existingKeywords = extractKeywords(existingFact);

    if (newKeywords.size === 0) return false;

    let matches = 0;
    for (const kw of newKeywords) {
        if (existingKeywords.has(kw)) matches++;
    }

    return matches / newKeywords.size > 0.6;
}

// ---------------------------------------------------------------------------
// Mechanism 1: Explicit memory (real-time)
// ---------------------------------------------------------------------------

/**
 * Checks if the user message contains an explicit memory pattern.
 * Returns the extracted fact or null.
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
 * Saves an explicit fact to Firestore.
 */
export async function saveExplicitFact(
    chatId: string,
    fact: string
): Promise<void> {
    await getDb().collection("memory_facts").add({
        fact,
        source: "explicit",
        timestamp: new Date(),
        confidence: "high",
        chatId,
    });
}

// ---------------------------------------------------------------------------
// Mechanism 2: Batch manual
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
    const messages = convData?.messages ?? [];

    if (messages.length === 0) {
        return { newFacts: [], duplicatesIgnored: 0 };
    }

    // Format conversation for Claude
    const conversationText = messages
        .map((m: { role: string; content: string }) => `${m.role}: ${m.content}`)
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

    // 3. Load existing facts for dedup
    const existingSnap = await db
        .collection("memory_facts")
        .where("chatId", "==", chatId)
        .get();

    const existingFacts = existingSnap.docs.map(
        (doc) => doc.data().fact as string
    );

    // 4. Deduplicate and save
    const newFacts: string[] = [];
    let duplicatesIgnored = 0;

    for (const fact of extractedFacts) {
        const isDup = existingFacts.some((existing) =>
            isDuplicate(fact, existing)
        );

        if (isDup) {
            duplicatesIgnored++;
        } else {
            await db.collection("memory_facts").add({
                fact,
                source: "inferred",
                timestamp: new Date(),
                confidence: "medium",
                chatId,
            });
            newFacts.push(fact);
            existingFacts.push(fact);
        }
    }

    return { newFacts, duplicatesIgnored };
}

// ---------------------------------------------------------------------------
// Context integration
// ---------------------------------------------------------------------------

/**
 * Loads all memory facts for a chat, ordered by source (explicit first)
 * then by timestamp.
 */
export async function getMemoryFacts(chatId: string): Promise<MemoryFact[]> {
    const snap = await getDb()
        .collection("memory_facts")
        .where("chatId", "==", chatId)
        .get();

    const facts = snap.docs.map((doc) => {
        const d = doc.data();
        return {
            fact: d.fact,
            source: d.source,
            timestamp: d.timestamp?.toDate?.() ?? new Date(d.timestamp),
            confidence: d.confidence,
            chatId: d.chatId,
        } as MemoryFact;
    });

    // Sort: explicit first, then inferred, each group by timestamp
    const explicit = facts.filter((f) => f.source === "explicit");
    const inferred = facts.filter((f) => f.source === "inferred");

    return [...explicit, ...inferred];
}

/**
 * Builds the memory context string to inject into the system prompt.
 * Returns empty string if no facts are stored.
 */
export async function buildMemoryContext(chatId: string): Promise<string> {
    const facts = await getMemoryFacts(chatId);

    if (facts.length === 0) return "";

    const lines = facts.map((f) => `- ${f.fact}`);

    return `\n\n## Cose che so su di te\n${lines.join("\n")}`;
}
