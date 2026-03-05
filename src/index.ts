import "dotenv/config";
import { initializeApp, cert } from "firebase-admin/app";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { startBot } from "./telegram.js";

// ---------------------------------------------------------------------------
// Firebase init
// ---------------------------------------------------------------------------

function initFirebase(): void {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!serviceAccountPath) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT env var is required");
    }

    const absolutePath = resolve(process.cwd(), serviceAccountPath);
    const serviceAccount = JSON.parse(readFileSync(absolutePath, "utf-8"));

    initializeApp({
        credential: cert(serviceAccount),
    });

    console.log("🔥 Firebase initialized");
}

// ---------------------------------------------------------------------------
// Crash notification
// ---------------------------------------------------------------------------

async function notifyCrash(error: unknown): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) return;

    const errMsg = error instanceof Error
        ? `${error.message}\n\n${error.stack}`
        : String(error);

    const text = `🚨 *Muffin crashed!*\n\n\`\`\`\n${errMsg.substring(0, 3000)}\n\`\`\``;

    try {
        // Use raw fetch to send crash notification — bot may be dead at this point
        await fetch(
            `https://api.telegram.org/bot${token}/sendMessage`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: chatId,
                    text,
                    parse_mode: "Markdown",
                }),
            }
        );
    } catch {
        console.error("Failed to send crash notification");
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    // Global crash handlers
    process.on("uncaughtException", async (error) => {
        console.error("Uncaught Exception:", error);
        await notifyCrash(error);
        process.exit(1);
    });

    process.on("unhandledRejection", async (reason) => {
        console.error("Unhandled Rejection:", reason);
        await notifyCrash(reason);
        process.exit(1);
    });

    // Boot sequence
    initFirebase();
    startBot();
}

main().catch(async (error) => {
    console.error("Fatal startup error:", error);
    await notifyCrash(error);
    process.exit(1);
});
