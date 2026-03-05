import type Anthropic from "@anthropic-ai/sdk";
import { searchToolDefinition, executeSearch } from "./search.js";
import { readGitToolDefinition, executeReadGit } from "./readGit.js";

// Helper type for tool actions classification
export type ToolCategory = "read_only" | "always_ask" | "contextual";

export interface ToolRegistryEntry {
    definition: Anthropic.Tool;
    execute: (input: any) => Promise<string>;
    category: ToolCategory;
}

// ---------------------------------------------------------------------------
// Tool Registry
// ---------------------------------------------------------------------------

export const toolsRegistry: Record<string, ToolRegistryEntry> = {
    web_search: {
        definition: searchToolDefinition,
        execute: async (input) => executeSearch(input as { query: string }),
        category: "read_only",
    },
    read_github_file: {
        definition: readGitToolDefinition,
        execute: async (input) => executeReadGit(input as { owner: string; repo: string; path: string; branch?: string }),
        category: "read_only",
    },
};

// ---------------------------------------------------------------------------
// Exports for Claude API
// ---------------------------------------------------------------------------

/**
 * Array of all tool definitions to pass to Claude API.
 */
export const allToolDefinitions: Anthropic.Tool[] = Object.values(toolsRegistry).map(
    (t) => t.definition
);

/**
 * Main tool executor dispatcher.
 */
export async function executeTool(name: string, input: any): Promise<string> {
    const tool = toolsRegistry[name];
    if (!tool) {
        return `Unknown tool: ${name}`;
    }

    try {
        return await tool.execute(input);
    } catch (error) {
        return `Error executing tool ${name}: ${error instanceof Error ? error.message : String(error)}`;
    }
}
