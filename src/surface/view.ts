import {Component, ItemView, WorkspaceLeaf} from 'obsidian';
import type SpanreedPlugin from "../main";
import type {SurfaceClient, PromptState} from "./client";
import {entryContent} from "./inbox";
import {renderContentInto} from "./render";

export const VIEW_TYPE_SPANREED = "spanreed-surface";

// Draining a backlog fires one state change per envelope (the inbound queue
// holds up to 100), and each one would otherwise repaint the whole surface.
// Collapse a burst into a single paint.
export const RENDER_DEBOUNCE_MS = 50;

// How many inbox entries get built into the DOM at once. The server keeps up
// to INBOX_MAX (200) and every one of them is a Markdown render, which is far
// too much to rebuild on each repaint.
export const INBOX_RENDER_LIMIT = 50;

// Which slice of the inbox to render, and how much is left over.
export function inboxPage<T>(
	entries: T[], showAll: boolean, limit: number = INBOX_RENDER_LIMIT
): {shown: T[]; hidden: number} {
	if (showAll || entries.length <= limit) {
		return {shown: entries, hidden: 0};
	}
	return {shown: entries.slice(0, limit), hidden: entries.length - limit};
}

// Coalesces repaint requests: the first one schedules a paint and any that
// arrive before it fires are absorbed into it, so a burst costs one render.
export class RenderScheduler {
	private timeoutId: ReturnType<typeof setTimeout> | null = null;
	private readonly delayMs: number;
	private readonly run: () => void;

	constructor(delayMs: number, run: () => void) {
		this.delayMs = delayMs;
		this.run = run;
	}

	get pending(): boolean {
		return this.timeoutId !== null;
	}

	schedule() {
		if (this.timeoutId !== null) {
			return;
		}
		this.timeoutId = setTimeout(() => {
			this.timeoutId = null;
			this.run();
		}, this.delayMs);
	}

	cancel() {
		if (this.timeoutId !== null) {
			clearTimeout(this.timeoutId);
			this.timeoutId = null;
		}
	}
}

