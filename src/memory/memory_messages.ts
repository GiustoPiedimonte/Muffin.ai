import { getFirestore, Firestore } from "firebase-admin/firestore";
import { triggerCompressionIfNeeded } from "./memory_compression.js";

export interface Message {
    role: "user" | "assistant";
    content: string;
}

interface ConversationDoc {
    messages: Message[];
    updatedAt: FirebaseFirestore.Timestamp;
}

let db: Firestore;

function getDb(): Firestore {
    if (!db) db = getFirestore();
    return db;
}

/**
 * Retrieves the last N messages for a given chat.
 * We limit this to the most recent 15 messages to save input/cache tokens,
 * relying on the background compression summary for older context.
 */
export async function getHistory(chatId: string, limit = 15): Promise<Message[]> {
    const doc = await getDb()
        .collection("conversations")
        .doc(chatId)
        .get();

    if (!doc.exists) return [];

    const data = doc.data() as ConversationDoc | undefined;
    const allMessages = data?.messages ?? [];

    // Return only the most recent 'limit' messages
    return allMessages.slice(-limit);
}

/**
 * Appends a user or assistant message to conversation history
 * and trims to the last MAX_HISTORY messages.
 */
export async function saveMessages(
    chatId: string,
    newMessages: Message[]
): Promise<void> {
    const docRef = getDb().collection("conversations").doc(chatId);
    const doc = await docRef.get();

    let messages: Message[] = [];
    if (doc.exists) {
        const data = doc.data() as ConversationDoc | undefined;
        messages = data?.messages ?? [];
    }

    messages.push(...newMessages);

    await docRef.set(
        {
            messages,
            updatedAt: new Date(),
        },
        { merge: true }
    );

    // Trigger compression in background. It will trim the history if it exceeds the threshold.
    triggerCompressionIfNeeded(chatId, messages).catch(err => console.error("Compression trigger error:", err));
}

/**
 * Returns the timestamp of the last conversation update.
 */
export async function getLastMessageTimestamp(
    chatId: string
): Promise<Date | null> {
    const doc = await getDb()
        .collection("conversations")
        .doc(chatId)
        .get();

    if (!doc.exists) return null;

    const data = doc.data();
    return data?.updatedAt?.toDate?.() ?? null;
}
