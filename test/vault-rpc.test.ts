import {beforeEach, describe, expect, it, vi} from 'vitest';
import {VaultRpcAgent} from '../src/vault-rpc';

// The daily-note helpers talk to the real Obsidian core plugin, so they are
// mocked wholesale. vi.mock is hoisted above the imports, hence vi.hoisted.
const dailyNotes = vi.hoisted(() => ({
	createDailyNote: vi.fn(),
	getDailyNote: vi.fn(),
	getAllDailyNotes: vi.fn(),
}));
vi.mock('obsidian-daily-notes-interface', () => dailyNotes);

interface FakeFile {
	path: string;
}

// In-memory stand-in for the bits of the Obsidian vault the RPCs touch.
class FakeVault {
	texts: Map<string, string> = new Map();
	binaries: Map<string, Uint8Array> = new Map();
	folders: Set<string> = new Set();
	frontmatter: Map<string, Record<string, any>> = new Map();

	getFiles(): FakeFile[] {
		const paths = new Set([...this.texts.keys(), ...this.binaries.keys()]);
		return Array.from(paths).map((path) => ({path}));
	}

	getAbstractFileByPath(path: string): unknown {
		if (this.folders.has(path)) {
			return {path};
		}
		if (this.texts.has(path) || this.binaries.has(path)) {
			return {path};
		}
		return null;
	}

	async createFolder(path: string): Promise<void> {
		this.folders.add(path);
	}

	async read(file: FakeFile): Promise<string> {
		return this.texts.get(file.path) ?? "";
	}

	async create(path: string, content: string): Promise<void> {
		this.texts.set(path, content);
	}

	async modify(file: FakeFile, content: string): Promise<void> {
		this.texts.set(file.path, content);
	}

	async readBinary(file: FakeFile): Promise<ArrayBuffer> {
		const data = this.binaries.get(file.path) ?? new Uint8Array();
		return Uint8Array.from(data).buffer;
	}

	async createBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.binaries.set(path, new Uint8Array(data));
	}

	async modifyBinary(file: FakeFile, data: ArrayBuffer): Promise<void> {
		this.binaries.set(file.path, new Uint8Array(data));
	}

	async rename(file: FakeFile, to: string): Promise<void> {
		const text = this.texts.get(file.path);
		if (text !== undefined) {
			this.texts.delete(file.path);
			this.texts.set(to, text);
		}
		const bin = this.binaries.get(file.path);
		if (bin !== undefined) {
			this.binaries.delete(file.path);
			this.binaries.set(to, bin);
		}
	}

	async delete(file: FakeFile): Promise<void> {
		this.texts.delete(file.path);
		this.binaries.delete(file.path);
	}
}

function makeAgent(files: Record<string, string> = {}) {
	const vault = new FakeVault();
	for (const [path, content] of Object.entries(files)) {
		vault.texts.set(path, content);
	}
	// Spies for the two ways the old implementation could yank the UI around.
	const executeCommandById = vi.fn();
	const openLinkText = vi.fn();
	const getLeaf = vi.fn();
	const app = {
		vault,
		commands: {executeCommandById, removeCommand: vi.fn()},
		workspace: {openLinkText, getLeaf, getActiveFile: vi.fn()},
		fileManager: {
			async processFrontMatter(file: FakeFile, cb: (fm: Record<string, any>) => void) {
				const fm = vault.frontmatter.get(file.path) ?? {};
				cb(fm);
				vault.frontmatter.set(file.path, fm);
			},
		},
	};
	const agent = new VaultRpcAgent({app} as never);
	return {agent, vault, app, executeCommandById, openLinkText, getLeaf};
}

beforeEach(() => {
	vi.clearAllMocks();
	dailyNotes.getAllDailyNotes.mockReturnValue({});
});

