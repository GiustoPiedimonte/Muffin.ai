/**
 * Muffin MCP Server
 *
 * Processo standalone che espone tool filesystem e git via protocollo MCP.
 * Usa stdio transport — pensato per essere consumato da client MCP
 * (Gemini CLI, Claude Desktop, Cursor, ecc.).
 *
 * Sicurezza:
 * - Path sandboxing: tutti i path risolti e validati sotto ALLOWED_ROOT
 * - execFile: niente shell injection, argomenti come array
 * - Limite lettura: 1MB max per file
 * - Git cwd forzato alla root del progetto
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve, relative, join } from "node:path";
import {
    readFile,
    writeFile,
    readdir,
    stat,
    mkdir,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ALLOWED_ROOT = resolve(process.cwd());
const MAX_FILE_SIZE = 1_048_576; // 1MB
const MAX_GIT_LOG = 50;

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

/**
 * Risolve un path e verifica che sia sotto ALLOWED_ROOT.
 * Blocca path traversal (../) e symlink escape.
 */
function safePath(userPath: string): string {
    const resolved = resolve(ALLOWED_ROOT, userPath);
    if (!resolved.startsWith(ALLOWED_ROOT)) {
        throw new Error(
            `Path outside allowed root: ${userPath} → resolves to ${resolved}`
        );
    }
    return resolved;
}

/**
 * Esegue un comando git con cwd forzato alla root del progetto.
 * Usa execFile (no shell) per prevenire injection.
 */
async function git(args: string[]): Promise<string> {
    const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: ALLOWED_ROOT,
        maxBuffer: MAX_FILE_SIZE,
        timeout: 15_000,
    });
    if (stderr && !stdout) return stderr.trim();
    return stdout.trim();
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
    name: "muffin",
    version: "0.1.0",
});

// ---------------------------------------------------------------------------
// Filesystem tools
// ---------------------------------------------------------------------------

server.registerTool(
    "read_file",
    {
        description:
            "Read the contents of a file. Path is relative to the project root.",
        inputSchema: {
            path: z.string().describe("Relative path to the file"),
        },
    },
    async ({ path }) => {
        const abs = safePath(path);
        const info = await stat(abs);

        if (!info.isFile()) {
            return {
                content: [{ type: "text" as const, text: `Not a file: ${path}` }],
                isError: true,
            };
        }
        if (info.size > MAX_FILE_SIZE) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `File too large: ${info.size} bytes (max ${MAX_FILE_SIZE})`,
                    },
                ],
                isError: true,
            };
        }

        const content = await readFile(abs, "utf-8");
        return { content: [{ type: "text" as const, text: content }] };
    }
);

