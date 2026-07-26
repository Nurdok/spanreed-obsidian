import {Notice} from 'obsidian';
import type SpanreedPlugin from "../main";
import type {SpanreedRedisClient} from "../redis";
import {InboxManager} from "./inbox";
import {WireContent} from "./render";

// Wire shape of a prompt/re-prompt payload (ObsidianSurface.render_prompt
// in obsidian_surface.py). Choices follow PromptSpec: an array whose items
// are strings or string-arrays (explicit rows); a nested row's buttons all
// answer with the SAME top-level index, matching the Telegram keyboard.
export interface PromptPayload {
	interaction_id: string;
	generation: number;
	kind: string; // "choice" | "input"
	prompt: WireContent;
	choices: (string | string[])[] | null;
	columns: number;
	issued_at: number;
}

interface InboundEnvelope {
	seq: number;
	kind: string;
	payload: any;
}

export interface PromptState {
	payload: PromptPayload;
	// Optimistic disable: set the moment an answer is sent, before the
	// server's dismiss-prompt(answered) arrives.
	answered: boolean;
}

export interface TranscriptEntry {
	// null for locally-appended entries (prompt Q/A history).
	messageId: string | null;
	content: WireContent;
	// Rendered as the user's own bubble (their answer).
	local: boolean;
}

export const USERS_SET_KEY = "obsidian-surface:users";
const PROMPT_STALE_SECONDS = 120;
const BLPOP_TIMEOUT_SECONDS = 30;
const DISMISSED_MAX = 200;
const TRANSCRIPT_MAX = 200;
const LAST_SEEN_REFRESH_SECONDS = 3600;
// Heuristic flow boundary: the wire carries no flow id, so a prompt arriving
// after this much conversational silence is treated as a new flow and the
// transcript is cleared (design §4.3: transcript is per-flow).
const NEW_FLOW_GAP_SECONDS = 300;

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function generateUuidHex(): string {
	let out = "";
	for (let i = 0; i < 32; i++) {
		out += Math.floor(Math.random() * 16).toString(16);
	}
	return out;
}

function deviceName(): string {
	try {
		// Desktop only (like the rest of the Redis transport).
		return require("os").hostname();
	} catch (e) {
		return "unknown-device";
	}
}

// The interaction-surface client: registration, presence, the inbound BLPOP
// loop, event sending, and ALL surface state (current prompt, transcript,
// seq watermark, dismissed ids). Views are pure projections of this state
// and may be closed/recreated at any time, including mid-prompt.
export class SurfaceClient {
	plugin: SpanreedPlugin;
	userId: number;
	instanceId: string;
	inbox: InboxManager;

	running = false;
	connected = false;
	currentPrompt: PromptState | null = null;
	transcript: TranscriptEntry[] = [];
	statusLine: string | null = null;

	private epoch = 0;
	private seqWatermark = 0;
	private dismissedIds: string[] = [];
	private dismissedSet: Set<string> = new Set();
	private lastActivityTs = 0;
	private lastSeenWrittenAt = 0;
	private write: SpanreedRedisClient | null = null;

	constructor(plugin: SpanreedPlugin) {
		this.plugin = plugin;
		this.userId = plugin.getActiveConnectionSettings().spanreedUserId;
		this.instanceId = this.loadOrCreateInstanceId();
		this.inbox = new InboxManager(plugin, this.userId);
	}

	// -- keys --------------------------------------------------------------

	private base(): string {
		return `obsidian-surface:${this.userId}`;
	}

	private instancesKey(): string {
		return `${this.base()}:instances`;
	}

	private presenceKey(): string {
		return `${this.base()}:${this.instanceId}:presence`;
	}

	private inboundKey(): string {
		return `${this.base()}:${this.instanceId}:inbound`;
	}

	private eventsKey(): string {
		return `${this.base()}:events`;
	}

	private commandListKey(): string {
		return `${this.base()}:command-list`;
	}

	// -- identity ----------------------------------------------------------

	// Device-local on purpose (Obsidian localStorage, NOT data.json which
	// may sync between devices and would collide instance ids) — design §3.1.
	private loadOrCreateInstanceId(): string {
		const key = `spanreed-instance-id:${this.plugin.settings.activeEnvironment}`;
		const app = this.plugin.app as any;
		let id = app.loadLocalStorage(key);
		if (typeof id !== "string" || id.length === 0) {
			id = generateUuidHex();
			app.saveLocalStorage(key, id);
		}
		return id;
	}

