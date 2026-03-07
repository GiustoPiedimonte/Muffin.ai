import Anthropic from "@anthropic-ai/sdk";
import { saveFact, deleteFact, type FactCategory } from "./memory_semantic.js";
import { saveLearned, getPendingConfirmation, confirmLearned, rejectLearned } from "./memory_learned.js";
import { detectConflict } from "./memory_conflicts.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LearningResult {
    savedFacts: string[];
    pendingConfirmations: { id: string; text: string }[];
    conflicts: { oldFact: string; newFact: string }[];
    updatedFacts: { oldFact: string; newFact: string }[];
}

// ---------------------------------------------------------------------------
// Extraction prompt — MOLTO selettivo
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `Sei un analizzatore di conversazioni. Analizza lo scambio tra Giusto e Muffin.

ESTRAI SOLO fatti che vale DAVVERO la pena ricordare a lungo termine.

SALVA SUBITO (senza chiedere) — cose concrete e permanenti:
- Milestone raggiunte ("ho finito il deploy", "ho chiuso il progetto X")
- Opinioni forti e chiare ("odio Vue", "preferisco lavorare da solo")  
- Avvenimenti importanti ("mi sono trasferito", "ho lasciato il lavoro")

CHIEDI CONFERMA — cambiamenti che influenzano come lavorate insieme:
- Cambi di priorità ("da ora mi concentro solo su X")
- Cambi nello stack ("passo da Vue a React")
- Nuovi vincoli o limitazioni ("non posso più lavorare il weekend")

NON ESTRARRE MAI:
- Domande o richieste one-shot ("cerca X", "come faccio Y?")
- Dettagli tecnici temporanei ("sto debuggando questo errore")
- Saluti, ringraziamenti, commenti casuali
- Cose che Giusto ha GIÀ detto in passato (non duplicare)
- Task in corso ("sto lavorando a X") — troppo transitorio
- Informazioni su Muffin (estrai solo cose su Giusto)

Se non c'è NIENTE di permanente/importante: rispondi SOLO con NIENTE

Formato (UNO PER RIGA):
TIPO|AZIONE|fatto breve e chiaro

TIPO: identity, projects, tech_stack, interests, priorities, preferences
AZIONE: salva oppure conferma`;

// ---------------------------------------------------------------------------
// Confirmation handling prompt
// ---------------------------------------------------------------------------

const CONFIRMATION_PROMPT = `Analizza il messaggio di Giusto. C'è un fatto in attesa di conferma:
FATTO: "{FACT}"

Giusto ha confermato, rifiutato, o sta parlando d'altro?
Rispondi SOLO con una di queste parole:
- CONFERMATO (se ha detto sì, ok, certo, va bene, esatto, o simili)
- RIFIUTATO (se ha detto no, non salvare, lascia stare, o simili)
- ALTRO (se sta parlando d'altro e non sta rispondendo alla conferma)`;

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Checks if the user's message is a response to a pending confirmation.
 * Uses Claude to understand natural language confirmations.
 * Returns true if a confirmation was handled (so we can skip learning extraction).
 */
export async function handlePendingConfirmation(
    chatId: string,
    userMessage: string
): Promise<{ handled: boolean; confirmed?: boolean; factText?: string }> {
    const pending = await getPendingConfirmation(chatId);
    if (!pending || !pending.id) {
        return { handled: false };
    }

    try {
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const prompt = CONFIRMATION_PROMPT.replace("{FACT}", pending.learnedFact);

        const response = await client.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 16,
            messages: [{ role: "user", content: `${prompt}\n\nGiusto: ${userMessage}` }],
        });

        const output = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim()
            .toUpperCase();

        if (output.includes("CONFERMATO")) {
            await confirmLearned(pending.id);
            // Also save as a semantic fact now that it's confirmed
            await saveFact(chatId, {
                key: pending.learnedFact,
                value: pending.learnedFact,
                category: "preferences",
                importance: "high",
                source: "learned",
            });
            return { handled: true, confirmed: true, factText: pending.learnedFact };
        } else if (output.includes("RIFIUTATO")) {
            await rejectLearned(pending.id);
            return { handled: true, confirmed: false, factText: pending.learnedFact };
        }

        // ALTRO — user is talking about something else, don't intercept
        return { handled: false };
    } catch (err) {
        console.error("handlePendingConfirmation failed:", err);
        return { handled: false };
    }
}

