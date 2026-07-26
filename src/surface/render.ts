import {App, Component, MarkdownRenderer} from 'obsidian';

// Content as it appears on the wire: exactly what spanreed plugins pass
// today — text plus the Telegram-era parse flags (design §4.4). Each
// rendering path below is a pure string function so it stays testable.
export interface WireContent {
	text: string;
	parse_html: boolean;
	parse_markdown: boolean;
}

function unescapeHtmlEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function blockquoteToMarkdown(inner: string): string {
	const quoted = inner
		.replace(/^\n+/, "").replace(/\n+$/, "")
		.split("\n")
		.map((line) => "> " + line)
		.join("\n");
	return "\n" + quoted + "\n";
}

// Telegram HTML subset (b/i/u/s/a/code/pre/blockquote) -> Markdown.
// Whitelist-based: known tags map to Markdown equivalents, everything else
// is stripped — no raw HTML ever reaches the renderer.
export function telegramHtmlToMarkdown(text: string): string {
	let out = text;
	// Code blocks first, so their contents aren't touched by later rules.
	out = out.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
		(_m, inner: string) => "\n```\n" + inner.replace(/^\n+/, "").replace(/\n+$/, "") + "\n```\n");
	out = out.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi,
		(_m, inner: string) => "\n```\n" + inner.replace(/^\n+/, "").replace(/\n+$/, "") + "\n```\n");
	out = out.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
	// Links (double- or single-quoted hrefs).
	out = out.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
	out = out.replace(/<a\s+[^>]*href='([^']*)'[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
	out = out.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
		(_m, inner: string) => blockquoteToMarkdown(inner));
	out = out.replace(/<\/?(?:b|strong)>/gi, "**");
	out = out.replace(/<\/?(?:i|em)>/gi, "*");
	out = out.replace(/<\/?(?:s|strike|del)>/gi, "~~");
	// Markdown has no underline; render underlined text as plain text.
	out = out.replace(/<\/?u>/gi, "");
	out = out.replace(/<br\s*\/?>/gi, "\n");
	// Strip anything not on the whitelist.
	out = out.replace(/<\/?[a-zA-Z][^>]*>/g, "");
	// Entities last, so a literal `&lt;b&gt;` can't become a tag mid-way.
	return unescapeHtmlEntities(out);
}

const MARKDOWNV2_PUNCTUATION = "\\_*[]()~`>#+-=|{}.!";

// Telegram MarkdownV2 arrives with punctuation backslash-escaped. Unescape
// ONLY backslash-before-punctuation, and ONLY outside code spans/fences:
// tracebacks in code fences carry literal `\n`s, Windows paths and regexes
// that must survive verbatim (design §4.4).
export function unescapeMarkdownV2(text: string): string {
	let out = "";
	let inFence = false;
	let inSpan = false;
	for (let i = 0; i < text.length; i++) {
		if (text.startsWith("```", i)) {
			inFence = !inFence;
			out += "```";
			i += 2;
			continue;
		}
		const ch = text[i];
		if (ch === "`" && !inFence) {
			inSpan = !inSpan;
			out += ch;
			continue;
		}
		if (ch === "\\" && !inFence && !inSpan && i + 1 < text.length
			&& MARKDOWNV2_PUNCTUATION.indexOf(text[i + 1]) >= 0) {
			out += text[i + 1];
			i++;
			continue;
		}
		out += ch;
	}
	return out;
}

export function contentToMarkdown(content: WireContent): string {
	if (content.parse_html) {
		return telegramHtmlToMarkdown(content.text);
	}
	if (content.parse_markdown) {
		return unescapeMarkdownV2(content.text);
	}
	return content.text;
}

// Plain-text downgrade for toasts (Notices can't render Markdown).
export function contentToPlainText(content: WireContent): string {
	return contentToMarkdown(content)
		.replace(/```[^\n`]*\n?/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/^>\s?/gm, "")
		.replace(/^#{1,6}\s+/gm, "")
		.trim();
}

export async function renderContentInto(
	app: App, content: WireContent, el: HTMLElement, component: Component
): Promise<void> {
	await MarkdownRenderer.render(app, contentToMarkdown(content), el, "", component);
}
