import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getHistory, saveMessages, type Message } from "./memory/memory_messages.js";
import { checkExplicitMemory, saveExplicitFact } from "./memory/memory_semantic.js";
import { getRelevantContext } from "./memory/memory_retrieval.js";
import { getCachedRelevantContext } from "./memory/memory_cache.js";
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
    chatId: string
): Promise<{ text: string; inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; model: string }> {
    const client = getClaude();
    const basePrompt = loadSystemPrompt();
    
    // Use cached context instead of direct call
    const memoryContext = await getCachedRelevantContext(
        chatId,
        userMessage,
        getRelevantContext
    );
    
    const system = basePrompt + memoryContext;

    const routerDecision = selectModel(userMessage, history, system.length);
    const MODEL = routerDecision.model;

    const messages: Anthropic.MessageParam[] = [
        ...history.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
        })),
        { role: "user", content: userMessage },
    ];

    await logAction(chatId, "claude_call", {
        model: MODEL,
        historyLength: history.length,
        routerReason: routerDecision.reason,
        estTokens: routerDecision.estimatedPromptTokens
    });

    let response = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: [
            {
                type: "text",
                text: system,
                cache_control: { type: "ephemeral" }
            }
        ],
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

        response = await client.messages.create({
            model: MODEL,
            max_tokens: 4096,
            system: [
                {
                    type: "text",
                    text: system,
                    cache_control: { type: "ephemeral" }
                }
            ],
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
    isDocument: boolean;
}

/**
 * Handle a generic user text message, orchestrating memory, rate-limiting, Claude, and tools.
 */
export async function processMessage(chatId: string, userText: string): Promise<ProcessResult> {
    await logAction(chatId, "message_received", { length: userText.length });

    // 1. Check for explicit memory pattern
    const explicitFact = checkExplicitMemory(userText);
    if (explicitFact) {
        await saveExplicitFact(chatId, explicitFact);
        await logAction(chatId, "explicit_memory_saved", { fact: explicitFact });
        return { reply: "Salvato ✓", isDocument: false };
    }

    // 2. Check for pending memory confirmation (natural language)
    const confirmation = await handlePendingConfirmation(chatId, userText);
    if (confirmation.handled) {
        await logAction(chatId, "memory_confirmed", {
            factText: confirmation.factText,
            confirmed: confirmation.confirmed,
        });
        if (confirmation.confirmed) {
            return { reply: `✓ Salvato in memoria: _${confirmation.factText}_`, isDocument: false };
        } else {
            return { reply: "Ok, non lo salvo ✓", isDocument: false };
        }
    }

    // 3. Load history & generate response via Claude
    const history = await getHistory(chatId);
    const { text: reply, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, model } = await enqueue(() => callClaude(history, userText, chatId));

    const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
    const modelInitial = model.includes("haiku") ? "H" : model.includes("sonnet") ? "S" : "?";
    const fmtK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
    const cacheStr = cacheReadTokens > 0 || cacheCreationTokens > 0
        ? ` | C:${fmtK(cacheReadTokens)}`
        : "";
    const tokenFooter = `\n\n> \`[ ${modelInitial} | T:${fmtK(totalTokens)} | I:${fmtK(inputTokens)} | O:${fmtK(outputTokens)}${cacheStr} ]\``;

    // 4. Save to Conversational Memory
    await saveMessages(chatId, [
        { role: "user", content: userText },
        { role: "assistant", content: reply },
    ]);

    // 5. Save Episodic Memory (async, non-blocking)
    saveEpisode(chatId, userText, reply).catch((err) =>
        console.error("Episodic save failed:", err)
    );

    // 6. Process Learnings (async, non-blocking)
    let learningFooter = "";
    try {
        const learnings = await processLearnings(chatId, userText, reply);
        learningFooter = formatLearningResponse(learnings);

        if (learnings.savedFacts.length > 0) {
            await logAction(chatId, "memory_saved", { facts: learnings.savedFacts });
        }
        if (learnings.pendingConfirmations.length > 0) {
            await logAction(chatId, "memory_confirmation_sent", {
                confirmations: learnings.pendingConfirmations.map((c) => c.text),
            });
        }
    } catch (err) {
        console.error("Learning processing failed:", err);
    }

    // 7. Format Final Output
    // If handledSilently was true we would have returned early. Since we didn't, we might need parsing.
    // However, the confirmation reply uses Markdown in telegram (`_${confirmation.factText}_`).
    // Ensure all these logic branches translate well. The caller should use parse_mode: Markdown.

    const fullReply = reply + tokenFooter + (learningFooter ? `\n\n${learningFooter}` : "");
    const isDocument = fullReply.length > MAX_TELEGRAM_LENGTH;

    await logAction(chatId, "response_sent", {
        length: reply.length,
        type: isDocument ? "file" : "text",
        inputTokens,
        outputTokens,
        totalTokens,
    });

    return {
        reply: fullReply,
        isDocument,
    };
}
