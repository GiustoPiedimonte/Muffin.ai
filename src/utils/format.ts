export function toTelegramHTML(text: string): string {
    if (!text) return "";

    // 1. Escape HTML special characters
    let html = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // 2. Code blocks (match optional language)
    html = html.replace(/```([a-zA-Z0-9]*)\n([\s\S]*?)```/g, (match, lang, code) => {
        if (lang) {
            return `<pre><code class="language-${lang}">${code}</code></pre>`;
        }
        return `<pre><code>${code}</code></pre>`;
    });

    // 3. Inline code
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");

    // 4. Bold (**)
    html = html.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");

    // 5. Italic (* and _)
    html = html.replace(/(?<=\s|^)\*([^*]+)\*(?=\s|$|\p{Punctuation})/gu, "<i>$1</i>");
    html = html.replace(/(?<=\s|^)_([^_]+)_(?=\s|$|\p{Punctuation})/gu, "<i>$1</i>");

    // 6. Strikethrough (~~)
    html = html.replace(/~~([^~]+)~~/g, "<s>$1</s>");

    // 7. Links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // 8. Blockquotes (> text)
    // Handle multiline blockquotes as well
    html = html.replace(/^> (.*$)/gm, "<blockquote>$1</blockquote>");

    return html;
}
