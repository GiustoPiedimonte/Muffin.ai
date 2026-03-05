import type Anthropic from "@anthropic-ai/sdk";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

const ALLOWED_ROOT = resolve(process.cwd());
const MAX_OUTPUT = 1_048_576; // 1MB
const MAX_GIT_LOG = 50;

/**
 * Esegue un comando git con cwd forzato alla root del progetto.
 * Usa execFile (no shell) per prevenire injection.
 */
async function git(args: string[]): Promise<string> {
    const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: ALLOWED_ROOT,
        maxBuffer: MAX_OUTPUT,
        timeout: 15_000,
    });
    if (stderr && !stdout) return stderr.trim();
    return stdout.trim();
}

/**
 * Valida che un path sia sotto ALLOWED_ROOT (per git_add, git_diff).
 */
function safePath(userPath: string): void {
    const resolved = resolve(ALLOWED_ROOT, userPath);
    if (!resolved.startsWith(ALLOWED_ROOT)) {
        throw new Error(`Path outside allowed root: ${userPath}`);
    }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const gitStatusToolDefinition: Anthropic.Tool = {
    name: "git_status",
    description:
        "Show the git working tree status — modified, staged, and untracked files.",
    input_schema: {
        type: "object" as const,
        properties: {},
        required: [],
    },
};

export const gitLogToolDefinition: Anthropic.Tool = {
    name: "git_log",
    description: "Show recent git commits with a graph view.",
    input_schema: {
        type: "object" as const,
        properties: {
            count: {
                type: "number",
                description:
                    "Number of commits to show (1-50). Defaults to 10.",
            },
        },
        required: [],
    },
};

export const gitDiffToolDefinition: Anthropic.Tool = {
    name: "git_diff",
    description:
        "Show changes in the working tree or staged changes. Optionally limit to a specific file path.",
    input_schema: {
        type: "object" as const,
        properties: {
            staged: {
                type: "boolean",
                description:
                    "If true, show staged changes instead of unstaged. Defaults to false.",
            },
            path: {
                type: "string",
                description: "Optional path to limit the diff to a specific file.",
            },
        },
        required: [],
    },
};

export const gitAddToolDefinition: Anthropic.Tool = {
    name: "git_add",
    description: "Stage files for commit.",
    input_schema: {
        type: "object" as const,
        properties: {
            pathspec: {
                type: "string",
                description:
                    "File path or pattern to stage (e.g. '.' for all, 'src/index.ts' for a specific file).",
            },
        },
        required: ["pathspec"],
    },
};

export const gitCommitToolDefinition: Anthropic.Tool = {
    name: "git_commit",
    description: "Create a git commit with the currently staged changes.",
    input_schema: {
        type: "object" as const,
        properties: {
            message: {
                type: "string",
                description: "Commit message (max 500 characters).",
            },
        },
        required: ["message"],
    },
};

export const gitBranchToolDefinition: Anthropic.Tool = {
    name: "git_branch",
    description: "List, create, checkout, or delete branches.",
    input_schema: {
        type: "object" as const,
        properties: {
            action: {
                type: "string",
                description: "Action to perform: 'list', 'create', 'checkout', 'delete'",
                enum: ["list", "create", "checkout", "delete"]
            },
            branch_name: {
                type: "string",
                description: "Name of the branch (required for create, checkout, delete)."
            }
        },
        required: ["action"],
    },
};

export const gitPushToolDefinition: Anthropic.Tool = {
    name: "git_push",
    description: "Push commits to a remote repository.",
    input_schema: {
        type: "object" as const,
        properties: {
            remote: {
                type: "string",
                description: "Remote name, defaults to 'origin'.",
            },
            branch: {
                type: "string",
                description: "Branch name, defaults to current branch.",
            },
            force: {
                type: "boolean",
                description: "Whether to force push. Use with caution.",
            }
        },
        required: [],
    },
};

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

export async function executeGitStatus(): Promise<string> {
    try {
        const output = await git(["status", "--short"]);
        return output || "Working tree clean — nessuna modifica.";
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Error running git status: ${msg}`;
    }
}

interface GitLogInput {
    count?: number;
}

export async function executeGitLog(input: GitLogInput): Promise<string> {
    try {
        const count = Math.min(Math.max(input.count || 10, 1), MAX_GIT_LOG);
        const output = await git([
            "log",
            "--oneline",
            "--graph",
            "-n",
            String(count),
        ]);
        return output || "No commits found.";
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Error running git log: ${msg}`;
    }
}

interface GitDiffInput {
    staged?: boolean;
    path?: string;
}

export async function executeGitDiff(input: GitDiffInput): Promise<string> {
    try {
        const args = ["diff"];
        if (input.staged) args.push("--staged");
        if (input.path) {
            safePath(input.path);
            args.push("--", input.path);
        }
        const output = await git(args);
        return output || "No changes.";
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Error running git diff: ${msg}`;
    }
}

interface GitAddInput {
    pathspec: string;
}

export async function executeGitAdd(input: GitAddInput): Promise<string> {
    try {
        if (input.pathspec !== ".") safePath(input.pathspec);
        await git(["add", input.pathspec]);
        return `Staged: ${input.pathspec}`;
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Error running git add: ${msg}`;
    }
}

interface GitCommitInput {
    message: string;
}

export async function executeGitCommit(input: GitCommitInput): Promise<string> {
    try {
        if (!input.message || input.message.length > 500) {
            return "Error: commit message must be 1-500 characters.";
        }
        const output = await git(["commit", "-m", input.message]);
        return output;
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Error running git commit: ${msg}`;
    }
}

interface GitBranchInput {
    action: "list" | "create" | "checkout" | "delete";
    branch_name?: string;
}

export async function executeGitBranch(input: GitBranchInput): Promise<string> {
    try {
        if (input.action === "list") {
            const output = await git(["branch", "-a"]);
            return output || "No branches found.";
        }

        if (!input.branch_name) {
            return "Error: branch_name is required for this action.";
        }

        switch (input.action) {
            case "create":
                await git(["branch", input.branch_name]);
                return `Created branch: ${input.branch_name}`;
            case "checkout":
                await git(["checkout", input.branch_name]);
                return `Switched to branch: ${input.branch_name}`;
            case "delete":
                if (input.branch_name === "main" || input.branch_name === "master") {
                    return `Error: Cannot delete protected branch '${input.branch_name}'.`;
                }
                const output = await git(["branch", "-D", input.branch_name]);
                return output || `Deleted branch: ${input.branch_name}`;
            default:
                return "Error: Invalid action.";
        }
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Error running git branch: ${msg}`;
    }
}

interface GitPushInput {
    remote?: string;
    branch?: string;
    force?: boolean;
}

export async function executeGitPush(input: GitPushInput): Promise<string> {
    try {
        const remote = input.remote || "origin";
        let branch = input.branch;
        if (!branch) {
            // Get current branch
            branch = await git(["branch", "--show-current"]);
        }

        if (branch === "main" || branch === "master") {
            return `Error: Pushing directly to '${branch}' is protected. Please create a pull request or merge locally according to your workflow.`;
        }

        const args = ["push"];
        if (input.force) args.push("--force");
        args.push(remote, branch);

        const output = await git(args);
        return output || `Pushed successfully to ${remote}/${branch}.`;
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Error running git push: ${msg}`;
    }
}
