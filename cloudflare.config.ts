import { bindings, defineConfig } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'jiangdong-weekly-dashboard',
    entrypoint: './cloud/worker.mjs',
    compatibilityDate: '2026-11-17',
    assets: {
      notFoundHandling: 'none',
      runWorkerFirst: ['/', '/editor', '/editor/*', '/api/*'],
    },
    env: {
      ASSETS: bindings.assets(),
      GITHUB_OWNER: bindings.text('JD5645'),
      GITHUB_REPO: bindings.text('jiangdong-weekly-dashboard'),
      GITHUB_BRANCH: bindings.text('main'),
      EDITOR_EMAIL: bindings.text('2978357684@qq.com'),
      GITHUB_TOKEN: bindings.secret(),
      ACCESS_TEAM_DOMAIN: bindings.text('https://damp-math-03bb.cloudflareaccess.com'),
      ACCESS_AUD: bindings.text('790a81434a225cae4366dd1c79d9caa41e2938de03845d4b84cf825a57085d3c'),
    },
    observability: { enabled: true },
  },
});