// The sidebar surface view: two stacked sections — Conversation (transcript
// + active prompt card) and a collapsible Inbox. Renders purely from
// SurfaceClient state; closing/reopening the leaf mid-prompt loses nothing.
export class SpanreedView extends ItemView {
	plugin: SpanreedPlugin;
	private unsubscribe: (() => void) | null = null;
	private inputDraft = "";
	private inputHadFocus = false;
	private inboxOpen = true;
	private inboxShowAll = false;
	private scheduler: RenderScheduler;
	// Owns the Markdown render children of the CURRENT paint only.
	private renderComponent: Component | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: SpanreedPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.scheduler = new RenderScheduler(RENDER_DEBOUNCE_MS, () => this.render());
	}

	getViewType(): string {
		return VIEW_TYPE_SPANREED;
	}

	getDisplayText(): string {
		return "Spanreed";
	}

	getIcon(): string {
		return "message-square";
	}

	async onOpen() {
		this.unsubscribe = this.plugin.onSurfaceChange(() => this.scheduler.schedule());
		this.render();
	}

	async onClose() {
		this.scheduler.cancel();
		if (this.unsubscribe !== null) {
			this.unsubscribe();
			this.unsubscribe = null;
		}
		this.releaseRenderComponent();
	}

	// MarkdownRenderer.render attaches child components to the owner it is
	// handed, and those live until the OWNER unloads. container.empty() drops
	// the DOM but not the components, so handing it a long-lived owner (the
	// view) leaks one set per repaint. Each paint gets its own owner instead,
	// unloaded here at the start of the next one.
	private releaseRenderComponent() {
		if (this.renderComponent !== null) {
			this.removeChild(this.renderComponent);
			this.renderComponent = null;
		}
	}

	private render() {
		this.releaseRenderComponent();
		const renderComponent = new Component();
		this.addChild(renderComponent);
		this.renderComponent = renderComponent;

		const container = this.contentEl;
		container.empty();
		container.addClass("spanreed-surface-view");

		const surface = this.plugin.surface;
		if (surface === null) {
			container.createDiv({
				cls: "spanreed-disabled-note",
				text: "The Spanreed interaction surface is disabled."
					+ " Enable it in the plugin settings.",
			});
			return;
		}

		this.renderConversation(container, surface, renderComponent);
		this.renderInbox(container, surface, renderComponent);
	}

	// -- conversation ------------------------------------------------------

	private renderConversation(
		container: HTMLElement, surface: SurfaceClient, component: Component
	) {
		const section = container.createDiv({cls: "spanreed-section"});
		section.createDiv({cls: "spanreed-section-title", text: "Conversation"});

		const transcriptEl = section.createDiv({cls: "spanreed-transcript"});
		if (surface.transcript.length === 0 && surface.currentPrompt === null
			&& surface.statusLine === null) {
			transcriptEl.createDiv({
				cls: "spanreed-empty-note",
				text: "No active conversation.",
			});
		}
		for (const entry of surface.transcript) {
			const cls = entry.local
				? "spanreed-message spanreed-message-local"
				: "spanreed-message";
			const el = transcriptEl.createDiv({cls: cls});
			void renderContentInto(this.app, entry.content, el, component);
		}

		if (surface.statusLine !== null) {
			section.createDiv({cls: "spanreed-status", text: surface.statusLine});
		}
		if (surface.currentPrompt !== null) {
			this.renderPromptCard(section, surface, surface.currentPrompt, component);
		}

		if (surface.transcript.length > 0 || surface.statusLine !== null
			|| surface.currentPrompt !== null) {
			const controls = section.createDiv({cls: "spanreed-inbox-controls"});
			const clearButton = controls.createEl("button", {
				cls: "spanreed-inbox-button",
				text: "Clear",
			});
			clearButton.addEventListener("click", () => {
				void surface.clearConversation();
			});
		}
	}

	private renderPromptCard(
		section: HTMLElement, surface: SurfaceClient, prompt: PromptState, component: Component
	) {
		const card = section.createDiv({
			cls: "spanreed-prompt-card" + (prompt.answered ? " is-answered" : ""),
		});
		const promptTextEl = card.createDiv({cls: "spanreed-prompt-text"});
		void renderContentInto(this.app, prompt.payload.prompt, promptTextEl, component);

		if (prompt.payload.kind === "choice" && prompt.payload.choices !== null) {
			// Vertical list; a nested row's buttons share the same top-level
			// index (matching the Telegram keyboard's answer semantics).
			const list = card.createDiv({cls: "spanreed-choice-list"});
			prompt.payload.choices.forEach((choice, index) => {
				const labels: string[] = Array.isArray(choice) ? choice : [choice];
				for (const label of labels) {
					const button = list.createEl("button", {
						cls: "spanreed-choice-button",
						text: label,
					});
					button.disabled = prompt.answered;
					button.addEventListener("click", () => {
						void surface.answerChoice(index, label);
					});
				}
			});
		} else if (prompt.payload.kind === "input") {
			const row = card.createDiv({cls: "spanreed-input-row"});
			const input = row.createEl("input", {
				cls: "spanreed-input",
				type: "text",
				value: this.inputDraft,
				placeholder: "Type your answer…",
			});
			input.disabled = prompt.answered;
			input.addEventListener("input", () => {
				this.inputDraft = input.value;
			});
			input.addEventListener("focus", () => {
				this.inputHadFocus = true;
			});
			input.addEventListener("blur", () => {
				this.inputHadFocus = false;
			});
			const submit = () => {
				const value = input.value.trim();
				if (value === "") {
					return;
				}
				this.inputDraft = "";
				void surface.answerInput(value);
			};
			input.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					submit();
				}
			});
			const button = row.createEl("button", {
				cls: "spanreed-submit-button",
				text: "Submit",
			});
			button.disabled = prompt.answered;
			button.addEventListener("click", submit);
			// A re-render (any state change) rebuilds the DOM; give focus
			// back so typing isn't interrupted.
			if (this.inputHadFocus && !prompt.answered) {
				window.setTimeout(() => {
					input.focus();
					input.setSelectionRange(input.value.length, input.value.length);
				}, 0);
			}
		}

		if (prompt.answered) {
			card.createDiv({
				cls: "spanreed-status",
				text: "Answer sent — waiting for Spanreed…",
			});
		}
	}

	// -- inbox -------------------------------------------------------------

	private renderInbox(container: HTMLElement, surface: SurfaceClient, component: Component) {
		const details = container.createEl("details", {
			cls: "spanreed-section spanreed-inbox",
		});
		details.open = this.inboxOpen;
		details.addEventListener("toggle", () => {
			this.inboxOpen = details.open;
		});

		const summary = details.createEl("summary", {cls: "spanreed-inbox-summary"});
		summary.createSpan({cls: "spanreed-section-title", text: "Inbox"});
		const unread = surface.inbox.unreadCount();
		if (unread > 0) {
			summary.createSpan({cls: "spanreed-badge", text: String(unread)});
		}

		const controls = details.createDiv({cls: "spanreed-inbox-controls"});
		const markReadButton = controls.createEl("button", {
			cls: "spanreed-inbox-button",
			text: "Mark all read",
		});
		markReadButton.addEventListener("click", () => {
			surface.inbox.markAllRead();
			this.plugin.notifySurfaceChanged();
		});
		const clearButton = controls.createEl("button", {
			cls: "spanreed-inbox-button",
			text: "Clear",
		});
		clearButton.addEventListener("click", () => {
			surface.inbox.clear();
			// Back to the capped view; whatever arrives next starts small.
			this.inboxShowAll = false;
			this.plugin.notifySurfaceChanged();
		});

		const list = details.createDiv({cls: "spanreed-inbox-list"});
		const entries = surface.inbox.visibleEntries();
		if (entries.length === 0) {
			list.createDiv({cls: "spanreed-empty-note", text: "No notifications."});
			return;
		}
		const {shown, hidden} = inboxPage(entries, this.inboxShowAll);
		for (const entry of shown) {
			const item = list.createDiv({
				cls: "spanreed-inbox-item"
					+ (surface.inbox.isUnread(entry) ? " is-unread" : ""),
			});
			item.createDiv({
				cls: "spanreed-inbox-ts",
				text: new Date(entry.ts * 1000).toLocaleString(),
			});
			const body = item.createDiv({cls: "spanreed-inbox-body"});
			void renderContentInto(this.app, entryContent(entry), body, component);
		}
		if (hidden > 0) {
			// "Mark all read" and "Clear" still act on everything, not just
			// what is on screen.
			const moreButton = list.createEl("button", {
				cls: "spanreed-inbox-button",
				text: `Show ${hidden} older`,
			});
			moreButton.addEventListener("click", () => {
				this.inboxShowAll = true;
				this.render();
			});
		}
	}
}