	// -- lifecycle ---------------------------------------------------------

	async start(): Promise<boolean> {
		if (this.running) {
			return true;
		}
		this.running = true;
		const epoch = ++this.epoch;
		let blocking: SpanreedRedisClient;
		try {
			const clients = await this.plugin.redis.ensureSurfaceClients();
			blocking = clients.blocking;
			this.write = clients.write;
			await this.writeRegistration(true);
			await this.write.sAdd(USERS_SET_KEY, String(this.userId));
			await this.refreshPresence(true);
			await this.sendEvent("instance-update", {
				enabled: true,
				vault: this.plugin.app.vault.getName(),
				device: deviceName(),
			});
			await this.sendEvent("sync", {});
			await this.inbox.fetchInitial(this.write);
		} catch (e) {
			console.error("Spanreed: interaction surface failed to start", e);
			new Notice("Spanreed: interaction surface failed to start (see console).");
			this.running = false;
			this.write = null;
			return false;
		}
		this.connected = true;
		this.notifyChange();
		void this.pollLoop(blocking, epoch);
		return true;
	}

	// `sendDisable` distinguishes a user toggle-off (write enabled:false +
	// instance-update event so the server reacts immediately) from a plain
	// shutdown/restart (presence just expires).
	async stop(sendDisable: boolean) {
		this.epoch++;
		this.running = false;
		try {
			if (sendDisable && this.write !== null && this.write.isOpen) {
				await this.writeRegistration(false);
				await this.sendEvent("instance-update", {
					enabled: false,
					vault: this.plugin.app.vault.getName(),
					device: deviceName(),
				});
			}
		} catch (e) {
			console.error("Spanreed: error while disabling surface", e);
		}
		await this.plugin.redis.stopSurfaceClients();
		this.write = null;
		this.connected = false;
		this.currentPrompt = null;
		this.transcript = [];
		this.statusLine = null;
		this.notifyChange();
	}

	// User-requested clear of the conversation section: wipes the
	// transcript/status line AND aborts an active unanswered prompt's
	// interaction server-side (cancel-flow), so the flow doesn't keep
	// re-prompting into a card the user just dismissed.
	async clearConversation() {
		const current = this.currentPrompt;
		this.transcript = [];
		this.statusLine = null;
		if (current !== null && !current.answered) {
			this.markDismissed(current.payload.interaction_id);
			this.currentPrompt = null;
			try {
				await this.sendEvent("cancel-flow", {
					interaction_id: current.payload.interaction_id,
				});
			} catch (e) {
				console.error("Spanreed: failed to send cancel-flow", e);
			}
		}
		this.notifyChange();
	}

	// -- registration & presence -------------------------------------------

	private async writeRegistration(enabled: boolean) {
		if (this.write === null) {
			return;
		}
		const now = nowSeconds();
		let registeredAt = now;
		try {
			const existing = await this.write.hGet(this.instancesKey(), this.instanceId);
			if (existing !== undefined && existing !== null) {
				const parsed = JSON.parse(existing);
				if (typeof parsed?.registered_at === "number") {
					registeredAt = parsed.registered_at;
				}
			}
		} catch (e) {
			console.error("Spanreed: could not read existing registration", e);
		}
		await this.write.hSet(this.instancesKey(), this.instanceId, JSON.stringify({
			vault: this.plugin.app.vault.getName(),
			device: deviceName(),
			enabled: enabled,
			registered_at: registeredAt,
			last_seen: now,
		}));
		this.lastSeenWrittenAt = now;
	}

	// Refreshed from the poll loop after each BLPOP returns (not from an
	// independent timer: a wedged poll loop must look unreachable) and on
	// every event send. last_seen in the hash refreshes ~hourly.
	private async refreshPresence(forceLastSeen: boolean) {
		if (this.write === null || !this.write.isOpen) {
			return;
		}
		const now = nowSeconds();
		await this.write.set(this.presenceKey(), String(now), {EX: 90});
		if (forceLastSeen || now - this.lastSeenWrittenAt > LAST_SEEN_REFRESH_SECONDS) {
			await this.writeRegistration(true);
		}
	}

	// -- events (instance -> server) ---------------------------------------

