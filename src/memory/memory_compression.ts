import { getFirestore } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "./memory_messages.js";

const COMPRESSION_THRESHOLD = 40; // Compress when history length > this
const MESSAGES_TO_KEEP = 15;      // Keep the most recent 15 messages after compression

const COMPRESSION_PROMPT = `Trascrivi in un unico riassunto organico e cronologico i punti chiave delle seguenti conversazioni passate.
Non perdere i dettagli tecnici, le opinioni, o il contesto emotivo/relazionale espresso finora.
Evita di fare un mero elenco, crea una sintesi utile a te stesso (aiutante AI) per "ricordare" l'andamento del discorso quando leggerai questo contesto in futuro.`;

/**
 * Checks if the message history requires compression, and if so, performs it in the background.
 * Returns true if compression was triggered.
 */
export async function triggerCompressionIfNeeded(chatId: string, currentHistory: Message[]): Promise<boolean> {
    if (currentHistory.length <= COMPRESSION_THRESHOLD) return false;

    // Fire & forget
    compressMemory(chatId, currentHistory).catch((err) =>
        console.error("Memory compression failed:", err)
    );

    return true;
}

async function compressMemory(chatId: string, fullHistory: Message[]): Promise<void> {
    const db = getFirestore();
    const docRef = db.collection("conversations").doc(chatId);
    const summaryRef = db.collection("memory_summary").doc(chatId);

    // We split history: the oldest ones to sum up, the newest ones to keep
    const splitIndex = fullHistory.length - MESSAGES_TO_KEEP;
    const oldMessages = fullHistory.slice(0, splitIndex);
    const recentMessages = fullHistory.slice(splitIndex);

    // Fetch existing summary to append/merge
    let existingSummary = "";
    const existingSnap = await summaryRef.get();
    if (existingSnap.exists) {
        existingSummary = existingSnap.data()?.summary ?? "";
    }

    const formattedOld = oldMessages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
    let inputToClaude = `### Nuovi messaggi da riassumere:\n${formattedOld}`;

    if (existingSummary) {
        inputToClaude = `### Storico Passato (Riassunto pre-esistente):\n${existingSummary}\n\n${inputToClaude}\n\nFONDI IL RIASSUNTO PASSATO CON I NUOVI MESSAGGI.`;
    }

    try {
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await client.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1500,
            system: COMPRESSION_PROMPT,
            messages: [{ role: "user", content: inputToClaude }]
        });

        const newSummary = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n").trim();

        if (newSummary) {
            // Save new summary
            await summaryRef.set({
                summary: newSummary,
                updatedAt: new Date()
            }, { merge: true });

            // Truncate message history in DB
            await docRef.set({
                messages: recentMessages,
                updatedAt: new Date()
            }, { merge: true });

            console.log(`[Compression] Summarized ${oldMessages.length} messages for chat ${chatId}`);
        }
    } catch (err) {
        throw new Error(`Failed to call Claude for compression: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * Loads the compressed summary from Firestore if it exists.
 */
export async function getMemorySummary(chatId: string): Promise<string> {
    const db = getFirestore();
    const snap = await db.collection("memory_summary").doc(chatId).get();

    if (!snap.exists) return "";

    return snap.data()?.summary ?? "";
}
