import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
