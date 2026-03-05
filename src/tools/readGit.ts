import type Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Tool definition for Claude
// ---------------------------------------------------------------------------

export const readGitToolDefinition: Anthropic.Tool = {
    name: "read_github_file",
    description:
        "Read a file from a GitHub repository. Use this when the user asks to see source code, configuration files, or any file hosted on GitHub. You can read files from any public repository, and from private repositories if a GITHUB_TOKEN is configured.",
    input_schema: {
        type: "object" as const,
        properties: {
            owner: {
                type: "string",
                description:
                    "The GitHub username or organization that owns the repository (e.g. 'vercel', 'anthropics').",
            },
            repo: {
                type: "string",
                description:
                    "The name of the repository (e.g. 'next.js', 'sdk-python').",
            },
            path: {
                type: "string",
                description:
                    "The path to the file inside the repository (e.g. 'src/index.ts', 'README.md').",
            },
            branch: {
                type: "string",
                description:
                    "The branch to read from. Defaults to 'main' if not specified.",
            },
        },
        required: ["owner", "repo", "path"],
    },
};

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

interface ReadGitInput {
    owner: string;
    repo: string;
    path: string;
    branch?: string;
}

const MAX_FILE_SIZE = 100_000; // ~100 KB — avoid dumping huge files into context

export async function executeReadGit(input: ReadGitInput): Promise<string> {
    const { owner, repo, path, branch = "main" } = input;

    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}?ref=${encodeURIComponent(branch)}`;

    const headers: Record<string, string> = {
        Accept: "application/vnd.github.v3.raw",
        "User-Agent": "Muffin-Agent",
    };

    const token = process.env.GITHUB_TOKEN;
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }

    try {
        const response = await fetch(url, { headers });

        if (response.status === 404) {
            return `File not found: ${owner}/${repo}/${path} (branch: ${branch}). Check that the owner, repo name, file path, and branch are correct.`;
        }

        if (response.status === 403) {
            const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
            if (rateLimitRemaining === "0") {
                return "GitHub API rate limit exceeded. Try again later or configure a GITHUB_TOKEN for higher limits.";
            }
            return `Access denied to ${owner}/${repo}/${path}. The repository may be private — a GITHUB_TOKEN with repo access is required.`;
        }

        if (!response.ok) {
            return `GitHub API error (${response.status}): ${response.statusText}`;
        }

        const content = await response.text();

        if (content.length > MAX_FILE_SIZE) {
            return `File is too large (${(content.length / 1024).toFixed(0)} KB). Showing the first ${(MAX_FILE_SIZE / 1024).toFixed(0)} KB:\n\n${content.substring(0, MAX_FILE_SIZE)}\n\n... [truncated]`;
        }

        return `\`\`\`\n${content}\n\`\`\`\n\n_Source: https://github.com/${owner}/${repo}/blob/${branch}/${path}_`;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Failed to read GitHub file: ${message}`;
    }
}
