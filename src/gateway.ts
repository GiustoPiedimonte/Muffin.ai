import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getHistory, saveMessages, type Message } from "./memory/memory_messages.js";
import { checkExplicitMemory, saveExplicitFact } from "./memory/memory_semantic.js";
import { getRelevantContext } from "./memory/memory_retrieval.js";
import { processLearnings, formatLearningResponse, handlePendingConfirmation } from "./memory/memory_learning.js";
import { saveEpisode } from "./memory/memory_episodic.js";
import { logAction } from "./logger.js";
import { enqueue } from "./queue.js";
import { allToolDefinitions, executeTool } from "./tools/index.js";
import { selectModel } from "./router.js";

// ---------------------------------------------------------------------------
// Config & State
// ---------------------------------------------------------------------------

const MAX_TELEGRAM_LENGTH = 4000;

let systemPrompt: string;
let claude: Anthropic;

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

function getClaude(): Anthropic {
    if (!claude) {
        claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return claude;
}

// ---------------------------------------------------------------------------
// Claude API Wrapper
// ---------------------------------------------------------------------------

async function callClaude(
    history: Message[],
    userMessage: string,
    chatId: string,
    onStatusUpdate?: (text: string) => Promise<void>
): Promise<{ text: string; inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; model: string }> {
    const client = getClaude();
    const basePrompt = loadSystemPrompt();

    if (onStatusUpdate) onStatusUpdate("⏳ Sto analizzando il contesto...");

    // Generate dynamically to ensure Semantic Vector Search is userMessage-aware
    const { staticCtx, dynamicCtx } = await getRelevantContext(
        chatId,
        userMessage
    );

    const systemLength = basePrompt.length + staticCtx.length + dynamicCtx.length;

    const routerDecision = selectModel(userMessage, history, systemLength);
    const MODEL = routerDecision.model;

    const messages: Anthropic.MessageParam[] = history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
    }));

    // Add cache breakpoint at the most recent history turn (before the new user message)
    if (messages.length > 0) {
        const lastIdx = messages.length - 1;
        messages[lastIdx] = {
            ...messages[lastIdx],
            content: [
                {
                    type: "text",
                    text: messages[lastIdx].content as string,
                    cache_control: { type: "ephemeral" },
                },
            ],
        };
    }

    messages.push({ role: "user", content: userMessage });

    const systemBlocks: Anthropic.TextBlockParam[] = [
        {
            type: "text",
            text: basePrompt + "\n" + staticCtx,
            cache_control: { type: "ephemeral" }
        }
    ];

    if (dynamicCtx) {
        systemBlocks.push({
            type: "text",
            text: dynamicCtx
        });
    }

    await logAction(chatId, "claude_call", {
        model: MODEL,
        historyLength: history.length,
        routerReason: routerDecision.reason,
        estTokens: routerDecision.estimatedPromptTokens
    });

    if (onStatusUpdate) onStatusUpdate("⏳ Sto elaborando...");

    let response = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: systemBlocks,
        tools: allToolDefinitions,
        messages,
    });

    let totalInput = response.usage.input_tokens;
    let totalOutput = response.usage.output_tokens;
    let cacheCreationTokens = response.usage.cache_creation_input_tokens || 0;
    let cacheReadTokens = response.usage.cache_read_input_tokens || 0;

    // Tool-use loop
    while (response.stop_reason === "tool_use") {
        const assistantContent = response.content;
        messages.push({ role: "assistant", content: assistantContent });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const block of assistantContent) {
            if (block.type === "tool_use") {
                if (onStatusUpdate) onStatusUpdate(`⏳ Sto usando lo strumento: <code>${block.name}</code>...`);
                await logAction(chatId, "tool_use", { tool: block.name, input: block.input });

                const result = await executeTool(block.name, block.input);

                toolResults.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: result,
                });
            }
        }

        messages.push({ role: "user", content: toolResults });

        if (onStatusUpdate) onStatusUpdate("⏳ Sto elaborando i risultati...");

        response = await client.messages.create({
            model: MODEL,
            max_tokens: 4096,
            system: systemBlocks,
            tools: allToolDefinitions,
            messages,
        });

        totalInput += response.usage.input_tokens;
        totalOutput += response.usage.output_tokens;
        cacheCreationTokens += response.usage.cache_creation_input_tokens || 0;
        cacheReadTokens += response.usage.cache_read_input_tokens || 0;
    }

    const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text"
    );
    const text = textBlocks.map((b) => b.text).join("\n");
    return { text, inputTokens: totalInput, outputTokens: totalOutput, cacheCreationTokens, cacheReadTokens, model: MODEL };
}

