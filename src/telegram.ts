import { Telegraf, Input } from "telegraf";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getHistory, saveMessages, type Message } from "./memory.js";
import { searchToolDefinition, executeSearch } from "./tools/search.js";
import {
    checkExplicitMemory,
    saveExplicitFact,
    runBatch,
    buildMemoryContext,
} from "./memory_facts.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TELEGRAM_LENGTH = 4000;

let systemPrompt: string;

function loadSystemPrompt(): string {
    if (!systemPrompt) {
        const agentPath = resolve(process.cwd(), "context", "AGENT.md");
        const userPath = resolve(process.cwd(), "context", "USER.md");

        const agentMd = readFileSync(agentPath, "utf-8");
        const userMd = readFileSync(userPath, "utf-8");

        systemPrompt = `${agentMd}\n\n---\n\n${userMd}`;
    }
    return systemPrompt;
}

// ---------------------------------------------------------------------------
// Claude client
// ---------------------------------------------------------------------------

let claude: Anthropic;

function getClaude(): Anthropic {
    if (!claude) {
        claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return claude;
}

// ---------------------------------------------------------------------------
// Tool handling loop
// ---------------------------------------------------------------------------

async function callClaude(
    history: Message[],
    userMessage: string,
    chatId: string
): Promise<string> {
    const client = getClaude();
    const basePrompt = loadSystemPrompt();
    const memoryContext = await buildMemoryContext(chatId);
    const system = basePrompt + memoryContext;

    const messages: Anthropic.MessageParam[] = [
        ...history.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
        })),
        { role: "user", content: userMessage },
    ];

    let response = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system,
        tools: [searchToolDefinition],
        messages,
    });

    // Tool-use loop: keep calling tools until we get a final text response
    while (response.stop_reason === "tool_use") {
        const assistantContent = response.content;
        messages.push({ role: "assistant", content: assistantContent });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const block of assistantContent) {
            if (block.type === "tool_use") {
                let result: string;

                if (block.name === "web_search") {
                    result = await executeSearch(
                        block.input as { query: string }
                    );
                } else {
                    result = `Unknown tool: ${block.name}`;
                }

                toolResults.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: result,
                });
            }
        }

        messages.push({ role: "user", content: toolResults });

        response = await client.messages.create({
            model: MODEL,
            max_tokens: 4096,
            system,
            tools: [searchToolDefinition],
            messages,
        });
    }

    // Extract final text
    const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text"
    );
    return textBlocks.map((b) => b.text).join("\n");
}

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

            let recap = `Batch completato.\nNuovi fatti salvati: ${result.newFacts.length}`;
            if (result.newFacts.length > 0) {
                recap += "\n" + result.newFacts.map((f) => `- ${f}`).join("\n");
            }
            recap += `\nDuplicati ignorati: ${result.duplicatesIgnored}`;

            await ctx.reply(recap);
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error("Batch error:", errMsg);
            await ctx.reply(`⚠️ Errore batch: ${errMsg.substring(0, 500)}`);
        }
    });

    bot.on("text", async (ctx) => {
        const userText = ctx.message.text;
        const chatIdStr = String(ctx.chat.id);

        try {
            // Check for explicit memory pattern
            const explicitFact = checkExplicitMemory(userText);
            if (explicitFact) {
                await saveExplicitFact(chatIdStr, explicitFact);
                await ctx.reply("Salvato ✓");
                return;
            }

            // Show "typing" indicator
            await ctx.sendChatAction("typing");

            // Load history
            const history = await getHistory(chatIdStr);

            // Call Claude
            const reply = await callClaude(history, userText, chatIdStr);

            // Save user + assistant messages
            await saveMessages(chatIdStr, [
                { role: "user", content: userText },
                { role: "assistant", content: reply },
            ]);

            // Send response
            if (reply.length > MAX_TELEGRAM_LENGTH) {
                // Send as .md file
                const buffer = Buffer.from(reply, "utf-8");
                await ctx.replyWithDocument(Input.fromBuffer(buffer, "response.md"), {
                    caption: reply.substring(0, 200) + "…",
                });
            } else {
                await ctx.reply(reply, { parse_mode: "Markdown" });
            }
        } catch (error) {
            const errMsg =
                error instanceof Error ? error.message : String(error);
            console.error("Error processing message:", errMsg);

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
