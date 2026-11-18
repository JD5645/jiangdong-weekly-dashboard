// Cloudflare Pages entrypoint for the public dashboard and owner editor.
// Pages Access protects /editor* and /api/write/* before this function runs.
export default {
  async fetch(request, env) {
    if (!env.DASHBOARD) {
      return new Response('Dashboard service binding is missing', { status: 503 });
    }
    return env.DASHBOARD.fetch(request);
  },
};
