import Anthropic from "@anthropic-ai/sdk";
import { saveFact, type FactCategory } from "./memory_semantic.js";
import { saveLearned } from "./memory_learned.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LearningResult {
    savedFacts: string[];
    pendingConfirmations: { id: string; text: string }[];
}

// ---------------------------------------------------------------------------
// Extraction prompt
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `Analizza questo scambio di messaggi tra Giusto (utente) e Muffin (agente).
Estrai SOLO fatti nuovi, concreti e permanenti su Giusto. Ignora saluti, domande generali, task one-shot.

Per ogni fatto, classifica:
- TIPO: uno tra identity, projects, tech_stack, interests, priorities, preferences
- AZIONE: "salva" per fatti concreti (completamenti, opinioni, eventi) oppure "conferma" per cambi importanti (nuove priorità, cambi nello stack, decisioni significative)

Formato (UNO PER RIGA):
TIPO|AZIONE|fatto

Se non c'è niente di rilevante, rispondi SOLO: NIENTE`;

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Analyzes a user-assistant exchange and extracts learnable facts.
 * - Concrete facts are saved immediately
 * - Important changes are flagged for confirmation
 *
 * Returns the list of saved facts and pending confirmations.
 */
export async function processLearnings(
    chatId: string,
    userMessage: string,
    claudeResponse: string
): Promise<LearningResult> {
    const result: LearningResult = {
        savedFacts: [],
        pendingConfirmations: [],
    };

    try {
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await client.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 512,
            messages: [
                {
                    role: "user",
                    content: `${EXTRACTION_PROMPT}\n\n---\nGiusto: ${userMessage}\nMuffin: ${claudeResponse}`,
                },
            ],
        });

        const output = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();

        if (!output || output.toUpperCase() === "NIENTE") {
            return result;
        }

        // Parse lines: TIPO|AZIONE|fatto
        const lines = output.split("\n").filter((l) => l.includes("|"));

        for (const line of lines) {
            const parts = line.split("|").map((p) => p.trim());
            if (parts.length < 3) continue;

            const [category, action, factText] = parts;
            const cat = category.toLowerCase() as FactCategory;
            const validCategories = [
                "identity", "projects", "tech_stack",
                "interests", "priorities", "preferences",
            ];
            if (!validCategories.includes(cat)) continue;

            if (action.toLowerCase() === "salva") {
                // Save immediately — concrete fact
                await saveFact(chatId, {
                    key: factText,
                    value: factText,
                    category: cat,
                    importance: "medium",
                    source: "learned",
                });

                await saveLearned(chatId, {
                    learnedFact: factText,
                    sourceMessage: userMessage,
                    confidence: "medium",
                    needsConfirmation: false,
                });

                result.savedFacts.push(factText);
            } else if (action.toLowerCase() === "conferma") {
                // Needs confirmation — important change
                const factId = await saveLearned(chatId, {
                    learnedFact: factText,
                    sourceMessage: userMessage,
                    confidence: "low",
                    needsConfirmation: true,
                });

                result.pendingConfirmations.push({
                    id: factId,
                    text: factText,
                });
            }
        }
    } catch (err) {
        // Learning failures should never crash the bot
        console.error("processLearnings failed:", err);
    }

    return result;
}

/**
 * Formats learning results into a Telegram-friendly string.
 * Returns empty string if nothing was learned/flagged.
 */
export function formatLearningResponse(result: LearningResult): string {
    const parts: string[] = [];

    if (result.savedFacts.length > 0) {
        const items = result.savedFacts.map((f) => `  • ${f}`).join("\n");
        parts.push(`💾 Salvato in memoria:\n${items}`);
    }

    if (result.pendingConfirmations.length > 0) {
        const items = result.pendingConfirmations
            .map((c) => `  📝 "${c.text}"`)
            .join("\n");
        parts.push(`Salvo questo in memoria?\n${items}\n(rispondi sì/no)`);
    }

    return parts.join("\n\n");
}