// ---------------------------------------------------------------------------
// Main Entry Point for User Messages
// ---------------------------------------------------------------------------

export interface ProcessResult {
    reply: string;
}

/**
 * Handle a generic user text message, orchestrating memory, rate-limiting, Claude, and tools.
 */
export async function processMessage(chatId: string, userText: string, onStatusUpdate?: (text: string) => Promise<void>, onFollowUp?: (text: string) => Promise<void>): Promise<ProcessResult> {
    const startMs = Date.now();
    await logAction(chatId, "message_received", { length: userText.length });

    // 1. Check for explicit memory pattern
    const explicitFact = checkExplicitMemory(userText);
    if (explicitFact) {
        await saveExplicitFact(chatId, explicitFact);
        await logAction(chatId, "explicit_memory_saved", { fact: explicitFact });
        return { reply: "Salvato ✓" };
    }

    // 2. Check for pending memory confirmation (natural language)
    const confirmation = await handlePendingConfirmation(chatId, userText);
    if (confirmation.handled) {
        await logAction(chatId, "memory_confirmed", {
            factText: confirmation.factText,
            confirmed: confirmation.confirmed,
        });
        if (confirmation.confirmed) {
            return { reply: `✓ Salvato in memoria: _${confirmation.factText}_` };
        } else {
            return { reply: "Ok, non lo salvo ✓" };
        }
    }

    // 3. Load history & generate response via Claude
    const history = await getHistory(chatId);
    const { text: reply, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, model } = await enqueue(() => callClaude(history, userText, chatId, onStatusUpdate));

    const elapsedMs = Date.now() - startMs;
    const elapsedSec = (elapsedMs / 1000).toFixed(1);

    const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
    const modelInitial = model.includes("haiku") ? "Haiku" : model.includes("sonnet") ? "Sonnet" : "Claude";

    // Formatting numbers with 'k' representation
    const fmtK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);

    // Hardcore Debug Footer - Iconographic but verbose
    // [ 🤖 Haiku • ⏱️ 2.4s • 🪙 1.2k ]
    // [ 📥 IN: 1.1k • 📤 OUT: 50 | ♻️ CR: 1.0k • 📦 CW: 0 ]
    const topRow = `[ 🤖 ${modelInitial}  ⏱️ ${elapsedSec}s  🪙 ${fmtK(totalTokens)} ]`;
    const bottomRow = `[ 📥 ${fmtK(inputTokens)}  📤 ${fmtK(outputTokens)}  |  ♻️ CR: ${fmtK(cacheReadTokens)}  📦 CW: ${fmtK(cacheCreationTokens)} ]`;
    const tokenFooter = `\n\n> \`${topRow}\`\n> \`${bottomRow}\``;

    // 4. Save to Conversational Memory
    await saveMessages(chatId, [
        { role: "user", content: userText },
        { role: "assistant", content: reply },
    ]);

    // 5. Save Episodic Memory (async, non-blocking)
    saveEpisode(chatId, userText, reply).catch((err) =>
        console.error("Episodic save failed:", err)
    );

    // 6. Process Learnings (fire-and-forget, non-blocking)
    processLearnings(chatId, userText, reply).then(async (learnings) => {
        const followUpText = formatLearningResponse(learnings);

        if (learnings.savedFacts.length > 0) {
            await logAction(chatId, 'memory_saved', { facts: learnings.savedFacts });
        }
        if (learnings.pendingConfirmations.length > 0) {
            await logAction(chatId, 'memory_confirmation_sent', {
                confirmations: learnings.pendingConfirmations.map((c) => c.text),
            });
        }
        if (followUpText && onFollowUp) {
            await onFollowUp(followUpText);
        }
    }).catch(err => {
        console.error('Learning processing failed:', err);
    });

    // 7. Format Final Output
    const fullReply = reply + tokenFooter;

    await logAction(chatId, "response_sent", {
        length: reply.length,
        type: "text_chunked",
        inputTokens,
        outputTokens,
        totalTokens,
    });

    return {
        reply: fullReply
    };
}
