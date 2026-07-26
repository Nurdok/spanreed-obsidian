import {App, Modal, TFile} from 'obsidian';
import {Buffer} from "node:buffer"
import type SpanreedPlugin from "./main";

type SpanreedMonitorEvent =
	{ user: number } & ({ kind: 'watchdog' } | { kind: 'error', message: string });

interface SpanreedRpcRequest {
	request_id: string;
	method: string;
	params: any;
}

interface ModifyPropertyParams {
	filepath: string;
	property: string;
	operation: string;
	value: any;
}

interface QueryDataviewParams {
	query: string;
}

interface ReadFileParams {
	filepath: string;
	format: "text" | "binary";
}

interface WriteFileParams {
	filepath: string;
	format: "text" | "binary";
	content: string;
	overwrite: boolean;
}

interface ListDirParams {
	dirpath: string;
}

interface MoveFileParams {
	from: string;
	to: string
}

interface DeleteFileParams {
	filepath: string;
}

interface AppendToNoteParams {
	filepath: string;
	content: string;
	// When set, the content is inserted at the end of the section under the
	// heading with this text (of any level). The heading is created at the end
	// of the note if it doesn't exist yet. When absent/empty, the content is
	// appended to the end of the note.
	heading?: string | null;
}

interface SpanreedRpcResponse {
	success: boolean;
	result: any;
}

interface QueryDataviewResult {
}

// The vault-RPC agent: serves spanreed's vault RPCs over the legacy
// obsidian-plugin-tasks:* queues and feeds the obsidian-plugin-monitor:*
// watchdog. Moved verbatim from the pre-restructure main.ts; only the
// `this.`-references were adapted (plugin/app/redis manager).
export class VaultRpcAgent {
	plugin: SpanreedPlugin;

	constructor(plugin: SpanreedPlugin) {
		this.plugin = plugin;
	}

	get app(): App {
		return this.plugin.app;
	}

	getFile(filepath: string): TFile | undefined {
		for (let file of this.app.vault.getFiles()) {
			if (file.path == filepath) {
				return file
			}
		}
		return undefined
	}

	async handleCommandGenerateDailyNote(): Promise<SpanreedRpcResponse> {
		console.log("generating daily note");
		// `commands` isn't in the public API types, but exists at runtime.
		(this.app as any).commands.executeCommandById("daily-notes");
		return {"success": true, "result": null};
	}

	async handleCommandModifyProperty(params: ModifyPropertyParams): Promise<SpanreedRpcResponse> {
		let filepath: string = params.filepath;
		let tfile: TFile | undefined = this.getFile(filepath)
		if (tfile === undefined) {
			return {"success": false, "result": "file not found"};
		}
		const property = params.property;
		// `processFrontMatter` ignores its callback's return value, so results
		// must be captured out-of-band and returned after the switch.
		let response: SpanreedRpcResponse = {"success": true, "result": null};
		switch (params.operation) {
			case "addToList":
				await this.app.fileManager.processFrontMatter(tfile, (frontmatter) => {
					// An empty `property:` line parses as YAML null; treat it
					// like a missing property. Real scalar values still error
					// below rather than being silently clobbered.
					if (typeof (frontmatter[property]) === "undefined"
						|| frontmatter[property] === null) {
						frontmatter[property] = [];
					}
					if (!Array.isArray(frontmatter[property])) {
						response = {"success": false, "result": "property is not a list"};
						return;
					}
					if (frontmatter[property].indexOf(params.value) <= -1) {
						frontmatter[property].push(params.value);
					}
				});
				break;
			case "removeFromList":
				await this.app.fileManager.processFrontMatter(tfile, (frontmatter) => {
					if (typeof (frontmatter[property]) === "undefined") {
						response = {"success": false, "result": "property does not exist"};
						return;
					}
					if (!Array.isArray(frontmatter[property])) {
						response = {"success": false, "result": "property is not a list"};
						return;
					}
					let index = frontmatter[property].indexOf(params.value);
					if (index > -1) {
						frontmatter[property].splice(index, 1);
					}
				});
				break;
			case "setSingleValue":
				await this.app.fileManager.processFrontMatter(tfile, (frontmatter) => {
					frontmatter[property] = params.value;
				});
				break;
			case "deleteProperty":
				await this.app.fileManager.processFrontMatter(tfile, (frontmatter) => {
					delete frontmatter[property];
				});
				break;
			case "getProperty":
				// TODO: there's a better API for this, but I CBA right now
				await this.app.fileManager.processFrontMatter(tfile, (frontmatter) => {
					let value = frontmatter[property];
					if (typeof (value) === "undefined") {
						value = null;
					}
					response = {"success": true, "result": value};
				});
				break;
			default:
				response = {"success": false, "result": 'unknown modify-property operation'};
		}
		return response;
	}

