import {describe, expect, it} from 'vitest';
import {
	contentToMarkdown,
	contentToPlainText,
	telegramHtmlToMarkdown,
	unescapeMarkdownV2,
	WireContent,
} from '../src/surface/render';

function html(text: string): WireContent {
	return {text, parse_html: true, parse_markdown: false};
}

function markdownV2(text: string): WireContent {
	return {text, parse_html: false, parse_markdown: true};
}

function plain(text: string): WireContent {
	return {text, parse_html: false, parse_markdown: false};
}

describe('telegramHtmlToMarkdown', () => {
	it('maps the inline formatting tags to Markdown', () => {
		expect(telegramHtmlToMarkdown('<b>bold</b>')).toBe('**bold**');
		expect(telegramHtmlToMarkdown('<strong>bold</strong>')).toBe('**bold**');
		expect(telegramHtmlToMarkdown('<i>it</i>')).toBe('*it*');
		expect(telegramHtmlToMarkdown('<em>it</em>')).toBe('*it*');
		expect(telegramHtmlToMarkdown('<s>gone</s>')).toBe('~~gone~~');
		expect(telegramHtmlToMarkdown('<del>gone</del>')).toBe('~~gone~~');
	});

	it('is case-insensitive about tag names', () => {
		expect(telegramHtmlToMarkdown('<B>bold</B>')).toBe('**bold**');
	});

	it('drops underline, which Markdown has no syntax for', () => {
		expect(telegramHtmlToMarkdown('<u>plain</u>')).toBe('plain');
	});

	it('converts links, with either quote style', () => {
		expect(telegramHtmlToMarkdown('<a href="https://x.dev">x</a>'))
			.toBe('[x](https://x.dev)');
		expect(telegramHtmlToMarkdown("<a href='https://x.dev'>x</a>"))
			.toBe('[x](https://x.dev)');
	});

	it('turns <br> into a newline', () => {
		expect(telegramHtmlToMarkdown('a<br>b')).toBe('a\nb');
		expect(telegramHtmlToMarkdown('a<br />b')).toBe('a\nb');
	});

	it('renders code spans and fences', () => {
		expect(telegramHtmlToMarkdown('<code>x = 1</code>')).toBe('`x = 1`');
		expect(telegramHtmlToMarkdown('<pre><code>x = 1</code></pre>'))
			.toBe('\n```\nx = 1\n```\n');
		expect(telegramHtmlToMarkdown('<pre>x = 1</pre>')).toBe('\n```\nx = 1\n```\n');
	});

	it('keeps fence content that has no HTML-ish tags verbatim', () => {
		expect(telegramHtmlToMarkdown('<pre><code>if (a &lt; b) { x() }</code></pre>'))
			.toBe('\n```\nif (a < b) { x() }\n```\n');
	});

	// Pins CURRENT behaviour, which contradicts the "so their contents aren't
	// touched by later rules" comment in render.ts: fences are extracted first,
	// but the inline rules that follow still run over the whole string, so a
	// literal <b> inside a code block is rewritten to **. Sending a snippet of
	// HTML through a <pre> block therefore mangles it. Change this test if the
	// fence contents are ever made truly opaque.
	it('still rewrites HTML-ish tags inside a code fence (known wart)', () => {
		expect(telegramHtmlToMarkdown('<pre><code>a <b> b</code></pre>'))
			.toBe('\n```\na ** b\n```\n');
	});

	it('prefixes every line of a blockquote', () => {
		expect(telegramHtmlToMarkdown('<blockquote>one\ntwo</blockquote>'))
			.toBe('\n> one\n> two\n');
	});

	it('strips tags that are not on the whitelist', () => {
		expect(telegramHtmlToMarkdown('<script>evil()</script>')).toBe('evil()');
		expect(telegramHtmlToMarkdown('<div class="x">hi</div>')).toBe('hi');
		expect(telegramHtmlToMarkdown('<img src="x.png">')).toBe('');
	});

	it('unescapes entities last, so escaped markup stays inert', () => {
		// If entities were decoded first, this would become real bold.
		expect(telegramHtmlToMarkdown('&lt;b&gt;not bold&lt;/b&gt;'))
			.toBe('<b>not bold</b>');
		expect(telegramHtmlToMarkdown('a &amp; b')).toBe('a & b');
		expect(telegramHtmlToMarkdown('&quot;q&quot; &#39;s&#39;')).toBe('"q" \'s\'');
	});
});

describe('unescapeMarkdownV2', () => {
	it('unescapes backslash-escaped punctuation', () => {
		expect(unescapeMarkdownV2('a\\-b')).toBe('a-b');
		expect(unescapeMarkdownV2('\\*not bold\\*')).toBe('*not bold*');
		expect(unescapeMarkdownV2('end\\.')).toBe('end.');
	});

	it('leaves a backslash before a non-punctuation char alone', () => {
		// \n here is a literal backslash-n, not a newline.
		expect(unescapeMarkdownV2('C:\\nope')).toBe('C:\\nope');
	});

	it('leaves escapes inside a code span untouched', () => {
		expect(unescapeMarkdownV2('`a\\-b`')).toBe('`a\\-b`');
	});

	it('leaves escapes inside a fenced block untouched', () => {
		// Tracebacks and regexes arrive in fences and must survive verbatim.
		const fenced = '```\nre.compile\\(r"\\d+"\\)\n```';
		expect(unescapeMarkdownV2(fenced)).toBe(fenced);
	});

	it('resumes unescaping after a fence closes', () => {
		expect(unescapeMarkdownV2('```\na\\-b\n```\nc\\-d'))
			.toBe('```\na\\-b\n```\nc-d');
	});
});

describe('contentToMarkdown', () => {
	it('routes on the wire parse flags', () => {
		expect(contentToMarkdown(html('<b>b</b>'))).toBe('**b**');
		expect(contentToMarkdown(markdownV2('a\\-b'))).toBe('a-b');
		// No flags: the text is passed through verbatim.
		expect(contentToMarkdown(plain('<b>b</b> a\\-b'))).toBe('<b>b</b> a\\-b');
	});

	it('prefers HTML when both flags are set', () => {
		expect(contentToMarkdown({text: '<b>b</b>', parse_html: true, parse_markdown: true}))
			.toBe('**b**');
	});
});

describe('contentToPlainText', () => {
	it('strips the markup a Notice cannot render', () => {
		expect(contentToPlainText(html('<b>bold</b> and <i>it</i>'))).toBe('bold and it');
		expect(contentToPlainText(html('<a href="https://x.dev">link</a>'))).toBe('link');
		expect(contentToPlainText(html('<code>x</code>'))).toBe('x');
		expect(contentToPlainText(html('<s>gone</s>'))).toBe('gone');
	});

	it('flattens fences, quotes and headings', () => {
		expect(contentToPlainText(html('<pre><code>x = 1</code></pre>'))).toBe('x = 1');
		expect(contentToPlainText(html('<blockquote>quoted</blockquote>'))).toBe('quoted');
		expect(contentToPlainText(plain('# Title'))).toBe('Title');
	});

	it('trims surrounding whitespace', () => {
		expect(contentToPlainText(plain('  padded  '))).toBe('padded');
	});
});
