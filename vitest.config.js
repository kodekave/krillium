import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('worker/migrations');
  return {
    test: {
      projects: [
        {
          test: {
            name: 'shared',
            environment: 'node',
            include: ['tests/shared/**/*.test.js', 'tests/site/**/*.test.js'],
          },
        },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: './wrangler.toml' },
              miniflare: {
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
                  SESSION_SECRET: 'test-session-secret-not-for-production',
                  ALLOWED_ORIGIN: 'https://radar.example.test',
                },
              },
            }),
          ],
          test: {
            name: 'worker',
            include: ['tests/worker/**/*.test.js'],
            setupFiles: ['./tests/worker/setup.js'],
          },
        },
      ],
    },
  };
});
