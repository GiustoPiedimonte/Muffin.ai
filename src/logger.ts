import { getFirestore } from "firebase-admin/firestore";

// ---------------------------------------------------------------------------
// Agent decision logger — writes to Firestore `agent_logs` collection
// ---------------------------------------------------------------------------

export type LogAction =
    | "message_received"
    | "claude_call"
    | "tool_use"
    | "response_sent"
    | "error"
    | "explicit_memory_saved"
    | "batch_run"
    | "memory_saved"
    | "memory_confirmation_sent"
    | "memory_confirmed"
    | "debug_memory"
    | "conflict_detected";

interface LogEntry {
    chatId: string;
    action: LogAction;
    details: Record<string, unknown>;
    timestamp: Date;
}

/**
 * Logs an agent decision/action to Firestore.
 * Non-blocking — errors are caught and printed, never thrown.
 */
export async function logAction(
    chatId: string,
    action: LogAction,
    details: Record<string, unknown> = {}
): Promise<void> {
    try {
        const entry: LogEntry = {
            chatId,
            action,
            details,
            timestamp: new Date(),
        };

        await getFirestore().collection("agent_logs").add(entry);
    } catch (err) {
        // Logger must never crash the bot
        console.error("Logger write failed:", err);
    }
}