	async sendEvent(kind: string, payload: object) {
		if (this.write === null || !this.write.isOpen) {
			throw new Error("Spanreed surface is not connected");
		}
		await this.write.rPush(this.eventsKey(), JSON.stringify({
			kind: kind,
			instance_id: this.instanceId,
			payload: payload,
		}));
		await this.write.set(this.presenceKey(), String(nowSeconds()), {EX: 90});
	}

	async invokeCommand(commandId: string) {
		// A palette invocation starts a new flow: the old flow's transcript
		// is over (the server will dismiss any displayed prompt).
		this.transcript = [];
		this.statusLine = null;
		await this.sendEvent("invoke-command", {command_id: commandId});
		this.lastActivityTs = nowSeconds();
		this.notifyChange();
	}

	async answerChoice(index: number, label: string) {
		const current = this.currentPrompt;
		if (current === null || current.answered) {
			return;
		}
		await this.sendAnswer(current, index, label);
	}

	async answerInput(text: string) {
		const current = this.currentPrompt;
		if (current === null || current.answered) {
			return;
		}
		await this.sendAnswer(current, text, text);
	}

	private async sendAnswer(current: PromptState, value: number | string, label: string) {
		current.answered = true;
		// Move the Q/A into the transcript so the flow reads back as a
		// conversation once the card is dismissed.
		this.appendTranscript({
			messageId: null,
			content: current.payload.prompt,
			local: false,
		});
		this.appendTranscript({
			messageId: null,
			content: {text: label, parse_html: false, parse_markdown: false},
			local: true,
		});
		this.notifyChange();
		try {
			await this.sendEvent("answer", {
				interaction_id: current.payload.interaction_id,
				generation: current.payload.generation,
				value: value,
			});
		} catch (e) {
			console.error("Spanreed: failed to send answer", e);
			current.answered = false;
			this.statusLine = "Failed to send the answer — is Redis reachable?";
			this.notifyChange();
		}
	}

	async fetchCommandListRaw(): Promise<string | null> {
		if (this.write === null || !this.write.isOpen) {
			return null;
		}
		return await this.write.get(this.commandListKey());
	}

	// -- inbound poll loop -------------------------------------------------

	private async pollLoop(blocking: SpanreedRedisClient, epoch: number) {
		while (this.epoch === epoch) {
			try {
				const res = await blocking.blPop(this.inboundKey(), BLPOP_TIMEOUT_SECONDS);
				if (this.epoch !== epoch) {
					return;
				}
				await this.refreshPresence(false);
				if (res !== null) {
					let envelope: InboundEnvelope | null = null;
					try {
						envelope = JSON.parse(res.element);
					} catch (e) {
						console.error("Spanreed: malformed inbound envelope", res.element, e);
					}
					if (envelope !== null) {
						this.handleEnvelope(envelope);
					}
				}
			} catch (e) {
				if (this.epoch !== epoch) {
					return;
				}
				console.error("Spanreed: surface poll error", e);
				await new Promise((resolve) => window.setTimeout(resolve, 5000));
			}
		}
	}

	// -- envelope handling -------------------------------------------------

	private handleEnvelope(envelope: InboundEnvelope) {
		// After a sync-reply, only envelopes past its watermark count — pure
		// queue order is not trusted for the sync race (design §3.2).
		if (typeof envelope.seq === "number") {
			if (envelope.seq <= this.seqWatermark) {
				return;
			}
			this.seqWatermark = envelope.seq;
		}
		const payload = envelope.payload ?? {};
		switch (envelope.kind) {
			case "prompt":
			case "re-prompt":
				this.applyPrompt(payload as PromptPayload);
				break;
			case "dismiss-prompt":
				this.applyDismiss(payload.interaction_id, payload.reason);
				break;
			case "message":
				this.appendTranscript({
					messageId: payload.message_id,
					content: payload.content,
					local: false,
				});
				this.lastActivityTs = nowSeconds();
				break;
			case "update-message": {
				const entry = this.transcript.find((e) => e.messageId === payload.message_id);
				if (entry !== undefined) {
					entry.content = payload.content;
				}
				break;
			}
			case "retract-message":
				this.transcript = this.transcript.filter(
					(e) => e.messageId !== payload.message_id);
				break;
			case "notification":
				this.inbox.onNotification(payload.entry);
				break;
			case "already-answered":
				this.markDismissed(payload.interaction_id);
				this.clearPromptIfMatching(payload.interaction_id);
				this.statusLine = "Already answered on another device.";
				break;
			case "interaction-expired":
				this.markDismissed(payload.interaction_id);
				this.clearPromptIfMatching(payload.interaction_id);
				this.statusLine = "This interaction expired — re-run the command.";
				break;
			case "flow-error": {
				const message: string = typeof payload.message === "string"
					? payload.message : "Spanreed flow error.";
				this.statusLine = message;
				new Notice(`Spanreed: ${message}`);
				break;
			}
			case "commands-updated":
				this.plugin.onSurfaceCommandsUpdated(
					typeof payload.version === "string" ? payload.version : null);
				break;
			case "sync-reply":
				this.applySyncReply(payload);
				break;
			default:
				console.warn("Spanreed: unknown envelope kind", envelope.kind);
		}
		this.notifyChange();
	}