/**
 * Analyzes a user-assistant exchange and extracts learnable facts.
 * Much more selective than before — only truly permanent facts.
 */
export async function processLearnings(
    chatId: string,
    userMessage: string,
    claudeResponse: string
): Promise<LearningResult> {
    const result: LearningResult = {
        savedFacts: [],
        pendingConfirmations: [],
        conflicts: [],
        updatedFacts: [],
    };

    // Skip very short messages (e.g., "ok", "sì", "no") but allow short facts
    if (userMessage.trim().length < 5) {
        return result;
    }

    try {
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await client.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 256,
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

        // Hard limit: max 2 facts per message (avoid Haiku going overboard)
        const validLines = lines.slice(0, 2);

        for (const line of validLines) {
            const parts = line.split("|").map((p) => p.trim());
            if (parts.length < 3) continue;

            const [category, action, factText] = parts;
            if (!factText || factText.length < 5) continue;

            const cat = category.toLowerCase() as FactCategory;
            const validCategories = [
                "identity", "projects", "tech_stack",
                "interests", "priorities", "preferences",
            ];
            if (!validCategories.includes(cat)) continue;

            if (action.toLowerCase() === "salva") {
                // Check for conflicts before saving
                const conflict = await detectConflict(chatId, factText);

                if (conflict.type === "duplicate") {
                    // Silently skip duplicates
                    continue;
                }

                if (conflict.type === "update") {
                    // Auto-replace old fact
                    await deleteFact(conflict.oldFactId);
                    await saveFact(chatId, {
                        key: factText,
                        value: factText,
                        category: cat,
                        importance: "medium",
                        source: "learned",
                    });
                    result.updatedFacts.push({
                        oldFact: conflict.oldFact,
                        newFact: factText,
                    });
                    continue;
                }

                if (conflict.type === "conflict") {
                    // Don't save yet — ask user via confirmation
                    const factId = await saveLearned(chatId, {
                        learnedFact: factText,
                        sourceMessage: userMessage,
                        confidence: "low",
                        needsConfirmation: true,
                    });
                    result.conflicts.push({
                        oldFact: conflict.oldFact,
                        newFact: factText,
                    });
                    result.pendingConfirmations.push({
                        id: factId,
                        text: factText,
                    });
                    continue;
                }

                // type === "new" — save normally
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
        console.error("processLearnings failed:", err);
    }

    return result;
}

/**
 * Formats learning results into a natural-language Telegram footer.
 * Muffin communicates naturally, not with sì/no buttons.
 */
export function formatLearningResponse(result: LearningResult): string {
    const parts: string[] = [];

    if (result.savedFacts.length > 0) {
        const items = result.savedFacts.map((f) => `_${f}_`).join(", ");
        parts.push(`💾 Ho salvato in memoria: ${items}`);
    }

    if (result.updatedFacts.length > 0) {
        for (const u of result.updatedFacts) {
            parts.push(`🔄 Ho aggiornato: _${u.oldFact}_ → _${u.newFact}_`);
        }
    }

    if (result.conflicts.length > 0) {
        for (const c of result.conflicts) {
            parts.push(`⚠️ Conflitto rilevato:\nPrima sapevo: _${c.oldFact}_\nOra dici: _${c.newFact}_\nSostituisco? Dimmelo in qualsiasi modo.`);
        }
    } else if (result.pendingConfirmations.length > 0) {
        for (const c of result.pendingConfirmations) {
            parts.push(`📝 Salvo in memoria che "${c.text}"? Dimmelo in qualsiasi modo.`);
        }
    }

    return parts.join("\n");
}