describe('generate-daily-note', () => {
	it('creates today\'s note when it does not exist yet', async () => {
		dailyNotes.getDailyNote.mockReturnValue(null);
		const {agent} = makeAgent();

		const res = await agent.handleCommandGenerateDailyNote();

		expect(res).toEqual({success: true, result: null});
		expect(dailyNotes.createDailyNote).toHaveBeenCalledTimes(1);
	});

	it('leaves an existing note alone, so the RPC is idempotent', async () => {
		dailyNotes.getDailyNote.mockReturnValue({path: 'Daily/2026-08-15.md'});
		const {agent} = makeAgent();

		const res = await agent.handleCommandGenerateDailyNote();

		expect(res).toEqual({success: true, result: null});
		expect(dailyNotes.createDailyNote).not.toHaveBeenCalled();
	});

	// The point of the change: generating the note must not steal the UI.
	it('never opens the note in the UI', async () => {
		dailyNotes.getDailyNote.mockReturnValue(null);
		const {agent, executeCommandById, openLinkText, getLeaf} = makeAgent();

		await agent.handleCommandGenerateDailyNote();

		expect(executeCommandById).not.toHaveBeenCalled();
		expect(openLinkText).not.toHaveBeenCalled();
		expect(getLeaf).not.toHaveBeenCalled();
	});

	it('asks for today when looking the note up', async () => {
		dailyNotes.getDailyNote.mockReturnValue(null);
		const {agent} = makeAgent();

		await agent.handleCommandGenerateDailyNote();

		const [date] = dailyNotes.getDailyNote.mock.calls[0];
		expect((date as any).isSame(new Date(), 'day')).toBe(true);
	});
});

describe('method registry', () => {
	it('advertises exactly the wired-up handlers', () => {
		const {agent} = makeAgent();
		expect(agent.getSupportedMethods()).toEqual(Object.keys(agent.getMethodHandlers()));
		expect(agent.getSupportedMethods()).toContain('generate-daily-note');
	});
});

