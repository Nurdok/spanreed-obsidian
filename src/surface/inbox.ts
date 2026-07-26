import {Notice} from 'obsidian';
import type SpanreedPlugin from "../main";
import type {SpanreedRedisClient} from "../redis";
import {contentToPlainText, WireContent} from "./render";

// Wire shape of one `obsidian-surface:{userId}:inbox` entry (server-side
// `write_inbox_entry` in obsidian_protocol.py).
export interface InboxEntry {
	entry_id: string;
	ts: number;
	text: string;
	parse_html: boolean;
	parse_markdown: boolean;
}

interface InboxReadState {
	last_read_entry_id: string | null;
	last_read_ts: number;
	cleared_ts: number;
}

const DEFAULT_READ_STATE: InboxReadState = {
	last_read_entry_id: null,
	last_read_ts: 0,
	cleared_ts: 0,
};

export function entryContent(entry: InboxEntry): WireContent {
	return {
		text: entry.text,
		parse_html: entry.parse_html,
		parse_markdown: entry.parse_markdown,
	};
}

// The durable notification inbox: fetched non-destructively (LRANGE) so all
// instances see the same entries; read/cleared state is device-local via
// Obsidian's localStorage (design §3.4, R4).
export class InboxManager {
	private plugin: SpanreedPlugin;
	private userId: number;
	// Wire order: oldest first, newest at the tail.
	entries: InboxEntry[] = [];
	private readState: InboxReadState;

	constructor(plugin: SpanreedPlugin, userId: number) {
		this.plugin = plugin;
		this.userId = userId;
		this.readState = this.loadReadState();
	}

	private storageKey(): string {
		return `spanreed-inbox-read:${this.plugin.settings.activeEnvironment}`;
	}

	private loadReadState(): InboxReadState {
		try {
			const raw = (this.plugin.app as any).loadLocalStorage(this.storageKey());
			if (typeof raw === "string" && raw.length > 0) {
				return Object.assign({}, DEFAULT_READ_STATE, JSON.parse(raw));
			}
		} catch (e) {
			console.error("Spanreed: failed to load inbox read state", e);
		}
		return Object.assign({}, DEFAULT_READ_STATE);
	}

	private saveReadState() {
		(this.plugin.app as any).saveLocalStorage(this.storageKey(), JSON.stringify(this.readState));
	}

	private static coerceEntry(parsed: any): InboxEntry | null {
		if (typeof parsed?.entry_id !== "string" || typeof parsed?.ts !== "number"
			|| typeof parsed?.text !== "string") {
			return null;
		}
		return {
			entry_id: parsed.entry_id,
			ts: parsed.ts,
			text: parsed.text,
			parse_html: !!parsed.parse_html,
			parse_markdown: !!parsed.parse_markdown,
		};
	}

	// Initial fetch on surface start. Entries queued while the instance was
	// closed surface as ONE summary toast, not a toast pile (design §4.3).
	async fetchInitial(write: SpanreedRedisClient) {
		const raw: string[] = await write.lRange(`obsidian-surface:${this.userId}:inbox`, 0, -1);
		const entries: InboxEntry[] = [];
		for (const item of raw) {
			let parsed: any = null;
			try {
				parsed = JSON.parse(item);
			} catch (e) {
				console.error("Spanreed: malformed inbox entry", item, e);
				continue;
			}
			const entry = InboxManager.coerceEntry(parsed);
			if (entry !== null) {
				entries.push(entry);
			}
		}
		this.entries = entries;
		const unread = this.unreadCount();
		if (unread > 0) {
			new Notice(`Spanreed: ${unread} notification${unread === 1 ? "" : "s"} while you were away`);
		}
	}

	// A live `notification` envelope: the server already wrote the inbox
	// entry; we mirror it locally and toast.
	onNotification(rawEntry: any) {
		const entry = InboxManager.coerceEntry(rawEntry);
		if (entry === null) {
			return;
		}
		// Guard against a re-delivered entry (e.g. around a reconnect sync).
		if (this.entries.some((e) => e.entry_id === entry.entry_id)) {
			return;
		}
		this.entries.push(entry);
		new Notice(contentToPlainText(entryContent(entry)));
	}

	// Newest first, minus locally-cleared entries.
	visibleEntries(): InboxEntry[] {
		return this.entries
			.filter((e) => e.ts > this.readState.cleared_ts)
			.slice()
			.reverse();
	}

	isUnread(entry: InboxEntry): boolean {
		return entry.ts > this.readState.last_read_ts;
	}

	unreadCount(): number {
		return this.visibleEntries().filter((e) => this.isUnread(e)).length;
	}

	// "Mark all read"/"Clear" only move local markers (per-device read
	// state); the entries themselves age out via the server-side cap.
	markAllRead() {
		const visible = this.visibleEntries();
		if (visible.length === 0) {
			return;
		}
		const newest = visible[0];
		this.readState.last_read_ts = newest.ts;
		this.readState.last_read_entry_id = newest.entry_id;
		this.saveReadState();
	}

	clear() {
		if (this.entries.length === 0) {
			return;
		}
		const newest = this.entries[this.entries.length - 1];
		this.readState.cleared_ts = newest.ts;
		this.readState.last_read_ts = Math.max(this.readState.last_read_ts, newest.ts);
		this.readState.last_read_entry_id = newest.entry_id;
		this.saveReadState();
	}
}
