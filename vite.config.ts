import { execFileSync } from 'node:child_process';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

execFileSync(process.execPath, ['tools/build-cloud.cjs'], { stdio: 'inherit' });

export default defineConfig({
  plugins: [cloudflare()],
});