describe('modify-property', () => {
	it('fails when the file is missing', async () => {
		const {agent} = makeAgent();
		const res = await agent.handleCommandModifyProperty({
			filepath: 'nope.md', property: 'tags', operation: 'addToList', value: 'x',
		});
		expect(res).toEqual({success: false, result: 'file not found'});
	});

	it('rejects an unknown operation', async () => {
		const {agent} = makeAgent({'a.md': ''});
		const res = await agent.handleCommandModifyProperty({
			filepath: 'a.md', property: 'tags', operation: 'frobnicate', value: 'x',
		});
		expect(res).toEqual({success: false, result: 'unknown modify-property operation'});
	});

	describe('addToList', () => {
		it('creates the list when the property is missing', async () => {
			const {agent, vault} = makeAgent({'a.md': ''});
			const res = await agent.handleCommandModifyProperty({
				filepath: 'a.md', property: 'tags', operation: 'addToList', value: 'x',
			});
			expect(res.success).toBe(true);
			expect(vault.frontmatter.get('a.md')).toEqual({tags: ['x']});
		});

		// An empty `tags:` line parses as YAML null; it must behave like a
		// missing property rather than erroring.
		it('treats a null property like a missing one', async () => {
			const {agent, vault} = makeAgent({'a.md': ''});
			vault.frontmatter.set('a.md', {tags: null});
			const res = await agent.handleCommandModifyProperty({
				filepath: 'a.md', property: 'tags', operation: 'addToList', value: 'x',
			});
			expect(res.success).toBe(true);
			expect(vault.frontmatter.get('a.md')).toEqual({tags: ['x']});
		});

		it('appends to an existing list', async () => {
			const {agent, vault} = makeAgent({'a.md': ''});
			vault.frontmatter.set('a.md', {tags: ['a']});
			await agent.handleCommandModifyProperty({
				filepath: 'a.md', property: 'tags', operation: 'addToList', value: 'b',
			});
			expect(vault.frontmatter.get('a.md')).toEqual({tags: ['a', 'b']});
		});

		it('does not add a duplicate', async () => {
			const {agent, vault} = makeAgent({'a.md': ''});
			vault.frontmatter.set('a.md', {tags: ['a']});
			await agent.handleCommandModifyProperty({
				filepath: 'a.md', property: 'tags', operation: 'addToList', value: 'a',
			});
			expect(vault.frontmatter.get('a.md')).toEqual({tags: ['a']});
		});

		it('refuses to clobber a scalar', async () => {
			const {agent, vault} = makeAgent({'a.md': ''});
			vault.frontmatter.set('a.md', {tags: 'scalar'});
			const res = await agent.handleCommandModifyProperty({
				filepath: 'a.md', property: 'tags', operation: 'addToList', value: 'x',
			});
			expect(res).toEqual({success: false, result: 'property is not a list'});
			expect(vault.frontmatter.get('a.md')).toEqual({tags: 'scalar'});
		});
	});

	describe('removeFromList', () => {
		it('removes a present value', async () => {
			const {agent, vault} = makeAgent({'a.md': ''});
			vault.frontmatter.set('a.md', {tags: ['a', 'b']});
			await agent.handleCommandModifyProperty({
				filepath: 'a.md', property: 'tags', operation: 'removeFromList', value: 'a',
			});
			expect(vault.frontmatter.get('a.md')).toEqual({tags: ['b']});
		});

		it('is a no-op for a value that is not there', async () => {
			const {agent, vault} = makeAgent({'a.md': ''});
			vault.frontmatter.set('a.md', {tags: ['a']});
			const res = await agent.handleCommandModifyProperty({
				filepath: 'a.md', property: 'tags', operation: 'removeFromList', value: 'zzz',
			});
			expect(res.success).toBe(true);
			expect(vault.frontmatter.get('a.md')).toEqual({tags: ['a']});
		});

		it('fails when the property does not exist', async () => {
			const {agent} = makeAgent({'a.md': ''});
			const res = await agent.handleCommandModifyProperty({
				filepath: 'a.md', property: 'tags', operation: 'removeFromList', value: 'x',
			});
			expect(res).toEqual({success: false, result: 'property does not exist'});
		});

		it('succeeds with nothing to do on a null property', async () => {
			const {agent, vault} = makeAgent({'a.md': ''});
			vault.frontmatter.set('a.md', {tags: null});
			const res = await agent.handleCommandModifyProperty({
				filepath: 'a.md', property: 'tags', operation: 'removeFromList', value: 'x',
			});
			expect(res).toEqual({success: true, result: null});
			expect(vault.frontmatter.get('a.md')).toEqual({tags: null});
		});

		it('refuses a scalar', async () => {
			const {agent, vault} = makeAgent({'a.md': ''});
			vault.frontmatter.set('a.md', {tags: 'scalar'});
			const res = await agent.handleCommandModifyProperty({
				filepath: 'a.md', property: 'tags', operation: 'removeFromList', value: 'x',
			});
			expect(res).toEqual({success: false, result: 'property is not a list'});
		});
	});

	it('setSingleValue overwrites whatever was there', async () => {
		const {agent, vault} = makeAgent({'a.md': ''});
		vault.frontmatter.set('a.md', {status: 'old'});
		await agent.handleCommandModifyProperty({
			filepath: 'a.md', property: 'status', operation: 'setSingleValue', value: 'new',
		});
		expect(vault.frontmatter.get('a.md')).toEqual({status: 'new'});
	});

	it('deleteProperty removes the key entirely', async () => {
		const {agent, vault} = makeAgent({'a.md': ''});
		vault.frontmatter.set('a.md', {status: 'x', keep: 'y'});
		await agent.handleCommandModifyProperty({
			filepath: 'a.md', property: 'status', operation: 'deleteProperty', value: null,
		});
		expect(vault.frontmatter.get('a.md')).toEqual({keep: 'y'});
	});

	it('getProperty returns the value, or null when absent', async () => {
		const {agent, vault} = makeAgent({'a.md': ''});
		vault.frontmatter.set('a.md', {status: 'x'});
		expect(await agent.handleCommandModifyProperty({
			filepath: 'a.md', property: 'status', operation: 'getProperty', value: null,
		})).toEqual({success: true, result: 'x'});
		expect(await agent.handleCommandModifyProperty({
			filepath: 'a.md', property: 'missing', operation: 'getProperty', value: null,
		})).toEqual({success: true, result: null});
	});
});

