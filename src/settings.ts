import {App, PluginSettingTab, Setting} from 'obsidian';
import type SpanreedPlugin from "./main";

export type Environment = 'production' | 'staging';

export const environmentDisplayName = (env: Environment) => {
	return {
		'production': 'Production',
		'staging': 'Staging',
	}[env];
}

export interface ConnectionSettings {
	spanreedUserId: number;
	redisUrl: string;
	interactionSurfaceEnabled: boolean;
}

export interface SpanreedSettings {
	connectionSettings: Record<Environment, ConnectionSettings>
	activeEnvironment: Environment
}

export const DEFAULT_CONNECTION_SETTINGS: ConnectionSettings = {
	spanreedUserId: -1,
	redisUrl: "",
	interactionSurfaceEnabled: false,
}

export const DEFAULT_SETTINGS: SpanreedSettings = {
	connectionSettings: {
		production: DEFAULT_CONNECTION_SETTINGS,
		staging: DEFAULT_CONNECTION_SETTINGS,
	},
	activeEnvironment: 'production',
}

// A shallow Object.assign would let a loaded data.json (written before a
// field existed) drop that field's default, so each environment's settings
// are merged individually.
export function mergeSettings(loaded: any): SpanreedSettings {
	return {
		connectionSettings: {
			production: Object.assign({}, DEFAULT_CONNECTION_SETTINGS,
				loaded?.connectionSettings?.production),
			staging: Object.assign({}, DEFAULT_CONNECTION_SETTINGS,
				loaded?.connectionSettings?.staging),
		},
		activeEnvironment: loaded?.activeEnvironment ?? DEFAULT_SETTINGS.activeEnvironment,
	};
}

export class SpanreedSettingsTab extends PluginSettingTab {
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
					// The surface (if any) is bound to the previous
					// environment's Redis and instance id; restart it against
					// the new one.
					await this.plugin.restartSurfaceForSettingsChange();
				}));

		containerEl.createEl('h3', {text: 'Connection Settings'});

		for (let env in this.plugin.settings.connectionSettings) {
			containerEl.createEl('h4', {text: environmentDisplayName(env as Environment)});
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

			new Setting(containerEl)
				.setName('Enable interaction surface')
				.setDesc('Show Spanreed prompts, messages, notifications and'
					+ ' palette commands in this vault.')
				.addToggle(toggle => toggle
					.setValue(connectionSettings.interactionSurfaceEnabled)
					.onChange(async (value) => {
						connectionSettings.interactionSurfaceEnabled = value;
						await this.plugin.saveSettings();
						// Takes effect immediately (no restart) when this is
						// the active environment.
						if (env === this.plugin.settings.activeEnvironment) {
							await this.plugin.applySurfaceToggle(value);
						}
					}));
		}

	}
}
