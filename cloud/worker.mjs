import { personal } from './personal.mjs';

const REPORT_PATH = 'data/reports.json';
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const FILE_KEY = /^(?:thumb-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|webp|gif|bmp|avif|svg|pdf|xlsx|xls|ods|csv|tsv|docx|doc|pptx|txt|md|json|rtf|zip|mp4|webm|mov|m4v|ogv|bin)$/i;
const CONTENT_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif',
  gif: 'image/gif', bmp: 'image/bmp', pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel', csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ods: 'application/vnd.oasis.opendocument.spreadsheet', json: 'application/json',
  txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', rtf: 'application/rtf',
  zip: 'application/zip', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  m4v: 'video/x-m4v', ogv: 'video/ogg'
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  } });
}

function base64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value.replace(/\s/g, ''));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function base64url(value) {
  return fromBase64(value.replace(/-/g, '+').replace(/_/g, '/'));
}

function teamOrigin(env) {
  const raw = String(env.ACCESS_TEAM_DOMAIN || '').trim();
  const url = new URL(raw.startsWith('https://') ? raw : `https://${raw}`);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.cloudflareaccess.com') || url.pathname !== '/') {
    throw new Error('ACCESS_TEAM_DOMAIN is not configured');
  }
  return url.origin;
}

async function verifyIdentity(request, env, audienceName, allowedEmail) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || !env[audienceName]) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(base64url(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(base64url(parts[1])));
    const origin = teamOrigin(env);
    const audiences = String(env[audienceName]).split(',').map(value => value.trim()).filter(Boolean);
    const tokenAudiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== 'RS256' || !header.kid || payload.iss !== origin || !audiences.some(audience => tokenAudiences.includes(audience)) ||
        !Number.isFinite(payload.exp) || payload.exp <= now || (payload.nbf && payload.nbf > now) ||
        !String(payload.email || '').includes('@') ||
        (allowedEmail && String(payload.email || '').toLowerCase() !== allowedEmail.toLowerCase())) return false;
    const response = await fetch(`${origin}/cdn-cgi/access/certs`, { headers: { Accept: 'application/json' } });
    if (!response.ok) return false;
    const jwks = await response.json();
    const jwk = (jwks.keys || []).find(key => key.kid === header.kid && key.kty === 'RSA');
    if (!jwk) return false;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64url(parts[2]), signed);
    return valid ? String(payload.email).toLowerCase() : false;
  } catch (_) {
    return false;
  }
}

const verifyEditor = (request,env) => env.EDITOR_EMAIL ? verifyIdentity(request,env,'ACCESS_AUD',env.EDITOR_EMAIL) : false;

function githubUrl(env, path) {
  const owner = encodeURIComponent(String(env.GITHUB_OWNER || ''));
  const repo = encodeURIComponent(String(env.GITHUB_REPO || ''));
  const file = path.split('/').map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${owner}/${repo}/contents/${file}`;
}

async function github(env, path, options = {}) {
  if (!env.GITHUB_OWNER || !env.GITHUB_REPO || ((options.method || 'GET') !== 'GET' && !env.GITHUB_TOKEN)) throw new Error('GitHub connection is not configured');
  const headers = new Headers(options.headers || {});
  if (env.GITHUB_TOKEN) headers.set('Authorization', `Bearer ${env.GITHUB_TOKEN}`);
  headers.set('Accept', options.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json');
  headers.set('X-GitHub-Api-Version', '2022-11-28');
  headers.set('User-Agent', 'jiangdong-weekly-dashboard');
  if (options.body) headers.set('Content-Type', 'application/json');
  const url = new URL(githubUrl(env, path));
  if (!options.method || options.method === 'GET') url.searchParams.set('ref', env.GITHUB_BRANCH || 'main');
  return fetch(url, { method: options.method || 'GET', headers, body: options.body, redirect: 'follow' });
}

async function metadata(env, path) {
  const response = await github(env, path);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub read failed (${response.status})`);
  return response.json();
}

async function writeFile(env, path, bytes, message, sha) {
  const payload = {
    message,
    content: base64(bytes),
    branch: env.GITHUB_BRANCH || 'main',
    ...(sha ? { sha } : {})
  };
  const response = await github(env, path, { method: 'PUT', body: JSON.stringify(payload) });
  if (response.status === 409 || response.status === 422) return { conflict: true };
  if (!response.ok) throw new Error(`GitHub write failed (${response.status})`);
  const result = await response.json();
  return { sha: result.content?.sha || null, commit: result.commit?.sha || null };
}

async function gitBlobSha(bytes) {
  const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const input = new Uint8Array(prefix.length + bytes.length);
  input.set(prefix);
  input.set(bytes, prefix.length);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', input));
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function validateReports(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 500) return false;
  return entries.every(([key, report]) =>
    /^(?:week|month):\d{4}-\d{2}-\d{2}$/.test(key) &&
    report && typeof report === 'object' && Array.isArray(report.work) && report.work.length <= 100
  );
}

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return origin === new URL(request.url).origin;
}

