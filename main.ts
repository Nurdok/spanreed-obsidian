import {App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, removeIcon, Setting} from 'obsidian';
import { createClient, RedisClientType } from "redis";


interface SpanreedRpcRequest {
	request_id: string;
	method: string;
	params: any[];
}

interface SpanreedRpcResponse {
	success: boolean;
	result: any;
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

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-sample-modal-simple',
			name: 'Open sample modal (simple)',
			callback: () => {
				new SampleModal(this.app).open();
			}
		});
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'sample-editor-command',
			name: 'Sample editor command',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				console.log(editor.getSelection());
				editor.replaceSelection('Sample Editor Command');
			}
		});
		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: 'open-sample-modal-complex',
			name: 'Open sample modal (complex)',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new SampleModal(this.app).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
			}
		});

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
		if (typeof(this.redisClient) === "undefined") {
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

				switch (request.method) {
					case "generate-daily-note":
						console.log("generating daily note")
						this.app.commands.executeCommandById("daily-notes");
						let responseQueue = `obsidian-plugin-tasks:${this.settings.spanreedUserId}:${request.request_id}`;
						let response: SpanreedRpcResponse = {"success": true, "result": null};
						await this.redisClient.lPush(responseQueue, JSON.stringify(response));
						console.log("Send success response to redis queue: " + responseQueue);
						break;
					default:
							console.log("unknown method: ", request.method);
				}
			});
		console.log("done polling redis task message queue")
		this.registerInterval(window.setTimeout(() => this.pollRedisTaskMessageQueue(), 10 * 1000));
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	async onOpen() {
		const {contentEl} = this;
		contentEl.createEl('h1', {text: 'Book Query'});
		const dv = this.app.plugins.plugins.dataview.api;
		console.log("before query");
		dv.tryQuery("table without id title from #book").then((res) => {
			contentEl.createEl('h2', {text: 'Your books'});
			res.values.forEach((book) => {
				contentEl.createEl('p', {text: book[0]});
			});
		});
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
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
