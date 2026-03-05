import { Telegraf, Input } from "telegraf";
import { toTelegramHTML } from "./utils/format.js";
import { runBatch } from "./memory/memory_semantic.js";
import { buildMemoryDebugReport } from "./memory/memory_debug.js";
import { logAction } from "./logger.js";
import { processMessage } from "./gateway.js";

// ---------------------------------------------------------------------------
// Telegram bot
// ---------------------------------------------------------------------------

export function startBot(): Telegraf {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
    if (!chatId) throw new Error("TELEGRAM_CHAT_ID is required");

    const bot = new Telegraf(token);

    // Only respond to authorized chat
    bot.use((ctx, next) => {
        if (String(ctx.chat?.id) !== chatId) {
            return; // silently ignore unauthorized chats
        }
        return next();
    });

    // /batch command — extract facts from recent conversations
    bot.command("batch", async (ctx) => {
        const chatIdStr = String(ctx.chat.id);

        try {
            await ctx.sendChatAction("typing");
            const result = await runBatch(chatIdStr);

            await logAction(chatIdStr, "batch_run", {
                newFacts: result.newFacts.length,
                duplicatesIgnored: result.duplicatesIgnored,
            });

            let recap = `Batch completato.\nNuovi fatti salvati: ${result.newFacts.length}`;
            if (result.newFacts.length > 0) {
                recap += "\n" + result.newFacts.map((f) => `- ${f}`).join("\n");
            }
            recap += `\nDuplicati ignorati: ${result.duplicatesIgnored}`;

            await ctx.reply(recap);
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error("Batch error:", errMsg);
            await logAction(chatIdStr, "error", { context: "batch", error: errMsg });
            await ctx.reply(`⚠️ Errore batch: ${errMsg.substring(0, 500)}`);
        }
    });

    // /debug_memory command — dump full memory state as .md file
    bot.command("debug_memory", async (ctx) => {
        const chatIdStr = String(ctx.chat.id);

        try {
            await ctx.sendChatAction("typing");
            const report = await buildMemoryDebugReport(chatIdStr);

            await logAction(chatIdStr, "debug_memory", { reportLength: report.length });

            const buffer = Buffer.from(report, "utf-8");
            await ctx.replyWithDocument(Input.fromBuffer(buffer, "memory_debug.md"));
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error("Debug memory error:", errMsg);
            await ctx.reply(`⚠️ Errore debug memory: ${errMsg.substring(0, 500)}`);
        }
    });

    bot.on("text", async (ctx) => {
        const userText = ctx.message.text;
        const chatIdStr = String(ctx.chat.id);

        try {
            // Show "typing" indicator immediately
            await ctx.sendChatAction("typing");

            // Process the message via the gateway
            const { reply, isDocument } = await processMessage(chatIdStr, userText);

            if (isDocument) {
                // Send as .md file
                const buffer = Buffer.from(reply, "utf-8");
                await ctx.replyWithDocument(Input.fromBuffer(buffer, "response.md"), {
                    caption: reply.substring(0, 200) + "…",
                });
            } else {
                await ctx.reply(toTelegramHTML(reply), { parse_mode: "HTML" });
            }
        } catch (error) {
            const errMsg =
                error instanceof Error ? error.message : String(error);
            console.error("Error processing message:", errMsg);
            await logAction(chatIdStr, "error", { context: "text_handler", error: errMsg });

            try {
                await ctx.reply(`⚠️ Errore: ${errMsg.substring(0, 500)}`);
            } catch {
                // can't even send the error, just log it
                console.error("Failed to send error message to Telegram");
            }
        }
    });

    // Launch bot
    bot.launch();
    console.log("🧁 Muffin bot is running...");

    // Graceful shutdown
    process.once("SIGINT", () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));

    return bot;
}
