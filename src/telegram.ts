import { Telegraf, Input, Context } from "telegraf";
import { toTelegramHTML } from "./utils/format.js";
import { runBatch } from "./memory/memory_semantic.js";
import { buildMemoryDebugReport } from "./memory/memory_debug.js";
import { logAction } from "./logger.js";
import { processMessage } from "./gateway.js";
import {
  updateWorkStatus,
  getWorkState,
  saveMessageId,
} from "./firebase/agent_state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const chatBuffers = new Map<string, { texts: string[]; timer: NodeJS.Timeout | null }>();
const BUFFER_DELAY_MS = 2500;

async function sendChunkedMessage(ctx: Context, text: string) {
  const CHUNK_SIZE = 4000;
  if (text.length <= CHUNK_SIZE) {
    await ctx.reply(toTelegramHTML(text), { parse_mode: "HTML" });
    return;
  }

  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_SIZE) {
      await ctx.reply(toTelegramHTML(remaining), { parse_mode: "HTML" });
      break;
    }

    let breakPoint = remaining.lastIndexOf("\n\n", CHUNK_SIZE);
    if (breakPoint === -1 || breakPoint < CHUNK_SIZE - 500) {
      breakPoint = remaining.lastIndexOf("\n", CHUNK_SIZE);
    }
    if (breakPoint === -1 || breakPoint < CHUNK_SIZE - 500) {
      breakPoint = remaining.lastIndexOf(" ", CHUNK_SIZE);
    }
    if (breakPoint === -1 || breakPoint < CHUNK_SIZE - 500) {
      breakPoint = CHUNK_SIZE;
    }

    const chunk = remaining.substring(0, breakPoint);
    try {
      await ctx.reply(toTelegramHTML(chunk), { parse_mode: "HTML" });
    } catch (e) {
      console.warn("Failed to send chunk with HTML format, falling back to raw.", e);
      await ctx.reply(chunk);
    }
    remaining = remaining.substring(breakPoint).trimStart();
  }
}

// ---------------------------------------------------------------------------
// Telegram bot
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

  // Handle user messages
  bot.on("text", async (ctx) => {
    const userText = ctx.message.text;
    const chatIdStr = String(ctx.chat.id);

    // Buffer incoming messages
    if (!chatBuffers.has(chatIdStr)) {
      chatBuffers.set(chatIdStr, { texts: [], timer: null });
    }
    const buffer = chatBuffers.get(chatIdStr)!;

    buffer.texts.push(userText);

    if (buffer.timer) {
      clearTimeout(buffer.timer);
    }

    // Fire and forget typing status while user is chaining messages
    ctx.sendChatAction("typing").catch(() => { });

    buffer.timer = setTimeout(async () => {
      // Extract combined text and reset buffer BEFORE processing, 
      // so new messages coming during generation go to a new buffer block.
      const combinedText = buffer.texts.join("\n\n");
      buffer.texts = [];
      buffer.timer = null;

      let statusMsgId: number | null = null;
      let initialStatusTimeout: NodeJS.Timeout | null = null;
      let isFinished = false;

      const onStatusUpdate = async (text: string) => {
        if (isFinished) return;

        try {
          if (!statusMsgId) {
            if (initialStatusTimeout) clearTimeout(initialStatusTimeout);

            const msg = await ctx.reply(toTelegramHTML(text), { parse_mode: "HTML" });
            statusMsgId = msg.message_id;
          } else {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMsgId,
              undefined,
              toTelegramHTML(text),
              { parse_mode: "HTML" }
            );
          }
        } catch (err) {
          console.warn("Error updating status message:", err);
        }
      };

      initialStatusTimeout = setTimeout(() => {
        if (!isFinished && !statusMsgId) {
          onStatusUpdate("⏳ Sto analizzando il contesto...").catch(() => { });
        }
      }, 1500);

      try {
        const { reply } = await processMessage(
          chatIdStr,
          combinedText,
          onStatusUpdate,
          async (followUpText: string) => {
            try {
              await sendChunkedMessage(ctx, followUpText);
            } catch (e) {
              console.error("Failed to send follow up message:", e);
            }
          }
        );

        isFinished = true;
        if (initialStatusTimeout) clearTimeout(initialStatusTimeout);

        if (statusMsgId) {
          try {
            await ctx.telegram.deleteMessage(ctx.chat.id, statusMsgId);
          } catch (e) {
            console.warn("Could not delete status message:", e);
          }
        }

        await sendChunkedMessage(ctx, reply);

      } catch (error) {
        isFinished = true;
        if (initialStatusTimeout) clearTimeout(initialStatusTimeout);

        if (statusMsgId) {
          try {
            await ctx.telegram.deleteMessage(ctx.chat.id, statusMsgId);
          } catch (e) { }
        }

        const errMsg = error instanceof Error ? error.message : String(error);
        console.error("Error processing message:", errMsg);
        await logAction(chatIdStr, "error", { context: "text_handler", error: errMsg });

        try {
          await ctx.reply(`⚠️ Errore: ${errMsg.substring(0, 500)}`);
        } catch {
          console.error("Failed to send error message to Telegram");
        }
      }
    }, BUFFER_DELAY_MS);
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

  // Launch bot
  bot.launch();
  console.log("🧁 Muffin bot is running...");

  // Graceful shutdown
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  return bot;
}
