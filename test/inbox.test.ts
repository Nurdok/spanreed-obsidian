import {beforeEach, describe, expect, it} from 'vitest';
import {clearNotices, notices} from './stubs/obsidian';
import {InboxEntry, InboxManager, entryContent} from '../src/surface/inbox';

// Obsidian's per-device localStorage, as an in-memory map.
class FakeLocalStorage {
	private store: Map<string, string> = new Map();

	loadLocalStorage(key: string): string | null {
		const value = this.store.get(key);
		return value === undefined ? null : value;
	}

	saveLocalStorage(key: string, value: string): void {
		this.store.set(key, value);
	}
}

function makePlugin(app: FakeLocalStorage = new FakeLocalStorage()) {
	return {app, settings: {activeEnvironment: 'test'}};
}

function makeManager(plugin: ReturnType<typeof makePlugin> = makePlugin()): InboxManager {
	return new InboxManager(plugin as never, 42);
}

function entry(entry_id: string, ts: number, text = `msg ${entry_id}`): InboxEntry {
	return {entry_id, ts, text, parse_html: false, parse_markdown: false};
}

// Minimal stand-in for the Redis client: only lRange is used by fetchInitial.
function fakeRedis(items: unknown[]) {
	return {
		lRange: async (_key: string, _start: number, _stop: number): Promise<string[]> =>
			items.map((i) => (typeof i === "string" ? i : JSON.stringify(i))),
	} as never;
}

beforeEach(() => {
	clearNotices();
});

describe('entryContent', () => {
	it('projects the wire parse flags onto the content', () => {
		const e: InboxEntry = {entry_id: 'a', ts: 1, text: 'x', parse_html: true, parse_markdown: false};
		expect(entryContent(e)).toEqual({text: 'x', parse_html: true, parse_markdown: false});
	});
});

describe('InboxManager.fetchInitial', () => {
	it('loads entries from the inbox list', async () => {
		const m = makeManager();
		await m.fetchInitial(fakeRedis([entry('a', 1), entry('b', 2)]));
		expect(m.entries.map((e) => e.entry_id)).toEqual(['a', 'b']);
	});

	it('skips malformed JSON and entries missing required fields', async () => {
		const m = makeManager();
		await m.fetchInitial(fakeRedis([
			'{not json',
			{entry_id: 'no-ts', text: 'x'},
			{ts: 5, text: 'no id'},
			{entry_id: 'bad-text', ts: 5, text: 42},
			entry('good', 7),
		]));
		expect(m.entries.map((e) => e.entry_id)).toEqual(['good']);
	});

	it('coerces the parse flags to booleans', async () => {
		const m = makeManager();
		await m.fetchInitial(fakeRedis([
			{entry_id: 'a', ts: 1, text: 'x', parse_html: 1, parse_markdown: undefined},
		]));
		expect(m.entries[0].parse_html).toBe(true);
		expect(m.entries[0].parse_markdown).toBe(false);
	});

	it('summarises a backlog in one toast rather than a toast pile', async () => {
		const m = makeManager();
		await m.fetchInitial(fakeRedis([entry('a', 1), entry('b', 2), entry('c', 3)]));
		expect(notices).toEqual(['Spanreed: 3 notifications while you were away']);
	});

	it('singularises the summary toast', async () => {
		const m = makeManager();
		await m.fetchInitial(fakeRedis([entry('a', 1)]));
		expect(notices).toEqual(['Spanreed: 1 notification while you were away']);
	});

	it('says nothing when the inbox is empty', async () => {
		const m = makeManager();
		await m.fetchInitial(fakeRedis([]));
		expect(notices).toEqual([]);
	});
});

describe('InboxManager.onNotification', () => {
	it('appends the entry and toasts it as plain text', () => {
		const m = makeManager();
		m.onNotification({entry_id: 'a', ts: 1, text: '<b>bold</b>', parse_html: true});
		expect(m.entries.map((e) => e.entry_id)).toEqual(['a']);
		expect(notices).toEqual(['bold']);
	});

	it('ignores a re-delivered entry (e.g. around a reconnect sync)', () => {
		const m = makeManager();
		m.onNotification(entry('a', 1));
		m.onNotification(entry('a', 1));
		expect(m.entries).toHaveLength(1);
		expect(notices).toHaveLength(1);
	});

	it('ignores a malformed entry', () => {
		const m = makeManager();
		m.onNotification({nope: true});
		expect(m.entries).toHaveLength(0);
		expect(notices).toEqual([]);
	});
});

describe('InboxManager read state', () => {
	it('shows entries newest first', async () => {
		const m = makeManager();
		await m.fetchInitial(fakeRedis([entry('a', 1), entry('b', 2), entry('c', 3)]));
		expect(m.visibleEntries().map((e) => e.entry_id)).toEqual(['c', 'b', 'a']);
	});

	it('counts everything as unread before anything is read', async () => {
		const m = makeManager();
		await m.fetchInitial(fakeRedis([entry('a', 1), entry('b', 2)]));
		expect(m.unreadCount()).toBe(2);
	});

	it('markAllRead zeroes the unread count without hiding entries', async () => {
		const m = makeManager();
		await m.fetchInitial(fakeRedis([entry('a', 1), entry('b', 2)]));
		m.markAllRead();
		expect(m.unreadCount()).toBe(0);
		expect(m.visibleEntries()).toHaveLength(2);
	});

	it('counts an entry that arrives after markAllRead', async () => {
		const m = makeManager();
		await m.fetchInitial(fakeRedis([entry('a', 1)]));
		m.markAllRead();
		m.onNotification(entry('b', 2));
		expect(m.unreadCount()).toBe(1);
	});

	it('clear hides the current entries but keeps later ones visible', async () => {
		const m = makeManager();
		await m.fetchInitial(fakeRedis([entry('a', 1), entry('b', 2)]));
		m.clear();
		expect(m.visibleEntries()).toHaveLength(0);
		m.onNotification(entry('c', 3));
		expect(m.visibleEntries().map((e) => e.entry_id)).toEqual(['c']);
		expect(m.unreadCount()).toBe(1);
	});

	it('treats cleared entries as read too', async () => {
		const m = makeManager();
		await m.fetchInitial(fakeRedis([entry('a', 1), entry('b', 2)]));
		m.clear();
		expect(m.unreadCount()).toBe(0);
	});

	it('markAllRead and clear are no-ops on an empty inbox', () => {
		const m = makeManager();
		expect(() => {
			m.markAllRead();
			m.clear();
		}).not.toThrow();
		expect(m.unreadCount()).toBe(0);
	});

	it('persists read state across instances on the same device', async () => {
		const storage = new FakeLocalStorage();
		const first = makeManager(makePlugin(storage));
		await first.fetchInitial(fakeRedis([entry('a', 1), entry('b', 2)]));
		first.markAllRead();

		// A fresh manager (e.g. after a reload) reads the saved markers back.
		const second = makeManager(makePlugin(storage));
		await second.fetchInitial(fakeRedis([entry('a', 1), entry('b', 2)]));
		expect(second.unreadCount()).toBe(0);
	});

	it('falls back to defaults when the stored state is corrupt', async () => {
		const storage = new FakeLocalStorage();
		storage.saveLocalStorage('spanreed-inbox-read:test', '{not json');
		const m = makeManager(makePlugin(storage));
		await m.fetchInitial(fakeRedis([entry('a', 1)]));
		expect(m.unreadCount()).toBe(1);
	});
});