describe('insertUnderHeading', () => {
	it('appends a new H2 section when the heading is absent', () => {
		const {agent} = makeAgent();
		expect(agent.insertUnderHeading('# Note\n\nbody', 'Log', 'entry'))
			.toBe('# Note\n\nbody\n\n## Log\n\nentry\n');
	});

	it('creates the section in an empty note without leading blanks', () => {
		const {agent} = makeAgent();
		expect(agent.insertUnderHeading('', 'Log', 'entry')).toBe('## Log\n\nentry\n');
	});

	it('appends at the end of an existing section', () => {
		const {agent} = makeAgent();
		expect(agent.insertUnderHeading('## Log\n\nold', 'Log', 'new'))
			.toBe('## Log\n\nold\n\nnew\n');
	});

	it('inserts before the next same-level heading, not at the note end', () => {
		const {agent} = makeAgent();
		expect(agent.insertUnderHeading('## Log\n\nold\n\n## Other\n\nx', 'Log', 'new'))
			.toBe('## Log\n\nold\n\nnew\n\n## Other\n\nx');
	});

	it('treats a deeper subheading as part of the section', () => {
		const {agent} = makeAgent();
		expect(agent.insertUnderHeading('## Log\n\n### Sub\n\nx\n\n## Other', 'Log', 'new'))
			.toBe('## Log\n\n### Sub\n\nx\n\nnew\n\n## Other');
	});

	it('matches the heading case-insensitively and at any level', () => {
		const {agent} = makeAgent();
		expect(agent.insertUnderHeading('# LOG\n\nold', 'log', 'new'))
			.toBe('# LOG\n\nold\n\nnew\n');
	});

	it('accepts a heading passed with its #s', () => {
		const {agent} = makeAgent();
		expect(agent.insertUnderHeading('## Log\n\nold', '## Log', 'new'))
			.toBe('## Log\n\nold\n\nnew\n');
	});

	it('trims blank padding around the inserted content', () => {
		const {agent} = makeAgent();
		expect(agent.insertUnderHeading('## Log\n\nold\n\n\n', 'Log', '\n\nnew\n\n'))
			.toBe('## Log\n\nold\n\nnew\n');
	});
});

describe('append-to-note', () => {
	it('appends verbatim when no heading is given', async () => {
		const {agent, vault} = makeAgent({'a.md': 'body'});
		const res = await agent.handleCommandAppendToNote({filepath: 'a.md', content: '\nmore'});
		expect(res).toEqual({success: true, result: null});
		expect(vault.texts.get('a.md')).toBe('body\nmore');
	});

	it('creates the note (and its folders) when it does not exist', async () => {
		const {agent, vault} = makeAgent();
		await agent.handleCommandAppendToNote({filepath: 'deep/nested/a.md', content: 'hi'});
		expect(vault.texts.get('deep/nested/a.md')).toBe('hi');
		expect(Array.from(vault.folders)).toEqual(['deep', 'deep/nested']);
	});

	it('routes through insertUnderHeading when a heading is given', async () => {
		const {agent, vault} = makeAgent({'a.md': '## Log\n\nold'});
		await agent.handleCommandAppendToNote({filepath: 'a.md', content: 'new', heading: 'Log'});
		expect(vault.texts.get('a.md')).toBe('## Log\n\nold\n\nnew\n');
	});

	it('treats a blank heading as no heading', async () => {
		const {agent, vault} = makeAgent({'a.md': 'body'});
		await agent.handleCommandAppendToNote({filepath: 'a.md', content: '!', heading: '   '});
		expect(vault.texts.get('a.md')).toBe('body!');
	});
});

