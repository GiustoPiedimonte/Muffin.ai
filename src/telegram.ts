import { Telegraf, Input } from "telegraf";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getHistory, saveMessages, type Message } from "./memory.js";
import { searchToolDefinition, executeSearch } from "./tools/search.js";
import { readGitToolDefinition, executeReadGit } from "./tools/readGit.js";
import {
    checkExplicitMemory,
    saveExplicitFact,
    runBatch,
    buildMemoryContext,
} from "./memory_facts.js";
import { logAction } from "./logger.js";
import { enqueue } from "./queue.js";

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
        const projectsPath = resolve(process.cwd(), "context", "PROJECTS.md");

        const agentMd = readFileSync(agentPath, "utf-8");
        const userMd = readFileSync(userPath, "utf-8");
        const projectsMd = readFileSync(projectsPath, "utf-8");

        systemPrompt = `${agentMd}\n\n---\n\n${userMd}\n\n---\n\n${projectsMd}`;
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
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
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

    await logAction(chatId, "claude_call", { model: MODEL, historyLength: history.length });

    let response = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system,
        tools: [searchToolDefinition, readGitToolDefinition],
        messages,
    });

    // Accumulate token usage across all API calls
    let totalInput = response.usage.input_tokens;
    let totalOutput = response.usage.output_tokens;

    // Tool-use loop: keep calling tools until we get a final text response
    while (response.stop_reason === "tool_use") {
        const assistantContent = response.content;
        messages.push({ role: "assistant", content: assistantContent });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const block of assistantContent) {
            if (block.type === "tool_use") {
                await logAction(chatId, "tool_use", { tool: block.name, input: block.input });

                let result: string;

                if (block.name === "web_search") {
                    result = await executeSearch(
                        block.input as { query: string }
                    );
                } else if (block.name === "read_github_file") {
                    result = await executeReadGit(
                        block.input as { owner: string; repo: string; path: string; branch?: string }
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

        totalInput += response.usage.input_tokens;
        totalOutput += response.usage.output_tokens;
    }

    // Extract final text
    const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text"
    );
    const text = textBlocks.map((b) => b.text).join("\n");
    return { text, inputTokens: totalInput, outputTokens: totalOutput };
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

    bot.on("text", async (ctx) => {
        const userText = ctx.message.text;
        const chatIdStr = String(ctx.chat.id);

        try {
            await logAction(chatIdStr, "message_received", {
                length: userText.length,
            });

            // Check for explicit memory pattern
            const explicitFact = checkExplicitMemory(userText);
            if (explicitFact) {
                await saveExplicitFact(chatIdStr, explicitFact);
                await logAction(chatIdStr, "explicit_memory_saved", { fact: explicitFact });
                await ctx.reply("Salvato ✓");
                return;
            }

            // Show "typing" indicator
            await ctx.sendChatAction("typing");

            // Load history
            const history = await getHistory(chatIdStr);

            // Call Claude (through rate-limited queue)
            const { text: reply, inputTokens, outputTokens } = await enqueue(() => callClaude(history, userText, chatIdStr));
            const totalTokens = inputTokens + outputTokens;
            const tokenFooter = `\n\n\`(${totalTokens}/${inputTokens}/${outputTokens})\``;

            // Save user + assistant messages
            await saveMessages(chatIdStr, [
                { role: "user", content: userText },
                { role: "assistant", content: reply },
            ]);

            // Send response
            const fullReply = reply + tokenFooter;
            const isFile = fullReply.length > MAX_TELEGRAM_LENGTH;
            if (isFile) {
                // Send as .md file
                const buffer = Buffer.from(fullReply, "utf-8");
                await ctx.replyWithDocument(Input.fromBuffer(buffer, "response.md"), {
                    caption: reply.substring(0, 200) + "…",
                });
            } else {
                await ctx.reply(fullReply, { parse_mode: "Markdown" });
            }

            await logAction(chatIdStr, "response_sent", {
                length: reply.length,
                type: isFile ? "file" : "text",
                inputTokens,
                outputTokens,
                totalTokens,
            });
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