	private applyPrompt(payload: PromptPayload) {
		const now = nowSeconds();
		// Staleness guard (R5 "live-only"): prompts queued while the
		// instance was closed must be discarded, not rendered.
		if (now - payload.issued_at > PROMPT_STALE_SECONDS) {
			return;
		}
		if (this.dismissedSet.has(payload.interaction_id)) {
			return;
		}
		const current = this.currentPrompt;
		if (current !== null && current.payload.interaction_id === payload.interaction_id) {
			// Refresh-or-render (re-prompt of the displayed card).
			current.payload = payload;
		} else {
			if (current === null && this.transcript.length > 0
				&& now - this.lastActivityTs > NEW_FLOW_GAP_SECONDS) {
				// New flow after a quiet gap: reset the per-flow transcript.
				this.transcript = [];
			}
			this.currentPrompt = {payload: payload, answered: false};
			this.statusLine = null;
			this.plugin.onSurfacePromptArrived(payload);
		}
		this.lastActivityTs = now;
	}

	private applyDismiss(interactionId: string, reason: string) {
		this.markDismissed(interactionId);
		const current = this.currentPrompt;
		if (current === null || current.payload.interaction_id !== interactionId) {
			return;
		}
		const answeredLocally = current.answered;
		this.currentPrompt = null;
		if (reason === "preempted") {
			// The preempting flow's prompt card follows on this same queue.
			this.transcript = [];
			this.statusLine = null;
		} else if (reason === "answered") {
			this.statusLine = answeredLocally ? null : "Answered on another device.";
		} else {
			// cancelled / toggle
			this.statusLine = "This interaction was cancelled.";
		}
	}

	private applySyncReply(payload: any) {
		if (typeof payload.seq_high_water === "number") {
			this.seqWatermark = payload.seq_high_water;
		}
		const pending: PromptPayload | null = payload.pending_prompt ?? null;
		if (pending === null) {
			if (this.currentPrompt !== null && !this.currentPrompt.answered) {
				this.currentPrompt = null;
			}
		} else if (!this.dismissedSet.has(pending.interaction_id)) {
			const current = this.currentPrompt;
			if (current === null || current.payload.interaction_id !== pending.interaction_id) {
				// Authoritative: the server's live pending prompt is never
				// stale, so the 120s guard deliberately does not apply.
				this.currentPrompt = {payload: pending, answered: false};
				this.statusLine = null;
				this.plugin.onSurfacePromptArrived(pending);
				this.lastActivityTs = nowSeconds();
			}
		}
		this.plugin.onSurfaceCommandsUpdated(
			typeof payload.command_list_version === "string"
				? payload.command_list_version : null);
	}

	private clearPromptIfMatching(interactionId: string) {
		if (this.currentPrompt !== null
			&& this.currentPrompt.payload.interaction_id === interactionId) {
			this.currentPrompt = null;
		}
	}

	private markDismissed(interactionId: string) {
		if (typeof interactionId !== "string" || this.dismissedSet.has(interactionId)) {
			return;
		}
		this.dismissedIds.push(interactionId);
		this.dismissedSet.add(interactionId);
		while (this.dismissedIds.length > DISMISSED_MAX) {
			const oldest = this.dismissedIds.shift();
			if (oldest !== undefined) {
				this.dismissedSet.delete(oldest);
			}
		}
	}

	private appendTranscript(entry: TranscriptEntry) {
		this.transcript.push(entry);
		while (this.transcript.length > TRANSCRIPT_MAX) {
			this.transcript.shift();
		}
	}

	private notifyChange() {
		this.plugin.notifySurfaceChanged();
	}
}