describe('read-file / write-file', () => {
	it('reads text as utf-8', async () => {
		const {agent} = makeAgent({'a.md': 'hello'});
		expect(await agent.handleCommandReadFile({filepath: 'a.md', format: 'text'}))
			.toEqual({success: true, result: {content: 'hello', encoding: 'utf-8'}});
	});

	it('reads binary as base64', async () => {
		const {agent, vault} = makeAgent();
		vault.binaries.set('a.bin', new Uint8Array([1, 2, 3]));
		const res = await agent.handleCommandReadFile({filepath: 'a.bin', format: 'binary'});
		expect(res).toEqual({
			success: true,
			result: {content: Buffer.from([1, 2, 3]).toString('base64'), encoding: 'base64'},
		});
	});

	it('fails to read a missing file', async () => {
		const {agent} = makeAgent();
		expect(await agent.handleCommandReadFile({filepath: 'nope.md', format: 'text'}))
			.toEqual({success: false, result: 'file not found'});
	});

	it('refuses to overwrite unless asked', async () => {
		const {agent, vault} = makeAgent({'a.md': 'original'});
		const res = await agent.handleCommandWriteFile({
			filepath: 'a.md', format: 'text', content: 'new', overwrite: false,
		});
		expect(res).toEqual({success: false, result: 'Destination file already exists'});
		expect(vault.texts.get('a.md')).toBe('original');
	});

	it('overwrites when asked', async () => {
		const {agent, vault} = makeAgent({'a.md': 'original'});
		const res = await agent.handleCommandWriteFile({
			filepath: 'a.md', format: 'text', content: 'new', overwrite: true,
		});
		expect(res.success).toBe(true);
		expect(vault.texts.get('a.md')).toBe('new');
	});

	it('creates missing parent folders, parents first', async () => {
		const {agent, vault} = makeAgent();
		await agent.handleCommandWriteFile({
			filepath: 'a/b/c/note.md', format: 'text', content: 'x', overwrite: false,
		});
		expect(Array.from(vault.folders)).toEqual(['a', 'a/b', 'a/b/c']);
		expect(vault.texts.get('a/b/c/note.md')).toBe('x');
	});

	it('does not create a folder for a vault-root file', async () => {
		const {agent, vault} = makeAgent();
		await agent.handleCommandWriteFile({
			filepath: 'note.md', format: 'text', content: 'x', overwrite: false,
		});
		expect(Array.from(vault.folders)).toEqual([]);
	});

	it('round-trips binary content through base64', async () => {
		const {agent, vault} = makeAgent();
		const bytes = Buffer.from([0, 255, 16]);
		await agent.handleCommandWriteFile({
			filepath: 'a.bin', format: 'binary', content: bytes.toString('base64'), overwrite: false,
		});
		expect(Array.from(vault.binaries.get('a.bin') ?? [])).toEqual([0, 255, 16]);
	});
});

describe('list-dir / move-file / delete-file', () => {
	it('lists the files under a prefix', async () => {
		const {agent} = makeAgent({'d/a.md': '', 'd/sub/b.md': '', 'other/c.md': ''});
		const res = await agent.handleCommandListDir({dirpath: 'd/'});
		expect((res.result as string[]).sort()).toEqual(['d/a.md', 'd/sub/b.md']);
	});

	it('moves a file', async () => {
		const {agent, vault} = makeAgent({'a.md': 'x'});
		const res = await agent.handleCommandMoveFile({from: 'a.md', to: 'b.md'});
		expect(res).toEqual({success: true, result: null});
		expect(vault.texts.has('a.md')).toBe(false);
		expect(vault.texts.get('b.md')).toBe('x');
	});

	it('fails to move a missing file', async () => {
		const {agent} = makeAgent();
		expect(await agent.handleCommandMoveFile({from: 'nope.md', to: 'b.md'}))
			.toEqual({success: false, result: "File nope.md doesn't exist"});
	});

	it('deletes a file', async () => {
		const {agent, vault} = makeAgent({'a.md': 'x'});
		expect(await agent.handleCommandDeleteFile({filepath: 'a.md'}))
			.toEqual({success: true, result: null});
		expect(vault.texts.has('a.md')).toBe(false);
	});

	it('fails to delete a missing file', async () => {
		const {agent} = makeAgent();
		expect(await agent.handleCommandDeleteFile({filepath: 'nope.md'}))
			.toEqual({success: false, result: 'file not found'});
	});
});
