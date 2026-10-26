import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations("./migrations");
	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					// Tests never call Anthropic; the agent token is a fixed test value.
					bindings: { TEST_MIGRATIONS: migrations, AGENT_TOKEN: "test-token", ANTHROPIC_API_KEY: "unused" },
				},
			}),
		],
		test: { setupFiles: ["./test/apply-migrations.ts"] },
	};
});
