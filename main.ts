import {App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile} from 'obsidian';
import {createClient, RedisClientType} from "redis";
import {Buffer} from "node:buffer"


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

interface SpanreedRpcResponse {
	success: boolean;
	result: any;
}

interface QueryDataviewResult {
}

interface ConnectionSettings {
	spanreedUserId: number;
	redisUrl: string;
}

type Environment = 'production' | 'staging';

const toString = (env: Environment) => {
	return {
		'production': 'Production',
		'staging': 'Staging',
	}[env];
}

interface SpanreedSettings {
	connectionSettings: Record<Environment, ConnectionSettings>
	activeEnvironment: Environment
}

const DEFAULT_CONNECTION_SETTINGS: ConnectionSettings = {
	spanreedUserId: -1,
	redisUrl: "",
}

const DEFAULT_SETTINGS: SpanreedSettings = {
	connectionSettings: {
		production: DEFAULT_CONNECTION_SETTINGS,
		staging: DEFAULT_CONNECTION_SETTINGS,
	},
	activeEnvironment: 'production',
}

export default class SpanreedPlugin extends Plugin {
	settings: SpanreedSettings;
	redisClient: RedisClientType<any, any, any>;
	lastUsedRedisUrl?: string

	async onload() {
		await this.loadSettings();

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon('dice', 'Sample Plugin', (evt: MouseEvent) => {
			// Called when the user clicks the icon.
			new Notice('This is a notice!');
		});
		// Perform additional things with the ribbon
		ribbonIconEl.addClass('my-plugin-ribbon-class');

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Status Bar Text');

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SpanreedSettingsTab(this.app, this));

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setTimeout(() => this.pollRedisTaskMessageQueue(), 0));

		const connectionSettings = this.getActiveConnectionSettings()

		if (connectionSettings.spanreedUserId === -1) {
			new Notice("Please set your Spanreed user ID in the plugin settings.");
			return;
		}
		if (connectionSettings.redisUrl === "") {
			new Notice("Please set your Redis URL in the plugin settings.");
			return;
		}
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	getFile(filepath: string): TFile | undefined {
		for (let file of this.app.vault.getFiles()) {
			if (file.path == filepath) {
				return file
			}
		}
		return undefined
	}

	getActiveConnectionSettings(): ConnectionSettings {
		return this.settings.connectionSettings[this.settings.activeEnvironment];
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
					if (typeof (frontmatter[property]) === "undefined") {
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
		// Move to Obsidian's local `.trash` folder (recoverable) rather than
		// a hard delete. Pass `true` for the system/OS trash instead.
		await this.app.vault.trash(tfile, false)
		return {"success": true, "result": null}
	}

	async handleSpanreedRequest(request: SpanreedRpcRequest): Promise<SpanreedRpcResponse> {
		let response: SpanreedRpcResponse = {"success": false, "result": "unknown error"};
		try {
			switch (request.method) {
				case "generate-daily-note": {
					return await this.handleCommandGenerateDailyNote()
				}
				case "modify-property": {
					return await this.handleCommandModifyProperty(request.params);
				}
				case "query-dataview": {
					return await this.handleCommandQueryDataview(request.params);
				}
				case 'read-file': {
					return await this.handleCommandReadFile(request.params);
				}
				case 'write-file': {
					return await this.handleCommandWriteFile(request.params);
				}
				case 'list-dir': {
					return await this.handleCommandListDir(request.params);
				}
				case 'move-file':
					return await this.handleCommandMoveFile(request.params)
				case 'delete-file':
					return await this.handleCommandDeleteFile(request.params)
				default:
					return {"success": false, "result": `unknown method ${request.method}`};
			}
		} catch (e) {
			return {"success": false, "result": `Request ${request.method} failed: ${e}`};
		}
	}

	async createRedisClient(redisUrl: string) {
		this.redisClient = createClient({
			url: redisUrl
		});
		this.redisClient.on('error', (err) => {
			this.sendRedisErrorToSpanreedMonitor(err.message);
		});
		await this.redisClient.connect();
		this.lastUsedRedisUrl = redisUrl
	}

	async sendRedisErrorToSpanreedMonitor(message: string) {
		const spanreedUserId = this.getActiveConnectionSettings().spanreedUserId;
		const monitorQueue = `obsidian-plugin-monitor:${spanreedUserId}`
		await this.ensureRedisClient();
		await this.redisClient.lPush(monitorQueue, JSON.stringify({
			user: spanreedUserId,
			kind: 'error',
			message: message
		}));
	}

	async sendSpanreedWatchdogEvent() {
		const spanreedUserId = this.getActiveConnectionSettings().spanreedUserId;
		const monitorQueue = `obsidian-plugin-monitor:${spanreedUserId}`
		await this.ensureRedisClient();
		await this.redisClient.lPush(monitorQueue, JSON.stringify({user: spanreedUserId, kind: 'watchdog'}));
	}

	async ensureRedisClient() {
		const activeConnectionSettings = this.getActiveConnectionSettings()
		if (this.redisClient === undefined || this.lastUsedRedisUrl === undefined ||
			(activeConnectionSettings.redisUrl !== this.lastUsedRedisUrl)) {
			await this.createRedisClient(activeConnectionSettings.redisUrl);
		}
	}

	async pollRedisTaskMessageQueue() {
		// Reschedule after this delay (ms). 0 keeps polling promptly on the
		// happy path (blPop already blocks up to 60s); on failure or when
		// unconfigured we back off so we never busy-loop and hang Obsidian.
		let rescheduleDelay = 0;

		const settings = this.getActiveConnectionSettings();
		if (settings.spanreedUserId === -1 || settings.redisUrl === "") {
			// Not configured yet (e.g. fresh install with no data.json).
			// Don't attempt to connect; just check back periodically.
			this.registerInterval(window.setTimeout(() => this.pollRedisTaskMessageQueue(), 5000));
			return;
		}

		try {
			await this.ensureRedisClient()
			await this.sendSpanreedWatchdogEvent()
			console.log("polling redis task message queue")

			const spanreedUserId = settings.spanreedUserId;
			const taskQueue = `obsidian-plugin-tasks:${spanreedUserId}`;

			console.log("Waiting on queue", taskQueue)

			await this.redisClient.blPop(taskQueue, 60 /* timeout, in seconds */)
				.then(async (res) => {
					if (res === null) {
						return;
					}
					let request: SpanreedRpcRequest = JSON.parse(res.element);
					console.log("got request", request)
					let response: SpanreedRpcResponse = await this.handleSpanreedRequest(request);
					console.log("sending response", response)
					let responseQueue = `obsidian-plugin-tasks:${spanreedUserId}:${request.request_id}`;
					await this.redisClient.lPush(responseQueue, JSON.stringify(response));
				});
			console.log("done polling redis task message queue")
		} catch (e) {
			console.log("error polling redis task message queue", e)
			// Back off before retrying so a persistent failure (e.g. Redis
			// unreachable) doesn't spin.
			rescheduleDelay = 5000;
		} finally {
			this.registerInterval(window.setTimeout(() => this.pollRedisTaskMessageQueue(), rescheduleDelay));
		}
	}
}

