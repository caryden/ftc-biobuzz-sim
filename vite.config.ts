import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Saves match traces and annotations into the repository's traces/ folder, so that they can be read from disk later.
 * POST /api/trace/<name> with a JSON body writes traces/<name>.json. POST /api/notes/<name> with { json, markdown }
 * writes traces/<name>.annotations.json and traces/<name>.annotations.md. GET /api/traces lists the saved traces.
 */
function traceStore(): Plugin {
  const dir = path.resolve('traces'), safe = (n: string) => n.replace(/[^A-Za-z0-9_-]/g, '');
  return {
    name: 'trace-store',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '', send = (code: number, body: unknown) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
        if (!url.startsWith('/api/trace') && !url.startsWith('/api/notes')) return next();
        fs.mkdirSync(dir, { recursive: true });
        if (req.method === 'GET' && url === '/api/traces') return send(200, fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('annotations')).sort().reverse());
        if (req.method === 'GET' && url.startsWith('/api/trace/')) { const f = path.join(dir, `${safe(url.slice(11))}.json`); return fs.existsSync(f) ? (res.setHeader('content-type', 'application/json'), res.end(fs.readFileSync(f))) : send(404, { error: 'No such trace' }); }
        if (req.method !== 'POST') return send(405, { error: 'Use GET or POST' });
        let raw = ''; for await (const chunk of req) raw += chunk;
        if (url.startsWith('/api/trace/')) { fs.writeFileSync(path.join(dir, `${safe(url.slice(11))}.json`), raw); return send(200, { saved: `traces/${safe(url.slice(11))}.json` }); }
        const name = safe(url.slice(11)), body = JSON.parse(raw);
        fs.writeFileSync(path.join(dir, `${name}.annotations.json`), JSON.stringify(body.json, null, 1)); fs.writeFileSync(path.join(dir, `${name}.annotations.md`), body.markdown);
        return send(200, { saved: `traces/${name}.annotations.md` });
      });
    },
  };
}

/** Serves public/lab/ and public/lessons/ at their folder URLs in the dev server, as Cloudflare Pages does on the deployed site. */
function folderIndex(): Plugin {
  return { name: 'folder-index', configureServer(server) { server.middlewares.use((req, _res, next) => { if (req.url === '/lab/' || req.url === '/lessons/') req.url += 'index.html'; next(); }); } };
}

// src/main.ts awaits the physics engine at the top level, which needs an ES2022 target: Chrome 89, Firefox 89, Safari 15.
export default defineConfig({ plugins: [folderIndex(), traceStore()], build: { target: 'es2022', rollupOptions: { input: { home: 'index.html', sim: 'sim/index.html' } } } });
