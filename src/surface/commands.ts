import {Notice} from 'obsidian';
import type SpanreedPlugin from "../main";

// Wire shape of `obsidian-surface:{userId}:command-list` (server-side
// `build_command_list` in plugins/obsidian_surface.py).
interface SurfaceCommandEntry {
	id: string;
	plugin: string;
	text: string;
}

interface SurfaceCommandList {
	version: string;
	commands: SurfaceCommandEntry[];
}

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// Dynamic palette registration: mirrors the server-published command list
// into Obsidian's command palette, diffing against what's already registered
// so an unchanged version is a no-op (design §4.2).
export class SurfaceCommands {
	private plugin: SpanreedPlugin;
	// command id -> registered display text (for change detection).
	private registered: Map<string, string> = new Map();
	private lastVersion: string | null = null;
	private intervalId: number | null = null;

	constructor(plugin: SpanreedPlugin) {
		this.plugin = plugin;
	}

	start() {
		void this.refresh(null);
		// Fetch on load (above), every 5 minutes, and on commands-updated
		// envelopes (via plugin.onSurfaceCommandsUpdated).
		this.intervalId = window.setInterval(() => {
			void this.refresh(null);
		}, REFRESH_INTERVAL_MS);
		this.plugin.registerInterval(this.intervalId);
	}

	stop() {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		this.unregisterAll();
		this.lastVersion = null;
	}

	// `expectedVersion` is the version carried by a commands-updated nudge or
	// sync-reply; when it matches what we already registered, skip the GET.
	async refresh(expectedVersion: string | null) {
		const surface = this.plugin.surface;
		if (surface === null) {
			return;
		}
		if (expectedVersion !== null && expectedVersion === this.lastVersion) {
			return;
		}
		let raw: string | null = null;
		try {
			raw = await surface.fetchCommandListRaw();
		} catch (e) {
			console.error("Spanreed: failed to fetch command list", e);
			return;
		}
		if (raw === null) {
			// Never published for this user yet.
			return;
		}
		let commandList: SurfaceCommandList;
		try {
			commandList = JSON.parse(raw);
		} catch (e) {
			console.error("Spanreed: malformed command list", raw, e);
			return;
		}
		if (typeof commandList?.version !== "string" || !Array.isArray(commandList?.commands)) {
			console.error("Spanreed: malformed command list", raw);
			return;
		}
		// Unchanged version = no palette re-registration (design §3.4).
		if (commandList.version === this.lastVersion) {
			return;
		}
		this.applyCommands(commandList.commands);
		this.lastVersion = commandList.version;
	}

	private applyCommands(commands: SurfaceCommandEntry[]) {
		const seen = new Set<string>();
		for (const command of commands) {
			if (typeof command?.id !== "string" || typeof command?.text !== "string") {
				continue;
			}
			seen.add(command.id);
			const registeredText = this.registered.get(command.id);
			if (registeredText === command.text) {
				continue;
			}
			if (registeredText !== undefined) {
				// Display text changed: re-register under the same id.
				this.removeCommand(command.id);
			}
			const commandId = command.id;
			// NO "Spanreed: " prefix — Obsidian prepends the plugin name to
			// palette entries itself (design §4.2).
			this.plugin.addCommand({
				id: commandId,
				name: command.text,
				callback: () => {
					void this.invoke(commandId);
				},
			});
			this.registered.set(commandId, command.text);
		}
		for (const id of Array.from(this.registered.keys())) {
			if (!seen.has(id)) {
				this.removeCommand(id);
			}
		}
	}

	private removeCommand(id: string) {
		// `removeCommand` isn't in the public API types, but exists at
		// runtime (same tier as the executeCommandById the plugin already
		// uses). Full id = "<plugin id>:<command id>".
		(this.plugin.app as any).commands.removeCommand(`${this.plugin.manifest.id}:${id}`);
		this.registered.delete(id);
	}

	private async invoke(commandId: string) {
		const surface = this.plugin.surface;
		if (surface === null) {
			new Notice("Spanreed: the interaction surface is disabled.");
			return;
		}
		try {
			await surface.invokeCommand(commandId);
		} catch (e) {
			console.error("Spanreed: failed to invoke command", commandId, e);
			new Notice("Spanreed: failed to send the command (see console).");
			return;
		}
		await this.plugin.activateSurfaceView();
	}

	unregisterAll() {
		for (const id of Array.from(this.registered.keys())) {
			this.removeCommand(id);
		}
	}
}