class SpanreedSettingsTab extends PluginSettingTab {
	plugin: SpanreedPlugin;

	constructor(app: App, plugin: SpanreedPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		containerEl.createEl('h2', {text: 'Environment'});

		new Setting(containerEl)
			.setName('Active Environment')
			.setDesc('The environment to use for Spanreed')
			.addDropdown(dropdown => dropdown
				.addOptions({
					'production': 'Production',
					'staging': 'Staging',
				})
				.setValue(this.plugin.settings.activeEnvironment)
				.onChange(async (value) => {
					this.plugin.settings.activeEnvironment = value as Environment;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', {text: 'Connection Settings'});

		for (let env in this.plugin.settings.connectionSettings) {
			containerEl.createEl('h4', {text: toString(env as Environment)});
			let connectionSettings = this.plugin.settings.connectionSettings[env as Environment]

			new Setting(containerEl)
				.setName(`Spanreed User ID`)
				.setDesc('Your Spanreed user ID')
				.addText(text => text
					.setPlaceholder('Enter your Spanreed user ID')
					.setValue(connectionSettings.spanreedUserId.toString())
					.onChange(async (value) => {
						connectionSettings.spanreedUserId = parseInt(value);
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('Redis URL')
				.setDesc('Your Redis URL')
				.addText(text => text
					.setPlaceholder('Enter your Redis URL')
					.setValue(connectionSettings.redisUrl)
					.onChange(async (value) => {
						connectionSettings.redisUrl = value;
						await this.plugin.saveSettings();
					}));
		}

	}
}
