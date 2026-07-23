import { defineConfig } from "vitest/config";

process.env.ADMIN_TOKEN ??= "test-admin-token";
const { cloudflareTest, readD1Migrations } = await import("@cloudflare/vitest-pool-workers");

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    main: "./src/index.ts",
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: { ADMIN_TOKEN: "test-admin-token" } },
  })],
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    provide: {
      d1Migrations: await readD1Migrations("./migrations"),
    },
  },
}));
