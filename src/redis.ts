import {createClient, RedisClientType} from "redis";
import type SpanreedPlugin from "./main";

export type SpanreedRedisClient = RedisClientType<any, any, any>;

// Connection manager for the plugin's three Redis connections:
//
// (a) the vault-RPC client (blocking BLPOP on obsidian-plugin-tasks:*,
//     plus its response/monitor pushes — unchanged legacy behavior);
// (b) a duplicated connection dedicated to the interaction surface's
//     inbound BLPOP;
// (c) a third connection for presence writes and all event/answer RPUSHes.
//
// (b) and (c) must never share a connection: node-redis serializes commands
// per connection, so an answer RPUSH sharing the BLPOP connection would wait
// out the blocking pop, destroying the surface's sub-second latency.
export class RedisManager {
	plugin: SpanreedPlugin;
	rpcClient: SpanreedRedisClient;
	lastUsedRedisUrl?: string
	surfaceBlockingClient: SpanreedRedisClient | null = null;
	surfaceWriteClient: SpanreedRedisClient | null = null;
	private surfaceRedisUrl?: string;

	constructor(plugin: SpanreedPlugin) {
		this.plugin = plugin;
	}

	async createRpcClient(redisUrl: string) {
		this.rpcClient = createClient({
			url: redisUrl
		});
		this.rpcClient.on('error', (err: Error) => {
			this.plugin.vaultRpc.sendRedisErrorToSpanreedMonitor(err.message);
		});
		await this.rpcClient.connect();
		this.lastUsedRedisUrl = redisUrl
	}

	async ensureRpcClient(): Promise<SpanreedRedisClient> {
		const activeConnectionSettings = this.plugin.getActiveConnectionSettings()
		if (this.rpcClient === undefined || this.lastUsedRedisUrl === undefined ||
			(activeConnectionSettings.redisUrl !== this.lastUsedRedisUrl)) {
			await this.createRpcClient(activeConnectionSettings.redisUrl);
		}
		return this.rpcClient;
	}

	async ensureSurfaceClients(): Promise<{ blocking: SpanreedRedisClient, write: SpanreedRedisClient }> {
		const url = this.plugin.getActiveConnectionSettings().redisUrl;
		if (this.surfaceBlockingClient !== null && this.surfaceWriteClient !== null
			&& this.surfaceBlockingClient.isOpen && this.surfaceWriteClient.isOpen
			&& this.surfaceRedisUrl === url) {
			return {blocking: this.surfaceBlockingClient, write: this.surfaceWriteClient};
		}
		await this.stopSurfaceClients();
		const base = await this.ensureRpcClient();
		const blocking: SpanreedRedisClient = base.duplicate();
		const write: SpanreedRedisClient = base.duplicate();
		for (const client of [blocking, write]) {
			client.on('error', (err: Error) => {
				console.error("Spanreed surface Redis error", err);
			});
		}
		await blocking.connect();
		await write.connect();
		this.surfaceBlockingClient = blocking;
		this.surfaceWriteClient = write;
		this.surfaceRedisUrl = url;
		return {blocking, write};
	}

	// `disconnect()` (not `quit()`): the blocking client sits inside a BLPOP
	// and a graceful quit would wait for it. A leaked blocked consumer from a
	// previous plugin load would steal inbound messages from the new one.
	private async forceDisconnect(client: SpanreedRedisClient | null) {
		if (client === null) {
			return;
		}
		try {
			if (client.isOpen) {
				await client.disconnect();
			}
		} catch (e) {
			console.error("Spanreed: error disconnecting Redis client", e);
		}
	}

	async stopSurfaceClients() {
		const blocking = this.surfaceBlockingClient;
		const write = this.surfaceWriteClient;
		this.surfaceBlockingClient = null;
		this.surfaceWriteClient = null;
		this.surfaceRedisUrl = undefined;
		await this.forceDisconnect(blocking);
		await this.forceDisconnect(write);
	}

	// Called from `onunload`: every client must go away, including the ones
	// blocked in BLPOP (the vault-RPC client blocks too).
	disconnectAll() {
		void this.stopSurfaceClients();
		void this.forceDisconnect(this.rpcClient ?? null);
	}
}
