import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Tests run as pure HTTP clients against a local dev server.
        // No worker pool needed — just standard vitest.
        testTimeout: 30000,
        hookTimeout: 30000,
    },
});
