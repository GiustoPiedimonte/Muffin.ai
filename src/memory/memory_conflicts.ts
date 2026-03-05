import Anthropic from "@anthropic-ai/sdk";
import { loadFacts, type SemanticFact } from "./memory_semantic.js";
import { getEmbedding, cosineSimilarity } from "./memory_embeddings.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConflictResult =
    | { type: "new" }
    | { type: "duplicate" }
    | { type: "update"; oldFactId: string; oldFact: string }
    | { type: "conflict"; oldFactId: string; oldFact: string };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DUPLICATE_THRESHOLD = 0.85;
const CANDIDATE_THRESHOLD = 0.55;

const CONFLICT_PROMPT = `Hai due fatti su Giusto. Dimmi la relazione:

VECCHIO: "{OLD}"
NUOVO: "{NEW}"

Rispondi SOLO con una di queste parole:
- AGGIORNAMENTO — il nuovo fatto aggiorna/sostituisce il vecchio (es. "usa React" → "usa Vue")
- CONFLITTO — i due fatti si contraddicono e non è chiaro quale sia giusto
- DIVERSO — sono informazioni diverse, non in conflitto

Rispondi con una sola parola.`;

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Checks if a new fact conflicts with, duplicates, or updates existing facts.
 */
export async function detectConflict(
    chatId: string,
    newFactText: string
): Promise<ConflictResult> {
    const facts = await loadFacts(chatId);
    if (facts.length === 0) return { type: "new" };

    // 1. Compute embedding for the new fact
    let newVec: number[];
    try {
        newVec = await getEmbedding(newFactText);
    } catch {
        // If embeddings fail, treat as new (safe default)
        return { type: "new" };
    }

    // 2. Find candidates by similarity
    const candidates: { fact: SemanticFact; score: number }[] = [];

    for (const f of facts) {
        const fVec = f.embedding ?? null;
        if (!fVec) continue;

        const score = cosineSimilarity(newVec, fVec);

        if (score > DUPLICATE_THRESHOLD) {
            return { type: "duplicate" };
        }

        if (score > CANDIDATE_THRESHOLD) {
            candidates.push({ fact: f, score });
        }
    }

    if (candidates.length === 0) return { type: "new" };

    // 3. Take the highest similarity candidate and ask Claude
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    if (!best.fact.id) return { type: "new" };

    try {
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const prompt = CONFLICT_PROMPT
            .replace("{OLD}", best.fact.value)
            .replace("{NEW}", newFactText);

        const response = await client.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 16,
            messages: [{ role: "user", content: prompt }],
        });

        const output = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim()
            .toUpperCase();

        if (output.includes("AGGIORNAMENTO")) {
            return {
                type: "update",
                oldFactId: best.fact.id,
                oldFact: best.fact.value,
            };
        }

        if (output.includes("CONFLITTO")) {
            return {
                type: "conflict",
                oldFactId: best.fact.id,
                oldFact: best.fact.value,
            };
        }

        // DIVERSO or unrecognized → treat as new
        return { type: "new" };
    } catch (err) {
        console.error("Conflict detection Claude call failed:", err);
        return { type: "new" };
    }
}