	async handleCommandQueryDataview({query}: QueryDataviewParams): Promise<SpanreedRpcResponse> {
		// `plugins` isn't in the public API types, but exists at runtime.
		const dv = (this.app as any).plugins.plugins.dataview.api;
		return dv.tryQuery(query)
			.then((result: any) => {
				return {"success": true, "result": result};
			})
			.catch((e: Error) => {
				return {"success": false, "result": e.message};
			});
	}

	async handleCommandReadFile({filepath, format}: ReadFileParams): Promise<SpanreedRpcResponse> {
		let tfileToRead: TFile | undefined = this.getFile(filepath)
		if (tfileToRead === undefined) {
			return {"success": false, "result": "file not found"};
		}
		let content: string
		let encoding: string
		if (format === 'binary') {
			const buff: Buffer = Buffer.from(await this.app.vault.readBinary(tfileToRead))
			content = buff.toString('base64')
			encoding = 'base64'
		} else {
			content = await this.app.vault.read(tfileToRead)
			encoding = 'utf-8'
		}
		return {"success": true, "result": {content, encoding}}
	}

	async ensureParentFolderExists(filepath: string): Promise<void> {
		const lastSlash = filepath.lastIndexOf('/');
		if (lastSlash <= 0) {
			// File lives at the vault root; no folder to create.
			return;
		}
		// Create each missing folder along the path, parents first.
		const parts = filepath.substring(0, lastSlash).split('/');
		let current = '';
		for (const part of parts) {
			current = current === '' ? part : `${current}/${part}`;
			if (this.app.vault.getAbstractFileByPath(current) === null) {
				await this.app.vault.createFolder(current);
			}
		}
	}

	async handleCommandWriteFile({filepath, format, content, overwrite}: WriteFileParams): Promise<SpanreedRpcResponse> {
		const existing: TFile | undefined = this.getFile(filepath)
		if (existing !== undefined && !overwrite) {
			return {"success": false, "result": "Destination file already exists"};
		}
		await this.ensureParentFolderExists(filepath);
		if (format === 'binary') {
			// `content` is base64; hand Obsidian a plain ArrayBuffer.
			const data: ArrayBuffer = Uint8Array.from(Buffer.from(content, 'base64')).buffer;
			if (existing !== undefined) {
				await this.app.vault.modifyBinary(existing, data);
			} else {
				await this.app.vault.createBinary(filepath, data);
			}
		} else {
			if (existing !== undefined) {
				await this.app.vault.modify(existing, content);
			} else {
				await this.app.vault.create(filepath, content);
			}
		}
		return {"success": true, "result": null}
	}

	async handleCommandListDir({dirpath}: ListDirParams): Promise<SpanreedRpcResponse> {
		const filepaths: string[] = []
		for (let file of this.app.vault.getFiles()) {
			if (file.path.startsWith(dirpath)) {
				filepaths.push(file.path)
			}
		}
		return {"success": true, "result": filepaths}
	}

	async handleCommandMoveFile({from, to}: MoveFileParams): Promise<SpanreedRpcResponse> {
		const fromfile: TFile | undefined = this.getFile(from)
		if (fromfile === undefined) {
			return {"success": false, "result": `File ${from} doesn't exist`}
		}
		await this.app.vault.rename(fromfile, to)
		return {"success": true, "result": null}
	}

