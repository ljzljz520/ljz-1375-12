// 零依赖 HTTP 服务：JSON API + 编辑端静态文件 + 公开构建产物托管。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store, ApiError } from './store.js';
import { runBuild } from './build.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EDITOR_DIR = path.join(ROOT, 'public-editor');
const DIST_DIR = path.join(ROOT, 'dist');
const PORT = parseInt(process.env.PORT || '8080', 10);

// 固定演示令牌（生产应由独立鉴权签发）；角色严格分离，推广仅 promo
export const TOKENS = {
  'tok-editor': { user: '林编辑', role: 'editor' },
  'tok-approver': { user: '周审校', role: 'approver' },
  'tok-promo': { user: '广告管理员', role: 'promo' },
  'tok-viewer': { user: '访客', role: 'viewer' }
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

function auth(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-api-token'] || '');
  const who = TOKENS[token];
  return { token, who };
}
function requireRole(req, roles) {
  const { who } = { who: auth(req).who };
  if (!who) throw new ApiError(401, '未认证');
  if (roles && !roles.includes(who.role)) throw new ApiError(403, `需要角色: ${roles.join('/')}（当前 ${who.role}）`);
  return who;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) reject(new ApiError(413, '请求体过大')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new ApiError(400, 'JSON 解析失败')); } });
    req.on('error', reject);
  });
}
const send = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};
function serveStatic(res, file) {
  if (!file.startsWith(EDITOR_DIR) && !file.startsWith(DIST_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const resource = parts[1];
  const id = parts[2];
  const action = parts[3];
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
  const actor = () => (auth(req).who ? auth(req).who.user : 'anonymous');
  const expectedRev = body.expectedRev || null;

  // 会话 / 自检
  if (resource === 'session' && req.method === 'GET') {
    const { who } = auth(req);
    return send(res, who ? 200 : 401, who || { error: '未认证' });
  }

  if (resource === 'cards') {
    if (!id) {
      if (req.method === 'POST') {
        const who = requireRole(req, ['editor']);
        const card = store.createCard(body.type, body, who.user, { note: body.note });
        return send(res, 201, cardView(card));
      }
      if (req.method === 'GET') {
        const q = url.searchParams.get('type');
        let list = store.allCards();
        if (q) list = list.filter((c) => c.type === q);
        if (url.searchParams.get('active') === '1') list = list.filter((c) => !c.mergedInto);
        return send(res, 200, list.map((c) => cardView(c)));
      }
    } else {
      const card = store.getCard(id);
      if (!card) throw new ApiError(404, '卡片不存在');
      if (req.method === 'GET') return send(res, 200, cardView(card, { full: true }));
      if (action === 'revisions' && req.method === 'POST') {
        const who = requireRole(req, ['editor']);
        const updated = store.addRevision(id, body, who.user, { note: body.note, expectedRev });
        return send(res, 200, cardView(updated));
      }
      if (action === 'impact' && req.method === 'GET') {
        requireRole(req, ['editor', 'approver']);
        return send(res, 200, store.impactForPerson(id));
      }
      if (action === 'merge' && req.method === 'POST') {
        const who = requireRole(req, ['editor']);
        const result = await store.mergeCards(id, body.mergedId, who.user,
          body.expectedRev ? { expectedRev: body.expectedRev } : {});
        return send(res, 200, { report: result.report, survivor: cardView(result.survivor) });
      }
      if (action === 'unmerge' && req.method === 'POST') {
        const who = requireRole(req, ['editor']);
        const result = await store.unmergeCards(id, who.user);
        return send(res, 200, { report: result.report, restored: cardView(result.restored) });
      }
      if (action === 'promo' && req.method === 'PUT') {
        const who = requireRole(req, ['promo']);
        const p = store.setPromo(id, body.enabled, body.note, who.user);
        return send(res, 200, p);
      }
    }
  }

  if (resource === 'impacts' && id && action === 'decision' && req.method === 'POST') {
    const who = requireRole(req, ['editor']);
    const st = store.resolveImpact(decodeURIComponent(id), body.decision, who.user);
    return send(res, 200, { ok: true, statementId: st.id });
  }
  if (resource === 'impacts' && req.method === 'GET') {
    requireRole(req, ['editor', 'approver']);
    return send(res, 200, { pending: store.pendingImpacts() });
  }

  if (resource === 'sources') {
    if (!id && req.method === 'POST') {
      const who = requireRole(req, ['editor']);
      return send(res, 201, store.createSource(body, who.user));
    }
    if (id && action === 'rights' && req.method === 'PUT') {
      const who = requireRole(req, ['editor']);
      return send(res, 200, store.setSourceRights(id, body.rights, body.rightsNote, who.user));
    }
    if (id && req.method === 'GET') return send(res, 200, store.getSource(id));
    if (!id && req.method === 'GET') return send(res, 200, Object.values(store.state.sources));
  }

  if (resource === 'releases') {
    if (id === 'latest' && req.method === 'GET') {
      const rel = store.currentRelease();
      if (!rel) throw new ApiError(404, '尚未发布任何公开版本');
      if (action === 'data' || url.searchParams.get('data') === '1') return send(res, 200, rel.snapshot);
      const { snapshot, ...m } = rel;
      return send(res, 200, { ...m, cardCount: Object.keys(snapshot.cards).length });
    }
    if (req.method === 'GET') {
      const releases = store.state.releases.map(({ snapshot, ...m }) => ({ ...m, cardCount: Object.keys(snapshot.cards).length }));
      return send(res, 200, releases);
    }
    if (req.method === 'POST') {
      requireRole(req, ['approver']);
      const meta = await store.publish(auth(req).who.user, body.note);
      return send(res, 201, meta);
    }
  }

  if (resource === 'build' && req.method === 'POST') {
    requireRole(req, ['approver']);
    const result = runBuild(store, { persistRelease: body.persist !== false });
    return send(res, 200, result);
  }

  throw new ApiError(404, `未知接口: ${req.method} ${url.pathname}`);
}

// 编辑端视图：完整修订链与当前正文（不暴露推广编辑能力给非 promo）
function cardView(card, opts = {}) {
  const cur = card.revisions[card.revisions.length - 1];
  const base = {
    id: card.id, type: card.type, createdAt: card.createdAt,
    mergedInto: card.mergedInto, mergedAt: card.mergedAt, mergeReport: card.mergeReport || null,
    periods: card.periods || null,
    current: { revisionId: cur.id, rev: cur.rev, at: cur.at, actor: cur.actor, note: cur.note, body: cur.body },
    promo: store.state.promo[card.id] || null
  };
  if (opts.full) base.revisions = card.revisions.map((r) => ({ revisionId: r.id, rev: r.rev, at: r.at, actor: r.actor, note: r.note }));
  if (card.unmergeReports) base.unmergeReports = card.unmergeReports;
  return base;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname === '/site' || url.pathname.startsWith('/site/')) {
      let p = url.pathname.replace(/^\/site\/?/, '') || 'index.html';
      const file = path.normalize(path.join(DIST_DIR, p));
      if (!file.startsWith(DIST_DIR)) { res.writeHead(403); return res.end('forbidden'); }
      return serveStatic(res, fs.existsSync(file) ? file : path.join(DIST_DIR, 'index.html'));
    }
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(EDITOR_DIR, p);
    return serveStatic(res, file);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    send(res, status, { error: e.message, ...(e.allErrors ? { allErrors: e.allErrors } : {}), ...(e.pending ? { pending: e.pending } : {}) });
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => console.log(`商号史料关系库: http://localhost:${PORT}/ （公开站点 /site/）`));
}
export { server };
