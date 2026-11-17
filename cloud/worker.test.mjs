import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { after, test } from 'node:test';
import worker from './worker.mjs';

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
jwk.kid = 'test-key';
const files = new Map();
const env = {
  ACCESS_TEAM_DOMAIN: 'https://test.cloudflareaccess.com',
  ACCESS_AUD: 'dashboard-editor',
  EDITOR_EMAIL: '2978357684@qq.com',
  GITHUB_TOKEN: 'mock-token',
  GITHUB_OWNER: 'JD5645',
  GITHUB_REPO: 'jiangdong-weekly-dashboard',
  GITHUB_BRANCH: 'main',
  ASSETS: { fetch: async () => new Response('dashboard', { headers: { 'Content-Type': 'text/html' } }) },
};

function jwt(email = env.EDITOR_EMAIL) {
  const encode = data => Buffer.from(JSON.stringify(data)).toString('base64url');
  const head = encode({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' });
  const body = encode({ iss: env.ACCESS_TEAM_DOMAIN, aud: [env.ACCESS_AUD], email, exp: Math.floor(Date.now() / 1000) + 600 });
  const content = `${head}.${body}`;
  return `${content}.${sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url')}`;
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  if (url.hostname === 'test.cloudflareaccess.com') return Response.json({ keys: [jwk] });
  assert.equal(url.hostname, 'api.github.com');
  assert.equal(init.headers.get('Authorization'), 'Bearer mock-token');
  const path = decodeURIComponent(url.pathname.split('/contents/')[1]);
  const method = init.method || 'GET';
  const stored = files.get(path);
  if (method === 'GET') {
    if (!stored) return new Response(null, { status: 404 });
    if (init.headers.get('Accept') === 'application/vnd.github.raw+json') return new Response(stored.bytes);
    return Response.json({ sha: stored.sha, encoding: 'base64', content: stored.bytes.toString('base64') });
  }
  assert.equal(method, 'PUT');
  const payload = JSON.parse(init.body);
  if (stored && stored.sha !== payload.sha) return Response.json({}, { status: 409 });
  if (!stored && payload.sha) return Response.json({}, { status: 409 });
  const bytes = Buffer.from(payload.content, 'base64');
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  files.set(path, { bytes, sha });
  return Response.json({ content: { sha }, commit: { sha: 'commit-' + sha } }, { status: stored ? 200 : 201 });
};

const invoke = (path, { method = 'GET', body, token, headers = {} } = {}) => worker.fetch(new Request(`https://dashboard.example${path}`, {
  method,
  headers: { ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}), ...headers },
  body,
}), env);

test('public reads work while writes require the configured editor identity', async () => {
  const publicState = await invoke('/api/state');
  assert.equal(publicState.status, 200);
  assert.deepEqual(await publicState.json(), { reports: {}, sha: null });
  assert.equal((await invoke('/')).status, 200);
  assert.equal((await invoke('/editor/')).status, 403);
  assert.equal((await invoke('/api/write/session', { token: jwt('other@example.com') })).status, 403);
  const session = await invoke('/api/write/session', { token: jwt() });
  assert.equal((await session.json()).canEdit, true);
});

test('editor upload and report save are committed to GitHub, with conflict detection', async () => {
  const token = jwt();
  const attachment = '11111111-1111-4111-8111-111111111111.pdf';
  const bytes = Buffer.from('%PDF-1.7\nexample');
  const upload = await invoke(`/api/write/attachments/${attachment}`, {
    method: 'PUT', token, body: bytes,
    headers: { Origin: 'https://dashboard.example', 'Content-Type': 'application/pdf' },
  });
  assert.equal(upload.status, 201, await upload.clone().text());
  assert.equal((await upload.json()).path, `data/attachments/${attachment}`);
  const reports = { 'week:2026-11-09': { work: [{ title: '色卡', attachments: [{ cloudPath: `data/attachments/${attachment}` }] }] } };
  const save = await invoke('/api/write/state', {
    method: 'PUT', token, body: JSON.stringify({ sha: null, reports }),
    headers: { Origin: 'https://dashboard.example', 'Content-Type': 'application/json' },
  });
  assert.equal(save.status, 200);
  const state = await (await invoke('/api/state')).json();
  assert.deepEqual(state.reports, reports);
  assert.ok(state.sha);
  const conflict = await invoke('/api/write/state', {
    method: 'PUT', token, body: JSON.stringify({ sha: null, reports }),
    headers: { Origin: 'https://dashboard.example', 'Content-Type': 'application/json' },
  });
  assert.equal(conflict.status, 409);
  const download = await invoke(`/api/attachments/${attachment}`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
});

test('GitHub credential failures return a handled sync error', async () => {
  const mockFetch = globalThis.fetch;
  const mockError = console.error;
  globalThis.fetch = async () => Response.json({ message: 'Bad credentials' }, { status: 401 });
  console.error = () => {};
  try {
    const response = await invoke('/api/state');
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Cloud sync is unavailable' });
  } finally {
    globalThis.fetch = mockFetch;
    console.error = mockError;
  }
});
