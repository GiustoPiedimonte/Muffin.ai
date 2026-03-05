import { getFirestore, Firestore } from "firebase-admin/firestore";

export interface Message {
    role: "user" | "assistant";
    content: string;
}

interface ConversationDoc {
    messages: Message[];
    updatedAt: FirebaseFirestore.Timestamp;
}

const MAX_HISTORY = 50;

let db: Firestore;

function getDb(): Firestore {
    if (!db) db = getFirestore();
    return db;
}

/**
 * Retrieves the last N messages for a given chat.
 */
export async function getHistory(chatId: string): Promise<Message[]> {
    const doc = await getDb()
        .collection("conversations")
        .doc(chatId)
        .get();

    if (!doc.exists) return [];

    const data = doc.data() as ConversationDoc | undefined;
    return data?.messages ?? [];
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

    // Trim to last MAX_HISTORY messages
    if (messages.length > MAX_HISTORY) {
        messages = messages.slice(-MAX_HISTORY);
    }

    await docRef.set(
        {
            messages,
            updatedAt: new Date(),
        },
        { merge: true }
    );
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
