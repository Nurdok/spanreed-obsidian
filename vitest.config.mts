import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
	},
	resolve: {
		alias: {
			// `obsidian` ships types only; point the runtime at the stub.
			obsidian: fileURLToPath(new URL('./test/stubs/obsidian.ts', import.meta.url)),
		},
	},
});
