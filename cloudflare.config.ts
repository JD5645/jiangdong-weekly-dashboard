import { bindings, defineConfig } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'jiangdong-weekly-dashboard',
    entrypoint: './cloud/worker.mjs',
    compatibilityDate: '2026-11-17',
    assets: {
      htmlHandling: 'none',
      notFoundHandling: 'none',
      runWorkerFirst: ['/', '/app', '/app/*', '/editor', '/editor/*', '/api/*'],
    },
    env: {
      ASSETS: bindings.assets(),
      GITHUB_OWNER: bindings.text('JD5645'),
      GITHUB_REPO: bindings.text('jiangdong-weekly-dashboard'),
      GITHUB_BRANCH: bindings.text('main'),
      GITHUB_TOKEN: bindings.secret(),
      DB: bindings.d1({ name: 'jiangdong-personal-reports', id: 'b6134810-13f0-4352-9541-150628d306e3' }),
      USER_ACCESS_AUD: bindings.text('1b7cb3f6f2e10102e2ade4139c0b0805433423ccd16ae068014f8007d223f890'),
      EDITOR_EMAIL: bindings.text('2978357684@qq.com'),
      ACCESS_TEAM_DOMAIN: bindings.text('https://damp-math-03bb.cloudflareaccess.com'),
      ACCESS_AUD: bindings.text('790a81434a225cae4366dd1c79d9caa41e2938de03845d4b84cf825a57085d3c,3f697ddd4872870526d9a4fb72a591c2581ef303124a8dc62f20582c64276fe9'),
    },
    observability: { enabled: true },
  },
});
