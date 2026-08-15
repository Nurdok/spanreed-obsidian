// Runtime stub for the `obsidian` module.
//
// The real `obsidian` npm package is types-only ("main": "") — the
// implementation lives inside the Obsidian app itself, so `import {Notice}
// from 'obsidian'` explodes in a plain Node process. Vitest aliases the
// module to this file (see vitest.config.ts) so the plugin's sources can be
// imported under test. `tsc` still checks the sources against the REAL
// obsidian types; this stub only has to satisfy the runtime.
//
// Only the surface the tests actually exercise is implemented. Anything else
// is a bare class so that `extends` and named imports resolve.

// moment ships CommonJS `export =` typings, so a default import would need
// allowSyntheticDefaultImports. Import the namespace and unwrap the interop
// default at runtime instead, so the project's tsconfig stays untouched.
import * as momentNs from 'moment';

const momentFn: typeof momentNs = (momentNs as any).default ?? momentNs;

export {momentFn as moment};

// Every Notice the code under test raises, in order. Tests assert on this
// instead of on a real toast.
export const notices: string[] = [];

export function clearNotices(): void {
	notices.length = 0;
}

export class Notice {
	message: string;

	constructor(message: string) {
		this.message = message;
		notices.push(message);
	}

	hide(): void {
		// no-op
	}
}

export const MarkdownRenderer = {
	rendered: [] as string[],
	async render(_app: unknown, markdown: string, el: any, _path: string, _c: unknown): Promise<void> {
		MarkdownRenderer.rendered.push(markdown);
		if (el && typeof el === "object") {
			el.textContent = markdown;
		}
	},
};

export class App {
}

export class Component {
}

export class TFile {
	path = "";
	name = "";
}

export class Modal {
	app: unknown;
	contentEl: unknown = {};

	constructor(app: unknown) {
		this.app = app;
	}

	open(): void {
		// no-op
	}

	close(): void {
		// no-op
	}
}

export class Plugin {
	app: unknown;
	manifest: unknown;

	constructor(app: unknown, manifest: unknown) {
		this.app = app;
		this.manifest = manifest;
	}
}

export class PluginSettingTab {
	constructor(_app: unknown, _plugin: unknown) {
		// no-op
	}
}

export class Setting {
	constructor(_containerEl: unknown) {
		// no-op
	}
}

export class ItemView {
	leaf: unknown;

	constructor(leaf: unknown) {
		this.leaf = leaf;
	}
}

export class WorkspaceLeaf {
}
