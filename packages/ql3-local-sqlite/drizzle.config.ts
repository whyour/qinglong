import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/storage/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
