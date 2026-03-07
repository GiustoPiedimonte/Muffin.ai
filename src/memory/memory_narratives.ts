import { getFirestore, type Firestore } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";
import { getEmbedding, cosineSimilarity } from "./memory_embeddings.js";
import { invalidateContextCache } from "./memory_cache.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NarrativeEvent {
    timestamp: Date;
    summary: string;
    sourceMessage: string;
    sentiment?: "positive" | "negative" | "neutral";
}

export interface NarrativeThread {
    id?: string;
    chatId: string;
    title: string;
    status: "active" | "resolved" | "dormant";
    events: NarrativeEvent[];
    runningSummary: string;
    embedding?: number[];
    createdAt: Date;
    updatedAt: Date;
}

interface NarrativeExtractionResult {
    threadTitle: string;
    eventSummary: string;
    sentiment: "positive" | "negative" | "neutral";
    isNewThread: boolean;
    existingThreadHint?: string;
}

interface NarrativeMatchResult {
    thread: NarrativeThread;
    score: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_ACTIVE_THREADS = 5;
const MAX_EVENTS_PER_THREAD = 30;
const MATCH_THRESHOLD = 0.45;
const MAX_NARRATIVES_IN_CONTEXT = 2;
const DORMANT_AFTER_DAYS = 30;
const EXTRACTION_MODEL = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
    threads: NarrativeThread[];
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

function docToThread(doc: FirebaseFirestore.QueryDocumentSnapshot): NarrativeThread {
    const d = doc.data();
    return {
        id: doc.id,
        chatId: d.chatId,
        title: d.title,
        status: d.status || "active",
        events: (d.events || []).map((e: any) => ({
            timestamp: e.timestamp?.toDate?.() ?? new Date(e.timestamp),
            summary: e.summary,
            sourceMessage: e.sourceMessage,
            sentiment: e.sentiment,
        })),
        runningSummary: d.runningSummary || "",
        embedding: d.embedding ?? undefined,
        createdAt: d.createdAt?.toDate?.() ?? new Date(),
        updatedAt: d.updatedAt?.toDate?.() ?? new Date(),
    };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const NARRATIVE_EXTRACTION_PROMPT = `Sei un analizzatore di narrazioni. Analizza lo scambio e determina se contiene un EVENTO che fa parte di una storia in corso.

Una "narrativa" è una situazione che si sviluppa nel tempo: un progetto, una trattativa, una relazione professionale, un obiettivo, un problema ricorrente.

ESTRAI solo se il messaggio contiene:
- Un evento con conseguenze future ("il meeting è andato male perché...")
- Un aggiornamento su qualcosa già in corso ("finalmente hanno risposto", "domani ho un altro incontro")
- L'inizio di qualcosa che avrà seguito ("ho iniziato a parlare con X per...")
- Una conclusione ("alla fine abbiamo chiuso", "ho deciso di non farlo più")

NON ESTRARRE:
- Domande tecniche one-shot
- Commenti casuali senza sviluppo futuro
- Task isolati senza contesto narrativo
- Opinioni generiche

Se c'è un evento narrativo, rispondi con:
TITOLO: [titolo breve della narrativa, max 6 parole]
EVENTO: [cosa è successo, max 2 frasi]
SENTIMENTO: positivo|negativo|neutro
NUOVO: sì|no (sì = nuova storia, no = aggiornamento di storia esistente)
COLLEGAMENTO: [se NUOVO=no, titolo approssimativo della storia esistente]

Se NON c'è nessun evento narrativo: rispondi SOLO con NIENTE`;

const SUMMARY_UPDATE_PROMPT = `Aggiorna il riassunto narrativo incorporando il nuovo evento.
Il riassunto deve essere una sintesi cronologica e coerente, utile per ricordare l'andamento di questa storia.
Mantieni il contesto emotivo e le connessioni causali tra gli eventi.
Max 3-4 frasi.

Riassunto attuale:
{CURRENT_SUMMARY}

Nuovo evento ({DATE}):
{NEW_EVENT}

Scrivi SOLO il nuovo riassunto aggiornato, nient'altro.`;

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function loadNarratives(chatId: string): Promise<NarrativeThread[]> {
    if (isCacheValid(chatId)) {
        return cache.get(chatId)!.threads;
    }

    const snap = await getDb()
        .collection("memory_narratives")
        .where("chatId", "==", chatId)
        .get();

    const threads = snap.docs.map(docToThread);
    threads.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    // Lazy dormancy check
    const now = Date.now();
    const dormantThresholdMs = DORMANT_AFTER_DAYS * 24 * 60 * 60 * 1000;
    for (const thread of threads) {
        if (thread.status === "active" && now - thread.updatedAt.getTime() > dormantThresholdMs) {
            if (thread.id) {
                markDormant(thread.id).catch(err =>
                    console.warn("Failed to auto-dormant thread:", err)
                );
            }
            thread.status = "dormant";
        }
    }

    cache.set(chatId, { threads, loadedAt: Date.now() });
    return threads;
}

export async function getActiveNarratives(chatId: string): Promise<NarrativeThread[]> {
    const all = await loadNarratives(chatId);
    return all.filter(t => t.status === "active");
}

export async function createThread(
    chatId: string,
    title: string,
    firstEvent: NarrativeEvent,
    initialSummary: string
): Promise<string> {
    let embedding: number[] | undefined;
    try {
        embedding = await getEmbedding(initialSummary);
    } catch (err) {
        console.warn("Failed to compute embedding for narrative thread:", err);
    }

    const now = new Date();
    const docRef = await getDb().collection("memory_narratives").add({
        chatId,
        title,
        status: "active",
        events: [{
            timestamp: firstEvent.timestamp,
            summary: firstEvent.summary,
            sourceMessage: firstEvent.sourceMessage,
            sentiment: firstEvent.sentiment || "neutral",
        }],
        runningSummary: initialSummary,
        embedding: embedding ?? null,
        createdAt: now,
        updatedAt: now,
    });

    invalidateCache(chatId);
    invalidateContextCache(chatId);
    console.log(`Narrative thread created: "${title}" (${docRef.id})`);
    return docRef.id;
}

export async function appendEvent(
    threadId: string,
    event: NarrativeEvent,
    newSummary: string
): Promise<void> {
    const docRef = getDb().collection("memory_narratives").doc(threadId);
    const doc = await docRef.get();
    if (!doc.exists) return;

    const data = doc.data()!;
    const chatId = data.chatId;
    const events = data.events || [];

    events.push({
        timestamp: event.timestamp,
        summary: event.summary,
        sourceMessage: event.sourceMessage,
        sentiment: event.sentiment || "neutral",
    });

    // Trim: keep first 5 (origin) + last 25 (recent)
    let trimmedEvents = events;
    if (events.length > MAX_EVENTS_PER_THREAD) {
        const origin = events.slice(0, 5);
        const recent = events.slice(-25);
        trimmedEvents = [...origin, ...recent];
    }

    let embedding: number[] | undefined;
    try {
        embedding = await getEmbedding(newSummary);
    } catch (err) {
        console.warn("Failed to recompute embedding for narrative:", err);
    }

    await docRef.update({
        events: trimmedEvents,
        runningSummary: newSummary,
        embedding: embedding ?? data.embedding ?? null,
        updatedAt: new Date(),
    });

    invalidateCache(chatId);
    invalidateContextCache(chatId);
    console.log(`Narrative event appended to thread "${data.title}" (${threadId})`);
}

export async function markDormant(threadId: string): Promise<void> {
    const docRef = getDb().collection("memory_narratives").doc(threadId);
    const doc = await docRef.get();
    const chatId = doc.data()?.chatId;

    await docRef.update({ status: "dormant" });

    if (chatId) {
        invalidateCache(chatId);
        invalidateContextCache(chatId);
    }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

async function extractNarrativeFromMessage(
    userMessage: string,
    claudeResponse: string,
    existingTitles: string[]
): Promise<NarrativeExtractionResult | null> {
    const threadContext = existingTitles.length > 0
        ? `\n\nNarrative attive:\n${existingTitles.map(t => `- ${t}`).join("\n")}`
        : "";

    try {
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await client.messages.create({
            model: EXTRACTION_MODEL,
            max_tokens: 256,
            messages: [{
                role: "user",
                content: `${NARRATIVE_EXTRACTION_PROMPT}${threadContext}\n\n---\nGiusto: ${userMessage}\nMuffin: ${claudeResponse}`,
            }],
        });

        const output = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map(b => b.text)
            .join("\n")
            .trim();

        if (!output || output.toUpperCase() === "NIENTE") {
            return null;
        }

        const titleMatch = output.match(/TITOLO:\s*(.+)/i);
        const eventMatch = output.match(/EVENTO:\s*(.+)/i);
        const sentimentMatch = output.match(/SENTIMENTO:\s*(.+)/i);
        const newMatch = output.match(/NUOVO:\s*(.+)/i);
        const linkMatch = output.match(/COLLEGAMENTO:\s*(.+)/i);

        if (!titleMatch || !eventMatch) return null;

        const sentimentRaw = sentimentMatch?.[1]?.trim().toLowerCase() || "neutro";
        const sentiment = sentimentRaw === "positivo" ? "positive"
            : sentimentRaw === "negativo" ? "negative"
            : "neutral";

        const isNew = newMatch?.[1]?.trim().toLowerCase().startsWith("sì") ?? true;

        return {
            threadTitle: titleMatch[1].trim(),
            eventSummary: eventMatch[1].trim(),
            sentiment,
            isNewThread: isNew,
            existingThreadHint: linkMatch?.[1]?.trim(),
        };
    } catch (err) {
        console.error("Narrative extraction failed:", err);
        return null;
    }
}

async function regenerateSummary(
    currentSummary: string,
    newEvent: string
): Promise<string> {
    const dateStr = new Date().toLocaleDateString("it-IT", {
        day: "numeric",
        month: "long",
        year: "numeric",
    });

    const prompt = SUMMARY_UPDATE_PROMPT
        .replace("{CURRENT_SUMMARY}", currentSummary)
        .replace("{DATE}", dateStr)
        .replace("{NEW_EVENT}", newEvent);

    try {
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await client.messages.create({
            model: EXTRACTION_MODEL,
            max_tokens: 300,
            messages: [{ role: "user", content: prompt }],
        });

        const output = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map(b => b.text)
            .join("\n")
            .trim();

        return output || currentSummary;
    } catch (err) {
        console.error("Summary regeneration failed:", err);
        return currentSummary;
    }
}

// ---------------------------------------------------------------------------
// Matching & Retrieval
// ---------------------------------------------------------------------------

async function findMatchingThread(
    chatId: string,
    query: string
): Promise<NarrativeMatchResult | null> {
    const threads = await getActiveNarratives(chatId);
    if (threads.length === 0) return null;

    let queryVec: number[];
    try {
        queryVec = await getEmbedding(query, "query");
    } catch (err) {
        console.warn("Failed to compute query embedding for narrative matching:", err);
        return null;
    }

    let bestMatch: NarrativeMatchResult | null = null;

    for (const thread of threads) {
        if (!thread.embedding) continue;
        const score = cosineSimilarity(queryVec, thread.embedding);
        if (score > MATCH_THRESHOLD && (!bestMatch || score > bestMatch.score)) {
            bestMatch = { thread, score };
        }
    }

    return bestMatch;
}

async function searchNarratives(
    chatId: string,
    query: string,
    limit = MAX_NARRATIVES_IN_CONTEXT
): Promise<NarrativeMatchResult[]> {
    const threads = await getActiveNarratives(chatId);
    if (threads.length === 0) return [];

    let queryVec: number[];
    try {
        queryVec = await getEmbedding(query, "query");
    } catch (err) {
        console.warn("Failed to compute query embedding for narrative search:", err);
        return [];
    }

    const scored: NarrativeMatchResult[] = [];
    for (const thread of threads) {
        if (!thread.embedding) continue;
        const score = cosineSimilarity(queryVec, thread.embedding);
        if (score > MATCH_THRESHOLD) {
            scored.push({ thread, score });
        }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Context building (called by memory_retrieval.ts)
// ---------------------------------------------------------------------------

export async function buildNarrativeContext(
    chatId: string,
    userMessage: string
): Promise<string> {
    const matches = await searchNarratives(chatId, userMessage);
    if (matches.length === 0) return "";

    const sections = matches.map(({ thread }) => {
        const lastEvent = thread.events[thread.events.length - 1];
        const daysSince = lastEvent
            ? Math.floor((Date.now() - lastEvent.timestamp.getTime()) / (1000 * 60 * 60 * 24))
            : 0;
        const timeLabel = daysSince === 0 ? "oggi"
            : daysSince === 1 ? "ieri"
            : `${daysSince} giorni fa`;

        return `### ${thread.title} (ultimo aggiornamento: ${timeLabel})\n${thread.runningSummary}`;
    });

    return `\n\n## Storie in corso\nQueste sono narrazioni attive che potresti voler collegare alla conversazione attuale, se pertinenti. Usa queste informazioni per fare collegamenti proattivi (es. "ricorda che l'ultima volta...").\n${sections.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Orchestrator (called by gateway.ts)
// ---------------------------------------------------------------------------

export async function processNarrative(
    chatId: string,
    userMessage: string,
    claudeResponse: string
): Promise<void> {
    // Skip very short messages
    if (userMessage.trim().length < 15) return;

    // 1. Load existing active thread titles
    const activeThreads = await getActiveNarratives(chatId);
    const titles = activeThreads.map(t => t.title);

    // 2. Extract narrative from message
    const extraction = await extractNarrativeFromMessage(
        userMessage, claudeResponse, titles
    );
    if (!extraction) return;

    const event: NarrativeEvent = {
        timestamp: new Date(),
        summary: extraction.eventSummary,
        sourceMessage: userMessage,
        sentiment: extraction.sentiment,
    };

    if (extraction.isNewThread) {
        // Auto-dormant oldest if at capacity
        if (activeThreads.length >= MAX_ACTIVE_THREADS) {
            const oldest = activeThreads[activeThreads.length - 1];
            if (oldest.id) {
                await markDormant(oldest.id);
                console.log(`Auto-dormant thread "${oldest.title}" (capacity limit)`);
            }
        }
        await createThread(chatId, extraction.threadTitle, event, extraction.eventSummary);
    } else {
        // Find matching existing thread
        const hint = extraction.existingThreadHint || extraction.threadTitle;
        const match = await findMatchingThread(chatId, hint);

        if (match) {
            const newSummary = await regenerateSummary(
                match.thread.runningSummary,
                extraction.eventSummary
            );
            await appendEvent(match.thread.id!, event, newSummary);
        } else {
            // No match found — create new thread anyway
            await createThread(chatId, extraction.threadTitle, event, extraction.eventSummary);
        }
    }
}
