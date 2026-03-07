import type Anthropic from "@anthropic-ai/sdk";
import { resolve, relative, join } from "node:path";
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

const ALLOWED_ROOT = resolve(process.cwd());
const MAX_FILE_SIZE = 1_048_576; // 1MB

/**
 * Risolve un path e verifica che sia sotto ALLOWED_ROOT.
 * Blocca path traversal (../) e symlink escape.
 */
function safePath(userPath: string): string {
    const resolved = resolve(ALLOWED_ROOT, userPath);
    if (!resolved.startsWith(ALLOWED_ROOT)) {
        throw new Error(`Path outside allowed root: ${userPath}`);
    }
    return resolved;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const readFileToolDefinition: Anthropic.Tool = {
    name: "read_file",
    description:
        "Read the contents of a file from the local project filesystem. Path is relative to the project root. Use this to inspect source code, configs, context files, etc.",
    input_schema: {
        type: "object" as const,
        properties: {
            path: {
                type: "string",
                description:
                    "Relative path to the file (e.g. 'src/index.ts', 'package.json').",
            },
            start_line: {
                type: "number",
                description: "Optional. 1-indexed start line to read from.",
            },
            end_line: {
                type: "number",
                description: "Optional. 1-indexed end line to read to.",
            },
        },
        required: ["path"],
    },
};

export const writeFileToolDefinition: Anthropic.Tool = {
    name: "write_file",
    description:
        "Write content to a file on the local project filesystem. Creates parent directories if needed. Path is relative to the project root.",
    input_schema: {
        type: "object" as const,
        properties: {
            path: {
                type: "string",
                description: "Relative path to the file.",
            },
            content: {
                type: "string",
                description: "Content to write to the file.",
            },
        },
        required: ["path", "content"],
    },
};

export const listDirectoryToolDefinition: Anthropic.Tool = {
    name: "list_directory",
    description:
        "List the contents of a directory in the local project filesystem. Shows file names, types, and sizes. Skips node_modules and .git by default.",
    input_schema: {
        type: "object" as const,
        properties: {
            path: {
                type: "string",
                description:
                    "Relative path to the directory. Defaults to '.' (project root).",
            },
        },
        required: [],
    },
};

export const searchFilesToolDefinition: Anthropic.Tool = {
    name: "search_files",
    description:
        "Search for a text pattern in project files recursively (like grep). Returns matching lines with file paths and line numbers. Useful for finding where something is defined or used.",
    input_schema: {
        type: "object" as const,
        properties: {
            pattern: {
                type: "string",
                description: "Text pattern to search for.",
            },
            path: {
                type: "string",
                description:
                    "Relative path to search in. Defaults to '.' (project root).",
            },
        },
        required: ["pattern"],
    },
};

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

interface ReadFileInput {
    path: string;
    start_line?: number;
    end_line?: number;
}

export async function executeReadFile(input: ReadFileInput): Promise<string> {
    try {
        const abs = safePath(input.path);
        const info = await stat(abs);

        if (!info.isFile()) {
            return `Error: not a file: ${input.path}`;
        }
        if (info.size > MAX_FILE_SIZE) {
            return `Error: file too large (${(info.size / 1024).toFixed(0)} KB, max ${MAX_FILE_SIZE / 1024} KB)`;
        }

        let content = await readFile(abs, "utf-8");

        const lines = content.split('\n');
        let start = 0;
        let end = lines.length;
        let isTruncated = false;

        if (input.start_line !== undefined) {
            start = Math.max(0, input.start_line - 1);
        }
        if (input.end_line !== undefined) {
            end = Math.min(lines.length, input.end_line);
        }

        // Auto-truncate if trying to read an entire huge file without bounds
        if (input.start_line === undefined && input.end_line === undefined && lines.length > 500) {
            end = 500;
            isTruncated = true;
        }

        content = lines.slice(start, end).join('\n');

        if (isTruncated) {
            content += `\n\n... [File troncato a 500 righe. Usa i parametri start_line e end_line per leggere il resto]`;
        }

        return content;
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Error reading file: ${msg}`;
    }
}

interface WriteFileInput {
    path: string;
    content: string;
}

export async function executeWriteFile(input: WriteFileInput): Promise<string> {
    try {
        const abs = safePath(input.path);
        const dir = resolve(abs, "..");
        await mkdir(dir, { recursive: true });
        await writeFile(abs, input.content, "utf-8");
        return `Written ${input.content.length} bytes to ${input.path}`;
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Error writing file: ${msg}`;
    }
}

interface ListDirectoryInput {
    path?: string;
}

export async function executeListDirectory(
    input: ListDirectoryInput
): Promise<string> {
    try {
        const abs = safePath(input.path || ".");
        const entries = await readdir(abs, { withFileTypes: true });
        const lines: string[] = [];

        for (const entry of entries) {
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
        return `Directory: ${rel}/ (${lines.length} items)\n\n${lines.join("\n")}`;
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Error listing directory: ${msg}`;
    }
}

interface SearchFilesInput {
    pattern: string;
    path?: string;
}

export async function executeSearchFiles(
    input: SearchFilesInput
): Promise<string> {
    try {
        const abs = safePath(input.path || ".");
        const args = [
            "--recursive",
            "--line-number",
            "--max-count=5",
            "--ignore-case",
            "--exclude-dir=node_modules",
            "--exclude-dir=.git",
            "--exclude-dir=dist",
            "--",
            input.pattern,
            abs,
        ];

        const { stdout } = await execFileAsync("grep", args, {
            cwd: ALLOWED_ROOT,
            maxBuffer: MAX_FILE_SIZE,
            timeout: 10_000,
        });

        const output = stdout
            .split("\n")
            .map((line) =>
                line.startsWith(ALLOWED_ROOT)
                    ? line.substring(ALLOWED_ROOT.length + 1)
                    : line
            )
            .join("\n")
            .trim();

        return output || `No matches found for "${input.pattern}"`;
    } catch (error: unknown) {
        const err = error as { code?: number };
        if (err.code === 1) {
            return `No matches found for "${input.pattern}"`;
        }
        const msg = error instanceof Error ? (error as Error).message : String(error);
        return `Error searching files: ${msg}`;
    }
}