async function readState(env) {
  const file = await metadata(env, REPORT_PATH);
  if (!file) return json({ reports: {}, sha: null });
  if (file.encoding !== 'base64' || typeof file.content !== 'string') {
    throw new Error('GitHub report file is too large to read through the Contents API');
  }
  const reports = JSON.parse(new TextDecoder().decode(fromBase64(file.content)));
  if (!validateReports(reports)) throw new Error('GitHub report data is invalid');
  return json({ reports, sha: file.sha });
}

async function saveState(request, env) {
  if (!sameOrigin(request)) return json({ error: 'Invalid origin' }, 403);
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: 'Expected JSON' }, 415);
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > 1024 * 1024) return json({ error: 'Report is too large' }, 413);
  const text = await request.text();
  if (text.length > 1024 * 1024) return json({ error: 'Report is too large' }, 413);
  const input = JSON.parse(text);
  if (!validateReports(input.reports)) return json({ error: 'Invalid report data' }, 400);
  const current = await metadata(env, REPORT_PATH);
  if ((current?.sha || null) !== (input.sha || null)) return json({ error: 'Report changed on GitHub', conflict: true }, 409);
  const bytes = new TextEncoder().encode(JSON.stringify(input.reports));
  const result = await writeFile(env, REPORT_PATH, bytes, '更新江东周报数据', current?.sha);
  if (result.conflict) return json({ error: 'Report changed on GitHub', conflict: true }, 409);
  return json({ sha: result.sha, commit: result.commit });
}

async function saveAttachment(request, env, key) {
  if (!sameOrigin(request)) return json({ error: 'Invalid origin' }, 403);
  if (!FILE_KEY.test(key)) return json({ error: 'Invalid attachment name' }, 400);
  const size = Number(request.headers.get('Content-Length') || 0);
  if (size > MAX_ATTACHMENT_BYTES) return json({ error: 'Attachment exceeds 20 MB' }, 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) return json({ error: 'Invalid attachment size' }, 413);
  const path = `data/attachments/${key}`;
  const current = await metadata(env, path);
  if (current) {
    if (current.sha === await gitBlobSha(bytes)) return json({ path, sha: current.sha, unchanged: true });
    return json({ error: 'Attachment name already contains another file', conflict: true }, 409);
  }
  const result = await writeFile(env, path, bytes, `添加周报附件 ${key}`, null);
  if (result.conflict) return json({ error: 'Attachment was added elsewhere', conflict: true }, 409);
  return json({ path, sha: result.sha, commit: result.commit }, 201);
}

async function readAttachment(env, key) {
  if (!FILE_KEY.test(key)) return json({ error: 'Invalid attachment name' }, 400);
  const path = `data/attachments/${key}`;
  const response = await github(env, path, { raw: true });
  if (response.status === 404) return json({ error: 'Attachment not found' }, 404);
  if (!response.ok) throw new Error(`GitHub attachment read failed (${response.status})`);
  const extension = key.split('.').pop().toLowerCase();
  return new Response(response.body, { status: 200, headers: {
    'Content-Type': CONTENT_TYPES[extension] || 'application/octet-stream',
    'Content-Disposition': extension === 'svg' ? 'attachment' : 'inline',
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff'
  } });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/api/state' && request.method === 'GET') return await readState(env);
      const readFile = path.match(/^\/api\/attachments\/([^/]+)$/);
      if (readFile && request.method === 'GET') return await readAttachment(env, readFile[1]);

      if (path === '/app' || path === '/app/' || path.startsWith('/api/user/')) {
        const email = await verifyIdentity(request,env,'USER_ACCESS_AUD');
        if (!email) return json({ error: 'Login required' }, 403);
        if (path === '/app' || path === '/app/') {
          const assetUrl = new URL('/dashboard.html', request.url);
          return env.ASSETS.fetch(new Request(assetUrl,request));
        }
        return personal(request,env,email,validateReports);
      }

      if (path.startsWith('/editor') || path.startsWith('/api/write/')) {
        const email = await verifyEditor(request, env);
        if (!email) return json({ error: 'Editor login required' }, 403);
        if (path === '/api/write/session' && request.method === 'GET') return env.GITHUB_TOKEN ? json({ canEdit: true, email }) : json({ error: 'GitHub write credential is not configured' }, 503);
        if (path === '/api/write/state' && request.method === 'PUT') return await saveState(request, env);
        const writeFile = path.match(/^\/api\/write\/attachments\/([^/]+)$/);
        if (writeFile && request.method === 'PUT') return await saveAttachment(request, env, writeFile[1]);
        if (path === '/editor' || path === '/editor/') {
          const assetUrl = new URL('/dashboard.html', request.url);
          return await env.ASSETS.fetch(new Request(assetUrl, request));
        }
        return json({ error: 'Not found' }, 404);
      }
      if (path === '/') {
        const assetUrl = new URL('/dashboard.html', request.url);
        return await env.ASSETS.fetch(new Request(assetUrl, request));
      }
      return await env.ASSETS.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ event: 'worker_error', message: String(error?.message || error) }));
      return json({ error: 'Cloud sync is unavailable' }, 502);
    }
  }
};

export { verifyEditor, gitBlobSha, validateReports };
