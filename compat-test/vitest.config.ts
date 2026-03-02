import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globalSetup: './src/process/globalSetup.ts',
        testTimeout: 10000,
    }
});
