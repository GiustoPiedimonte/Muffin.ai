import type Anthropic from "@anthropic-ai/sdk";
import { searchToolDefinition, executeSearch } from "./search.js";
import { readGitToolDefinition, executeReadGit } from "./readGit.js";
import {
    readFileToolDefinition,
    executeReadFile,
    writeFileToolDefinition,
    executeWriteFile,
    listDirectoryToolDefinition,
    executeListDirectory,
    searchFilesToolDefinition,
    executeSearchFiles,
} from "./filesystem.js";
import {
    gitStatusToolDefinition,
    executeGitStatus,
    gitLogToolDefinition,
    executeGitLog,
    gitDiffToolDefinition,
    executeGitDiff,
    gitAddToolDefinition,
    executeGitAdd,
    gitCommitToolDefinition,
    executeGitCommit,
    gitBranchToolDefinition,
    executeGitBranch,
    gitPushToolDefinition,
    executeGitPush,
} from "./git.js";

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

    // --- Filesystem tools ---
    read_file: {
        definition: readFileToolDefinition,
        execute: async (input) => executeReadFile(input as { path: string }),
        category: "read_only",
    },
    write_file: {
        definition: writeFileToolDefinition,
        execute: async (input) => executeWriteFile(input as { path: string; content: string }),
        category: "contextual",
    },
    list_directory: {
        definition: listDirectoryToolDefinition,
        execute: async (input) => executeListDirectory(input as { path?: string }),
        category: "read_only",
    },
    search_files: {
        definition: searchFilesToolDefinition,
        execute: async (input) => executeSearchFiles(input as { pattern: string; path?: string }),
        category: "read_only",
    },

    // --- Git tools ---
    git_status: {
        definition: gitStatusToolDefinition,
        execute: async () => executeGitStatus(),
        category: "read_only",
    },
    git_log: {
        definition: gitLogToolDefinition,
        execute: async (input) => executeGitLog(input as { count?: number }),
        category: "read_only",
    },
    git_diff: {
        definition: gitDiffToolDefinition,
        execute: async (input) => executeGitDiff(input as { staged?: boolean; path?: string }),
        category: "read_only",
    },
    git_add: {
        definition: gitAddToolDefinition,
        execute: async (input) => executeGitAdd(input as { pathspec: string }),
        category: "contextual",
    },
    git_commit: {
        definition: gitCommitToolDefinition,
        execute: async (input) => executeGitCommit(input as { message: string }),
        category: "always_ask",
    },
    git_branch: {
        definition: gitBranchToolDefinition,
        execute: async (input) => executeGitBranch(input as { action: "list" | "create" | "checkout" | "delete"; branch_name?: string }),
        category: "contextual",
    },
    git_push: {
        definition: gitPushToolDefinition,
        execute: async (input) => executeGitPush(input as { remote?: string; branch?: string; force?: boolean }),
        category: "always_ask",
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