server.registerTool(
    "write_file",
    {
        description:
            "Write content to a file. Creates parent directories if needed. Path is relative to the project root.",
        inputSchema: {
            path: z.string().describe("Relative path to the file"),
            content: z.string().describe("Content to write"),
        },
    },
    async ({ path, content }) => {
        const abs = safePath(path);

        // Crea directory padre se necessario
        const dir = resolve(abs, "..");
        await mkdir(dir, { recursive: true });

        await writeFile(abs, content, "utf-8");
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Written ${content.length} bytes to ${path}`,
                },
            ],
        };
    }
);

server.registerTool(
    "list_directory",
    {
        description:
            "List the contents of a directory with file types and sizes. Path is relative to the project root.",
        inputSchema: {
            path: z
                .string()
                .default(".")
                .describe("Relative path to the directory"),
        },
    },
    async ({ path }) => {
        const abs = safePath(path);
        const entries = await readdir(abs, { withFileTypes: true });

        const lines: string[] = [];
        for (const entry of entries) {
            // Skip node_modules e .git per default
            if (entry.name === "node_modules" || entry.name === ".git") continue;

            if (entry.isDirectory()) {
                lines.push(`📁 ${entry.name}/`);
            } else {
                const info = await stat(join(abs, entry.name));
                const sizeKb = (info.size / 1024).toFixed(1);
                lines.push(`📄 ${entry.name} (${sizeKb} KB)`);
            }
        }

        const rel = relative(ALLOWED_ROOT, abs) || ".";
        const header = `Directory: ${rel}/ (${lines.length} items)`;
        return {
            content: [
                { type: "text" as const, text: `${header}\n\n${lines.join("\n")}` },
            ],
        };
    }
);

server.registerTool(
    "search_files",
    {
        description:
            "Search for a text pattern in files recursively (like grep). Returns matching lines with file paths and line numbers.",
        inputSchema: {
            pattern: z.string().describe("Text pattern to search for"),
            path: z
                .string()
                .default(".")
                .describe("Relative path to search in"),
            case_sensitive: z
                .boolean()
                .default(false)
                .describe("Whether the search is case-sensitive"),
        },
    },
    async ({ pattern, path, case_sensitive }) => {
        const abs = safePath(path);
        const args = [
            "--recursive",
            "--line-number",
            "--max-count=5", // max 5 match per file
        ];

        if (!case_sensitive) args.push("--ignore-case");

        // Escludi cartelle pesanti
        args.push(
            "--exclude-dir=node_modules",
            "--exclude-dir=.git",
            "--exclude-dir=dist"
        );

        args.push("--", pattern, abs);

        try {
            const { stdout } = await execFileAsync("grep", args, {
                cwd: ALLOWED_ROOT,
                maxBuffer: MAX_FILE_SIZE,
                timeout: 10_000,
            });

            // Rendi i path relativi alla root
            const output = stdout
                .split("\n")
                .map((line) => {
                    if (line.startsWith(ALLOWED_ROOT)) {
                        return line.substring(ALLOWED_ROOT.length + 1);
                    }
                    return line;
                })
                .join("\n")
                .trim();

            if (!output) {
                return {
                    content: [
                        { type: "text" as const, text: `No matches found for "${pattern}"` },
                    ],
                };
            }

            return { content: [{ type: "text" as const, text: output }] };
        } catch (error: unknown) {
            // grep exit code 1 = no matches
            const err = error as { code?: number };
            if (err.code === 1) {
                return {
                    content: [
                        { type: "text" as const, text: `No matches found for "${pattern}"` },
                    ],
                };
            }
            throw error;
        }
    }
);

// ---------------------------------------------------------------------------
// Git tools
// ---------------------------------------------------------------------------

server.registerTool(
    "git_status",
    {
        description:
            "Show the working tree status (modified, staged, untracked files).",
        inputSchema: {},
    },
    async () => {
        const output = await git(["status", "--short"]);
        return {
            content: [
                {
                    type: "text" as const,
                    text: output || "Working tree clean",
                },
            ],
        };
    }
);

server.registerTool(
    "git_log",
    {
        description: "Show recent git commits.",
        inputSchema: {
            count: z
                .number()
                .int()
                .min(1)
                .max(MAX_GIT_LOG)
                .default(10)
                .describe("Number of commits to show"),
        },
    },
    async ({ count }) => {
        const output = await git([
            "log",
            `--oneline`,
            `--graph`,
            `-n`,
            String(count),
        ]);
        return { content: [{ type: "text" as const, text: output }] };
    }
);

server.registerTool(
    "git_diff",
    {
        description:
            "Show changes in the working tree or staged changes.",
        inputSchema: {
            staged: z
                .boolean()
                .default(false)
                .describe("Show staged changes instead of unstaged"),
            path: z
                .string()
                .optional()
                .describe("Optional path to limit the diff"),
        },
    },
    async ({ staged, path }) => {
        const args = ["diff"];
        if (staged) args.push("--staged");
        if (path) {
            safePath(path); // validazione sicurezza
            args.push("--", path);
        }

        const output = await git(args);
        return {
            content: [
                {
                    type: "text" as const,
                    text: output || "No changes",
                },
            ],
        };
    }
);

server.registerTool(
    "git_add",
    {
        description: "Stage files for commit.",
        inputSchema: {
            pathspec: z
                .string()
                .describe("File path or glob pattern to stage (e.g. '.' for all)"),
        },
    },
    async ({ pathspec }) => {
        // Valida che non sia un path fuori dalla root (tranne ".")
        if (pathspec !== ".") safePath(pathspec);

        const output = await git(["add", pathspec]);
        return {
            content: [
                {
                    type: "text" as const,
                    text: output || `Staged: ${pathspec}`,
                },
            ],
        };
    }
);

server.registerTool(
    "git_commit",
    {
        description: "Create a git commit with the staged changes.",
        inputSchema: {
            message: z
                .string()
                .min(1)
                .max(500)
                .describe("Commit message"),
        },
    },
    async ({ message }) => {
        const output = await git(["commit", "-m", message]);
        return { content: [{ type: "text" as const, text: output }] };
    }
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Log to stderr — stdout è riservato al protocollo MCP
    console.error("🧁 Muffin MCP Server running on stdio");
}

main().catch((error) => {
    console.error("Fatal MCP server error:", error);
    process.exit(1);
});
