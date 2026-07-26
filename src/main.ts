import {Notice, Plugin} from 'obsidian';
import {
	ConnectionSettings,
	mergeSettings,
	SpanreedSettings,
	SpanreedSettingsTab,
} from "./settings";
import {RedisManager} from "./redis";
import {SpanreedApiCommandsModal, VaultRpcAgent} from "./vault-rpc";
import {PromptPayload, SurfaceClient} from "./surface/client";
import {SurfaceCommands} from "./surface/commands";
import {SpanreedView, VIEW_TYPE_SPANREED} from "./surface/view";
import {contentToPlainText} from "./surface/render";

export default class SpanreedPlugin extends Plugin {
	settings: SpanreedSettings;
	redis: RedisManager;
	vaultRpc: VaultRpcAgent;
	surfaceCommands: SurfaceCommands;
	// Non-null exactly while the interaction surface is running; the sidebar
	// view renders a "surface disabled" note when this is null.
	surface: SurfaceClient | null = null;
	private surfaceListeners: Set<() => void> = new Set();

	async onload() {
		await this.loadSettings();

		this.redis = new RedisManager(this);
		this.vaultRpc = new VaultRpcAgent(this);
		this.surfaceCommands = new SurfaceCommands(this);

		this.registerView(VIEW_TYPE_SPANREED, (leaf) => new SpanreedView(leaf, this));
		this.addRibbonIcon('message-square', 'Spanreed', () => {
			void this.activateSurfaceView();
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SpanreedSettingsTab(this.app, this));

		// Lets you confirm which build is installed (version + the RPC methods
		// it actually supports) straight from the command palette.
		this.addCommand({
			id: 'show-supported-api-commands',
			name: 'Show supported API commands',
			callback: () => {
				new SpanreedApiCommandsModal(this.app, this).open();
			},
		});

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setTimeout(() => this.vaultRpc.pollRedisTaskMessageQueue(), 0));

		const connectionSettings = this.getActiveConnectionSettings()

		if (connectionSettings.spanreedUserId === -1) {
			new Notice("Please set your Spanreed user ID in the plugin settings.");
			return;
		}
		if (connectionSettings.redisUrl === "") {
			new Notice("Please set your Redis URL in the plugin settings.");
			return;
		}

		if (connectionSettings.interactionSurfaceEnabled) {
			void this.startSurface();
		}
	}

	onunload() {
		// Must tear down every Redis client, including the ones blocked in
		// BLPOP — a leaked blocked consumer from a previous plugin load
		// would steal inbound messages from the new one.
		this.redis.disconnectAll();
	}

	async loadSettings() {
		this.settings = mergeSettings(await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	getActiveConnectionSettings(): ConnectionSettings {
		return this.settings.connectionSettings[this.settings.activeEnvironment];
	}

	// -- interaction surface lifecycle -------------------------------------

	async startSurface() {
		if (this.surface !== null) {
			return;
		}
		const connectionSettings = this.getActiveConnectionSettings();
		if (connectionSettings.spanreedUserId === -1 || connectionSettings.redisUrl === "") {
			new Notice("Spanreed: set your user ID and Redis URL before"
				+ " enabling the interaction surface.");
			return;
		}
		const surface = new SurfaceClient(this);
		this.surface = surface;
		const started = await surface.start();
		if (!started) {
			this.surface = null;
			this.notifySurfaceChanged();
			return;
		}
		this.surfaceCommands.start();
		this.notifySurfaceChanged();
	}

	async stopSurface(sendDisable: boolean) {
		if (this.surface === null) {
			return;
		}
		this.surfaceCommands.stop();
		const surface = this.surface;
		this.surface = null;
		await surface.stop(sendDisable);
		this.notifySurfaceChanged();
	}

	// Settings-tab toggle: takes effect immediately, no restart required.
	async applySurfaceToggle(enabled: boolean) {
		if (enabled) {
			await this.startSurface();
		} else {
			await this.stopSurface(true);
		}
	}

	// Environment switch: the surface is bound to the old environment's
	// Redis, user id and instance id, so restart it against the new one.
	async restartSurfaceForSettingsChange() {
		await this.stopSurface(false);
		if (this.getActiveConnectionSettings().interactionSurfaceEnabled) {
			await this.startSurface();
		} else {
			this.notifySurfaceChanged();
		}
	}

	// -- surface state fan-out to views ------------------------------------

	onSurfaceChange(listener: () => void): () => void {
		this.surfaceListeners.add(listener);
		return () => {
			this.surfaceListeners.delete(listener);
		};
	}

	notifySurfaceChanged() {
		for (const listener of Array.from(this.surfaceListeners)) {
			try {
				listener();
			} catch (e) {
				console.error("Spanreed: surface listener failed", e);
			}
		}
	}

	onSurfacePromptArrived(payload: PromptPayload) {
		const viewOpen = this.app.workspace.getLeavesOfType(VIEW_TYPE_SPANREED).length > 0;
		if (!viewOpen) {
			new Notice(`Spanreed: ${contentToPlainText(payload.prompt)}`);
		}
		void this.activateSurfaceView();
	}

	onSurfaceCommandsUpdated(version: string | null) {
		void this.surfaceCommands.refresh(version);
	}

	async activateSurfaceView() {
		const workspace = this.app.workspace;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_SPANREED)[0];
		if (leaf === undefined) {
			leaf = workspace.getRightLeaf(false);
			await leaf.setViewState({type: VIEW_TYPE_SPANREED, active: true});
		}
		workspace.revealLeaf(leaf);
	}
}
