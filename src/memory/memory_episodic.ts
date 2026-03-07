import { getFirestore, type Firestore } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";
import { invalidateContextCache } from "./memory_cache.js";
import { getEmbedding, cosineSimilarity } from "./memory_embeddings.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EpisodicMessage {
    id?: string;
    timestamp: Date;
    direction: "user" | "muffin";
    contentOriginal: string;
    contentParaphrased: string;
    topics: string[];
    embedding?: number[];
    chatId: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_EPISODES = 20;
const MIN_EPISODE_LENGTH = 60; // Skip messages shorter than this
const PARAPHRASE_MODEL = "claude-haiku-4-5-20251001";

const PARAPHRASE_PROMPT = `Riformula il seguente messaggio in massimo 2 frasi, mantenendo l'essenza e le informazioni chiave.
Non aggiungere niente, non commentare. Rispondi SOLO con la riformulazione.
Inoltre, estrai 1-3 parole chiave (topic) separate da virgola.
Formato:
RIFORMULATO: [testo riformulato]
TOPICS: [topic1, topic2]`;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface EpisodicCacheEntry {
    episodes: EpisodicMessage[];
    loadedAt: number;
}

const cache = new Map<string, EpisodicCacheEntry>();

function isCacheValid(chatId: string): boolean {
    const entry = cache.get(chatId);
    if (!entry) return false;
    return Date.now() - entry.loadedAt < CACHE_TTL_MS;
}

function invalidateCache(chatId: string): void {
    cache.delete(chatId);
}

