import { tavily } from "@tavily/core";
import type Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Tool definition for Claude
// ---------------------------------------------------------------------------

export const searchToolDefinition: Anthropic.Tool = {
    name: "web_search",
    description:
        "Search the web for current information. Use this when the user asks about recent events, facts you're unsure about, or anything that benefits from up-to-date web data.",
    input_schema: {
        type: "object" as const,
        properties: {
            query: {
                type: "string",
                description: "The search query to look up on the web.",
            },
        },
        required: ["query"],
    },
};

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

interface SearchInput {
    query: string;
}

export async function executeSearch(input: SearchInput): Promise<string> {
    const apiKey = process.env.SEARCH_API_KEY;
    if (!apiKey) {
        return "Error: SEARCH_API_KEY is not configured.";
    }

    try {
        const client = tavily({ apiKey });

        const response = await client.search(input.query, {
            maxResults: 5,
            searchDepth: "basic",
            includeAnswer: true,
        });

        let output = "";

        if (response.answer) {
            output += `**Summary:** ${response.answer}\n\n`;
        }

        output += "**Results:**\n\n";
        for (const result of response.results) {
            output += `- **${result.title}**\n`;
            output += `  ${result.url}\n`;
            output += `  ${result.content}\n\n`;
        }

        return output;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Search failed: ${message}`;
    }
}