	async handleCommandDeleteFile({filepath}: DeleteFileParams): Promise<SpanreedRpcResponse> {
		const tfile: TFile | undefined = this.getFile(filepath)
		if (tfile === undefined) {
			return {"success": false, "result": "file not found"}
		}
		// Permanently delete the file (not recoverable). Use `vault.trash` if a
		// recoverable delete is ever wanted instead.
		await this.app.vault.delete(tfile)
		return {"success": true, "result": null}
	}

	// Insert `content` at the end of the section under the heading whose text
	// matches `heading` (any level, case-insensitive). If no such heading
	// exists, the heading is created (as an H2) at the end of the note with the
	// content beneath it. Returns the full new note body.
	insertUnderHeading(existing: string, heading: string, content: string): string {
		const headingRegex = /^(#{1,6})\s+(.*?)\s*$/;
		const target = heading.replace(/^#+\s*/, "").trim().toLowerCase();
		const body = content.replace(/^\n+/, "").replace(/\n+$/, "");
		const lines = existing.split("\n");

		let headingIndex = -1;
		let headingLevel = 0;
		for (let i = 0; i < lines.length; i++) {
			const m = lines[i].match(headingRegex);
			if (m && m[2].trim().toLowerCase() === target) {
				headingIndex = i;
				headingLevel = m[1].length;
				break;
			}
		}

		if (headingIndex === -1) {
			// Heading not found: append it (and the content) to the end.
			let prefix = existing.replace(/\n+$/, "");
			const title = heading.replace(/^#+\s*/, "").trim();
			const parts = prefix.length > 0 ? [prefix, ""] : [];
			return [...parts, `## ${title}`, "", body, ""].join("\n");
		}

		// The section runs until the next heading of the same or higher level.
		let sectionEnd = lines.length;
		for (let i = headingIndex + 1; i < lines.length; i++) {
			const m = lines[i].match(headingRegex);
			if (m && m[1].length <= headingLevel) {
				sectionEnd = i;
				break;
			}
		}

		// Insert after the section's existing content, trimming trailing blank
		// lines so the spacing stays tidy.
		let insertAt = sectionEnd;
		while (insertAt > headingIndex + 1 && lines[insertAt - 1].trim() === "") {
			insertAt--;
		}

		const before = lines.slice(0, insertAt);
		// Drop the blank lines that separated the section from what follows; we
		// re-add exactly one so spacing stays consistent.
		const after = lines.slice(insertAt);
		while (after.length > 0 && after[0].trim() === "") {
			after.shift();
		}
		return [...before, "", body, ...(after.length > 0 ? ["", ...after] : [""])].join("\n");
	}

	async handleCommandAppendToNote({filepath, content, heading}: AppendToNoteParams): Promise<SpanreedRpcResponse> {
		const tfile: TFile | undefined = this.getFile(filepath);
		const existing: string = tfile === undefined ? "" : await this.app.vault.read(tfile);

		let newBody: string;
		if (heading !== undefined && heading !== null && heading.trim() !== "") {
			newBody = this.insertUnderHeading(existing, heading, content);
		} else {
			newBody = existing + content;
		}

		if (tfile === undefined) {
			await this.ensureParentFolderExists(filepath);
			await this.app.vault.create(filepath, newBody);
		} else {
			await this.app.vault.modify(tfile, newBody);
		}
		return {"success": true, "result": null};
	}

	// Single source of truth for the supported RPC methods. The Redis dispatch
	// and the "Show supported API commands" palette command both read from
	// here, so the advertised command list can never drift from what's really
	// wired up.
	getMethodHandlers(): Record<string, (params: any) => Promise<SpanreedRpcResponse>> {
		return {
			"generate-daily-note": () => this.handleCommandGenerateDailyNote(),
			"modify-property": (params) => this.handleCommandModifyProperty(params),
			"query-dataview": (params) => this.handleCommandQueryDataview(params),
			"read-file": (params) => this.handleCommandReadFile(params),
			"write-file": (params) => this.handleCommandWriteFile(params),
			"list-dir": (params) => this.handleCommandListDir(params),
			"move-file": (params) => this.handleCommandMoveFile(params),
			"delete-file": (params) => this.handleCommandDeleteFile(params),
			"append-to-note": (params) => this.handleCommandAppendToNote(params),
		};
	}

	getSupportedMethods(): string[] {
		return Object.keys(this.getMethodHandlers());
	}

	async handleSpanreedRequest(request: SpanreedRpcRequest): Promise<SpanreedRpcResponse> {
		const handler = this.getMethodHandlers()[request.method];
		if (handler === undefined) {
			return {"success": false, "result": `unknown method ${request.method}`};
		}
		try {
			return await handler(request.params);
		} catch (e) {
			return {"success": false, "result": `Request ${request.method} failed: ${e}`};
		}
	}

	async sendRedisErrorToSpanreedMonitor(message: string) {
		const spanreedUserId = this.plugin.getActiveConnectionSettings().spanreedUserId;
		const monitorQueue = `obsidian-plugin-monitor:${spanreedUserId}`
		const redisClient = await this.plugin.redis.ensureRpcClient();
		await redisClient.lPush(monitorQueue, JSON.stringify({
			user: spanreedUserId,
			kind: 'error',
			message: message
		}));
	}

	async sendSpanreedWatchdogEvent() {
		const spanreedUserId = this.plugin.getActiveConnectionSettings().spanreedUserId;
		const monitorQueue = `obsidian-plugin-monitor:${spanreedUserId}`
		const redisClient = await this.plugin.redis.ensureRpcClient();
		await redisClient.lPush(monitorQueue, JSON.stringify({user: spanreedUserId, kind: 'watchdog'}));
	}

	async pollRedisTaskMessageQueue() {
		// Reschedule after this delay (ms). 0 keeps polling promptly on the
		// happy path (blPop already blocks up to 60s); on failure or when
		// unconfigured we back off so we never busy-loop and hang Obsidian.
		let rescheduleDelay = 0;

		const settings = this.plugin.getActiveConnectionSettings();
		if (settings.spanreedUserId === -1 || settings.redisUrl === "") {
			// Not configured yet (e.g. fresh install with no data.json).
			// Don't attempt to connect; just check back periodically.
			this.plugin.registerInterval(window.setTimeout(() => this.pollRedisTaskMessageQueue(), 5000));
			return;
		}

		try {
			const redisClient = await this.plugin.redis.ensureRpcClient()
			await this.sendSpanreedWatchdogEvent()
			console.log("polling redis task message queue")

			const spanreedUserId = settings.spanreedUserId;
			const taskQueue = `obsidian-plugin-tasks:${spanreedUserId}`;

			console.log("Waiting on queue", taskQueue)

			await redisClient.blPop(taskQueue, 60 /* timeout, in seconds */)
				.then(async (res) => {
					if (res === null) {
						return;
					}
					let request: SpanreedRpcRequest = JSON.parse(res.element);
					console.log("got request", request)
					let response: SpanreedRpcResponse = await this.handleSpanreedRequest(request);
					console.log("sending response", response)
					let responseQueue = `obsidian-plugin-tasks:${spanreedUserId}:${request.request_id}`;
					await redisClient.lPush(responseQueue, JSON.stringify(response));
				});
			console.log("done polling redis task message queue")
		} catch (e) {
			console.log("error polling redis task message queue", e)
			// Back off before retrying so a persistent failure (e.g. Redis
			// unreachable) doesn't spin.
			rescheduleDelay = 5000;
		} finally {
			this.plugin.registerInterval(window.setTimeout(() => this.pollRedisTaskMessageQueue(), rescheduleDelay));
		}
	}
}

export class SpanreedApiCommandsModal extends Modal {
	plugin: SpanreedPlugin;

	constructor(app: App, plugin: SpanreedPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.empty();

		contentEl.createEl('h2', {text: 'Spanreed API'});
		contentEl.createEl('p', {
			text: `Plugin version: ${this.plugin.manifest.version}`,
		});

		const methods = this.plugin.vaultRpc.getSupportedMethods();
		contentEl.createEl('p', {
			text: `Supported API commands (${methods.length}):`,
		});
		const list = contentEl.createEl('ul');
		for (const method of methods) {
			list.createEl('li', {text: method});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