export async function loadAllEpisodes(chatId: string): Promise<EpisodicMessage[]> {
    if (isCacheValid(chatId)) {
        return cache.get(chatId)!.episodes;
    }

    const snap = await getDb()
        .collection("memory_episodes")
        .where("chatId", "==", chatId)
        .get();

    const episodes = snap.docs.map(docToEpisode);
    episodes.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    cache.set(chatId, { episodes, loadedAt: Date.now() });
    return episodes;
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
 * Simple keyword extraction fallback when Haiku fails to extract topics.
 * Extracts common words (length > 2) and removes stopwords.
 */
function extractKeywords(text: string): string[] {
    const stopwords = new Set([
        "il", "la", "le", "lo", "i", "gli", "un", "una", "uno", "dei", "del", "e",
        "che", "è", "sono", "ho", "hai", "abbiamo", "avete", "hanno", "di", "da",
        "in", "su", "per", "con", "a", "o", "se", "non", "ma", "come", "quando",
    ]);

    const words = text
        .toLowerCase()
        .split(/\s+/)
        .filter(
            (w) => w.length > 2 && !stopwords.has(w) && /[a-z]/.test(w)
        );

    // Return unique words, limit to 3
    return [...new Set(words)].slice(0, 3);
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Saves a pair of user+assistant messages as episodes.
 * Rielaborazione asincrona via Claude Haiku — non blocca.
 */
export async function saveEpisode(
    chatId: string,
    userText: string,
    assistantText: string
): Promise<void> {
    // Fire-and-forget: paraphrase + save in background
    paraphraseAndSave(chatId, userText, "user").catch((err) =>
        console.error("Episodic save (user) failed:", err)
    );
    paraphraseAndSave(chatId, assistantText, "muffin").catch((err) =>
        console.error("Episodic save (muffin) failed:", err)
    );
}

async function paraphraseAndSave(
    chatId: string,
    text: string,
    direction: "user" | "muffin"
): Promise<void> {
    // FIX 1: Skip very short messages — not worth paraphrasing
    if (text.length < MIN_EPISODE_LENGTH) {
        console.debug(
            `Skipping short episode (${text.length} chars): "${text.substring(0, 40)}..."`
        );
        return;
    }

    try {
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await client.messages.create({
            model: PARAPHRASE_MODEL,
            max_tokens: 256,
            messages: [{ role: "user", content: `${PARAPHRASE_PROMPT}\n\nMessaggio:\n${text}` }],
        });

        const output = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n");

        const paraphrased = output.match(/RIFORMULATO:\s*(.+)/i)?.[1]?.trim() || text;
        let topics = output
            .match(/TOPICS:\s*(.+)/i)?.[1]
            ?.trim()
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter((t) => t.length > 0) || [];

        // FIX 2: Fallback to keyword extraction if topics is empty
        if (topics.length === 0) {
            topics = extractKeywords(text);
            if (topics.length > 0) {
                console.debug(`Fallback topics extracted: ${topics.join(", ")}`);
            }
        }

        await saveRawEpisode(chatId, text, paraphrased, topics, direction);
    } catch (err) {
        // Fallback: save without paraphrasing, with keyword extraction
        const fallbackTopics = extractKeywords(text);
        console.warn(
            `Paraphrase failed, saving raw with fallback topics: ${fallbackTopics.join(", ")}`
        );
        await saveRawEpisode(chatId, text, text, fallbackTopics, direction);
    }
}

async function saveRawEpisode(
    chatId: string,
    original: string,
    paraphrased: string,
    topics: string[],
    direction: "user" | "muffin"
): Promise<void> {
    const db = getDb();
    const col = db.collection("memory_episodes");

    // Try to compute embedding for semantic search later
    let embedding: number[] | undefined;
    try {
        embedding = await getEmbedding(paraphrased);
    } catch (err) {
        console.warn("Failed to compute embedding for episode:", err);
        // Continue without embedding — semantic search will skip this one
    }

    await col.add({
        timestamp: new Date(),
        direction,
        contentOriginal: original,
        contentParaphrased: paraphrased,
        topics,
        embedding,
        chatId,
    });

    // Trim old episodes: keep last MAX_EPISODES
    await trimEpisodes(chatId);

    // Invalidate context cache so next message reloads memory
    invalidateCache(chatId);
    invalidateContextCache(chatId);
}

async function trimEpisodes(chatId: string): Promise<void> {
    const db = getDb();
    const snap = await getDb()
        .collection("memory_episodes")
        .where("chatId", "==", chatId)
        .get();

    if (snap.empty) return;

    // In-memory sort
    const episodes = snap.docs.map((doc) => ({
        doc,
        timestamp: doc.data().timestamp?.toDate?.()?.getTime() ?? 0,
    }));
    episodes.sort((a, b) => b.timestamp - a.timestamp);

    const toDelete = episodes.slice(MAX_EPISODES);
    if (toDelete.length === 0) return;

    const batch = db.batch();
    for (const item of toDelete) {
        batch.delete(item.doc.ref);
    }
    await batch.commit();
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Returns the N most recent episodes.
 */
export async function getRecentEpisodes(
    chatId: string,
    limit = 10
): Promise<EpisodicMessage[]> {
    const episodes = await loadAllEpisodes(chatId);
    return episodes.slice(0, limit).reverse(); // chronological order
}

/**
 * FIX 3: Hybrid retrieval — exact match on topics + semantic search on content.
 * Returns episodes matching a topic keyword, with fallback to semantic similarity.
 */
export async function getEpisodesByTopic(
    chatId: string,
    topic: string,
    semanticThreshold = 0.6
): Promise<EpisodicMessage[]> {
    const topicLower = topic.toLowerCase();

    const episodes = await loadAllEpisodes(chatId);

    // Step 1: Exact topic match
    const exactMatches = episodes.filter((e) => e.topics.includes(topicLower));
    if (exactMatches.length > 0) {
        exactMatches.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        return exactMatches.slice(0, 10);
    }

    // Step 2: Semantic search if no exact matches
    try {
        const queryVec = await getEmbedding(topic, "query");
        const scored = episodes
            .map((e) => ({
                episode: e,
                score: e.embedding ? cosineSimilarity(queryVec, e.embedding) : 0,
            }))
            .filter((item) => item.score > semanticThreshold)
            .sort((a, b) => b.score - a.score);

        return scored.slice(0, 10).map((item) => item.episode);
    } catch (err) {
        console.warn(`Semantic search for topic "${topic}" failed:`, err);
        // Fallback: empty result
        return [];
    }
}

/**
 * Gets the timestamp of the last episode for gap detection.
 */
export async function getLastEpisodeTimestamp(
    chatId: string
): Promise<Date | null> {
    const episodes = await loadAllEpisodes(chatId);
    if (episodes.length === 0) return null;

    // loadAllEpisodes returns sorted descending by timestamp
    return episodes[0].timestamp;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function docToEpisode(doc: FirebaseFirestore.QueryDocumentSnapshot): EpisodicMessage {
    const d = doc.data();
    return {
        id: doc.id,
        timestamp: d.timestamp?.toDate?.() ?? new Date(),
        direction: d.direction,
        contentOriginal: d.contentOriginal,
        contentParaphrased: d.contentParaphrased,
        topics: d.topics ?? [],
        embedding: d.embedding,
        chatId: d.chatId,
    };
}
