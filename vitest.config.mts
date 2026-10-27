import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations("./migrations");
	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					// Tests never call Bedrock; the agent token is a fixed test value.
					bindings: { TEST_MIGRATIONS: migrations, AGENT_TOKEN: "test-token", BEDROCK_API_KEY: "unused" },
				},
			}),
		],
		test: {
			setupFiles: ["./test/apply-migrations.ts"],
			// Pulled in by the Bedrock SDK; its extensionless ESM imports need pre-bundling for the Workers test runtime.
			deps: { optimizer: { ssr: { enabled: true, include: ["@aws-sdk/util-utf8-browser"] } } },
		},
	};
});
