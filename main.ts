import {App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile} from 'obsidian';
import {createClient, RedisClientType} from "redis";


interface SpanreedRpcRequest {
	request_id: string;
	method: string;
	params: any[];
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

interface SpanreedRpcResponse {
	success: boolean;
	result: any;
}

interface QueryDataviewResult {
}

interface SpanreedSettings {
	spanreedUserId: number;
	redis_url: string;
}

const DEFAULT_SETTINGS: SpanreedSettings = {
	spanreedUserId: -1,
	redis_url: "",
}

export default class SpanreedPlugin extends Plugin {
	settings: SpanreedSettings;
	redisClient: RedisClientType<any, any, any>;

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

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			console.log('click', evt);
		});

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setTimeout(() => this.pollRedisTaskMessageQueue(), 0));

		if (this.settings.spanreedUserId === -1) {
			new Notice("Please set your Spanreed user ID in the plugin settings.");
			return;
		}
		if (this.settings.redis_url === "") {
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

	async pollRedisTaskMessageQueue() {
		if (typeof (this.redisClient) === "undefined") {
			this.redisClient = createClient({
				url: this.settings.redis_url,
			});
			await this.redisClient.connect();
		}

		await this.redisClient.blPop(`obsidian-plugin-tasks:${this.settings.spanreedUserId}`, 0)
			.then(async (res) => {
				if (res === null) {
					return;
				}
				let request: SpanreedRpcRequest = JSON.parse(res.element);
				let responseQueue = `obsidian-plugin-tasks:${this.settings.spanreedUserId}:${request.request_id}`;
				let response: SpanreedRpcResponse = {"success": false, "result": "unknown error"};

				switch (request.method) {
					case "generate-daily-note": {
						console.log("generating daily note")
						this.app.commands.executeCommandById("daily-notes");
						response = {"success": true, "result": null};
						break;
					}
					case "modify-property": {
						let filepath: string = request.params.filepath;
						let tfile: TFile | null = null;
						for (let file of this.app.vault.getMarkdownFiles()) {
							if (file.path == filepath) {
								tfile = file;
								break;
							}
						}
						if (tfile === null) {
							response = {"success": false, "result": "file not found"};
							break;
						}
						const params: ModifyPropertyParams = request.params;
						const property = params.property;
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
									response = {"success": true, result: null};
								});
								break;
							case "removeFromList":
								await this.app.fileManager.processFrontMatter(tfile, (frontmatter) => {
									if (typeof (frontmatter[property]) === "undefined") {
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
									response = {"success": true, result: null};
								});
								break;
							case "setSingleValue":
								await this.app.fileManager.processFrontMatter(tfile, (frontmatter) => {
									frontmatter[property] = params.value;
								});
								response = {"success": true, result: null};
								break;
							case "deleteProperty":
								await this.app.fileManager.processFrontMatter(tfile, (frontmatter) => {
									delete frontmatter[property];
								});
								response = {"success": true, result: null};
								break;
							case "getProperty":
								// TODO: there's a better API for this, but I CBA right now
								await this.app.fileManager.processFrontMatter(tfile, (frontmatter) => {
									let value = frontmatter[property];
									if (typeof (value) === "undefined") {
										value = null;
									}
									response = {"success": true, result: value}
								});
								break;
						}
						break;
					}
					case "query-dataview": {
						const dv = this.app.plugins.plugins.dataview.api;
						const params: QueryDataviewParams = request.params;
						const query = params.query;
						await dv.tryQuery(query).then((result: any) => {
							response = {"success": true, "result": result};
						});
						break;
					}
					default:
						response = {"success": false, "result": `unknown method ${request.method}`};
				}
				await this.redisClient.lPush(responseQueue, JSON.stringify(response));
			});
		console.log("done polling redis task message queue")
		this.registerInterval(window.setTimeout(() => this.pollRedisTaskMessageQueue(), 10 * 1000));
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

		new Setting(containerEl)
			.setName('Spanreed User ID')
			.setDesc('Your Spanreed user ID')
			.addText(text => text
				.setPlaceholder('Enter your Spanreed user ID')
				.setValue(this.plugin.settings.spanreedUserId.toString())
				.onChange(async (value) => {
					this.plugin.settings.spanreedUserId = parseInt(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Redis URL')
			.setDesc('Your Redis URL')
			.addText(text => text
				.setPlaceholder('Enter your Redis URL')
				.setValue(this.plugin.settings.redis_url)
				.onChange(async (value) => {
					this.plugin.settings.redis_url = value;
					await this.plugin.saveSettings();
				}));
	}
}
