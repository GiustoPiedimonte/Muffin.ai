import { loadFacts } from "./memory_semantic.js";
import { getLearnedFacts } from "./memory_learned.js";
import { getRecentEpisodes } from "./memory_episodic.js";
import { getMemorySummary } from "./memory_compression.js";

// ---------------------------------------------------------------------------
// Debug report
// ---------------------------------------------------------------------------

/**
 * Builds a full Markdown debug report of all memory layers.
 */
export async function buildMemoryDebugReport(chatId: string): Promise<string> {
    const [semanticFacts, learnedFacts, episodes, summary] = await Promise.all([
        loadFacts(chatId),
        getLearnedFacts(chatId),
        getRecentEpisodes(chatId, 20),
        getMemorySummary(chatId),
    ]);

    const parts: string[] = [];
    parts.push(`# 🧠 Memory Debug Report`);
    parts.push(`> Chat ID: \`${chatId}\``);
    parts.push(`> Generated: ${new Date().toISOString()}\n`);

    // --- Semantic Facts ---
    parts.push(`## Semantic Facts (${semanticFacts.length})`);
    if (semanticFacts.length === 0) {
        parts.push("_Nessun fatto semantico._\n");
    } else {
        const grouped = new Map<string, typeof semanticFacts>();
        for (const f of semanticFacts) {
            const cat = f.category;
            if (!grouped.has(cat)) grouped.set(cat, []);
            grouped.get(cat)!.push(f);
        }

        for (const [cat, facts] of grouped) {
            parts.push(`### ${cat} (${facts.length})`);
            for (const f of facts) {
                const src = f.source === "explicit" ? "📌" : f.source === "learned" ? "🎓" : "🔍";
                const imp = f.importance === "high" ? "🔴" : f.importance === "medium" ? "🟡" : "⚪";
                parts.push(`- ${src}${imp} **${f.key}** — _${f.source}_ (${f.lastUpdated.toISOString().slice(0, 10)})`);
            }
            parts.push("");
        }
    }

    // --- Learned Facts ---
    parts.push(`## Learned Facts (${learnedFacts.length})`);
    if (learnedFacts.length === 0) {
        parts.push("_Nessun fatto appreso._\n");
    } else {
        for (const f of learnedFacts) {
            const status = f.needsConfirmation
                ? "⏳ pending"
                : f.confirmedAt
                    ? `✅ confirmed ${f.confirmedAt.toISOString().slice(0, 10)}`
                    : "💾 saved";
            parts.push(`- [${f.confidence}] ${f.learnedFact} — ${status}`);
            parts.push(`  _source: "${f.sourceMessage.substring(0, 80)}${f.sourceMessage.length > 80 ? "…" : ""}"_`);
        }
        parts.push("");
    }

    // --- Episodic Memory ---
    parts.push(`## Recent Episodes (${episodes.length})`);
    if (episodes.length === 0) {
        parts.push("_Nessun episodio._\n");
    } else {
        for (const e of episodes) {
            const who = e.direction === "user" ? "👤" : "🧁";
            const date = e.timestamp.toISOString().slice(0, 16).replace("T", " ");
            const topics = e.topics.length > 0 ? ` [${e.topics.join(", ")}]` : "";
            parts.push(`- ${who} ${date}${topics}: ${e.contentParaphrased}`);
        }
        parts.push("");
    }

    // --- Compressed Summary ---
    parts.push(`## Compressed Summary`);
    if (!summary) {
        parts.push("_Nessun riassunto compresso._\n");
    } else {
        parts.push(summary);
        parts.push("");
    }

    return parts.join("\n");
}
