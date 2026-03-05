import { getFirestore, type Firestore } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";

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
    chatId: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_EPISODES = 20;
const PARAPHRASE_MODEL = "claude-haiku-4-5-20251001";

const PARAPHRASE_PROMPT = `Riformula il seguente messaggio in massimo 2 frasi, mantenendo l'essenza e le informazioni chiave.
Non aggiungere niente, non commentare. Rispondi SOLO con la riformulazione.
Inoltre, estrai 1-3 parole chiave (topic) separate da virgola.
Formato:
RIFORMULATO: [testo riformulato]
TOPICS: [topic1, topic2]`;

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
    // Skip very short messages — not worth paraphrasing
    if (text.length < 40) {
        await saveRawEpisode(chatId, text, text, [], direction);
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
        const topicsRaw = output.match(/TOPICS:\s*(.+)/i)?.[1]?.trim() || "";
        const topics = topicsRaw
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter((t) => t.length > 0);

        await saveRawEpisode(chatId, text, paraphrased, topics, direction);
    } catch {
        // Fallback: save without paraphrasing
        await saveRawEpisode(chatId, text, text, [], direction);
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

    await col.add({
        timestamp: new Date(),
        direction,
        contentOriginal: original,
        contentParaphrased: paraphrased,
        topics,
        chatId,
    });

    // Trim old episodes: keep last MAX_EPISODES
    await trimEpisodes(chatId);
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
    const snap = await getDb()
        .collection("memory_episodes")
        .where("chatId", "==", chatId)
        .get();

    const episodes = snap.docs.map(docToEpisode);
    episodes.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    return episodes.slice(0, limit).reverse(); // chronological order
}

/**
 * Returns episodes matching a topic keyword.
 */
export async function getEpisodesByTopic(
    chatId: string,
    topic: string
): Promise<EpisodicMessage[]> {
    const topicLower = topic.toLowerCase();

    // Firestore array-contains for exact match on topics array
    const snap = await getDb()
        .collection("memory_episodes")
        .where("chatId", "==", chatId)
        .where("topics", "array-contains", topicLower)
        .get();

    const episodes = snap.docs.map(docToEpisode);
    episodes.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    return episodes.slice(0, 10);
}

/**
 * Gets the timestamp of the last episode for gap detection.
 */
export async function getLastEpisodeTimestamp(
    chatId: string
): Promise<Date | null> {
    const snap = await getDb()
        .collection("memory_episodes")
        .where("chatId", "==", chatId)
        .get();

    if (snap.empty) return null;

    let maxTime = 0;
    for (const doc of snap.docs) {
        const t = doc.data().timestamp?.toDate?.()?.getTime() ?? 0;
        if (t > maxTime) maxTime = t;
    }

    return maxTime > 0 ? new Date(maxTime) : null;
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
        chatId: d.chatId,
    };
}
