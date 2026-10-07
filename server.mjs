import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, DATA_FILE } from './lib/store.mjs';
import * as domain from './lib/domain.mjs';
import { buildStatic } from './scripts/build.mjs';

const PORT = Number(process.env.PORT || 3000);
const ROOT = process.cwd();
const WEB = path.join(ROOT, 'web');
const store = new Store(DATA_FILE);

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function sendError(res, err) {
  send(res, err.status || 500, { error: err.message || String(err), issues: err.issues });
}

async function readJson(req) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return {};
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((x) => x.trim().split('=')).filter((x) => x.length === 2));
}

function currentUser(db, req) {
  const cookies = parseCookies(req);
  const username = req.headers['x-user'] || cookies.archive_user;
  return username ? db.users[username] : null;
}

function requireUser(db, req, role) {
  const user = currentUser(db, req);
  if (!user) throw Object.assign(new Error('请先登录。'), { status: 401 });
  if (role && !user.roles.includes(role)) throw Object.assign(new Error(`权限不足：需要 ${role} 权限。商业推广标识与故事正文权限分离。`), { status: 403 });
  return user;
}

const routes = [];
function route(method, pattern, roles, fn, mutation = true) {
  routes.push({ method, pattern, roles, fn, mutation, regex: new RegExp(`^${pattern.replace(/:[^/]+/g, '([^/]+)')}$`) });
}

function collectionRoutes(name, createFn, updateFn, role = 'editor') {
  route('GET', `/api/${name}`, null, async (db) => Object.values(db[name]), false);
  route('POST', `/api/${name}`, role, async (db, body, user) => createFn(db, body, user.username));
  if (updateFn) route('PATCH', `/api/${name}/:id`, role, async (db, body, user, m) => updateFn(db, m[1], body, user.username));
}

collectionRoutes('subjects', domain.createSubject, domain.updateSubject);
collectionRoutes('persons', domain.createPerson, null);
route('PATCH', '/api/persons/:id', 'editor', async (db, body, user, m) => domain.updatePerson(db, m[1], body, user.username));
collectionRoutes('places', domain.createPlace, domain.updatePlace);
collectionRoutes('periods', domain.createPeriod, domain.updatePeriod);
collectionRoutes('events', domain.createEvent, null);
collectionRoutes('signs', domain.createSign, domain.updateSign);
collectionRoutes('sources', domain.createSource, null);
route('PATCH', '/api/sources/:id', 'editor', async (db, body, user, m) => domain.updateSource(db, m[1], body, user.username));
collectionRoutes('media', domain.createMedia, null);
collectionRoutes('statements', domain.createStatement, null);
route('GET', '/api/merges', null, async (db) => Object.values(db.merges), false);
route('GET', '/api/pendingChanges', null, async (db, user) => user?.roles.includes('approver') ? Object.values(db.pendingChanges) : [], false);
route('GET', '/api/promotions', null, async (db, user) => user ? Object.values(db.promotions) : [], false);
route('GET', '/api/me', null, async (db, body, user) => user || null, false);

route('POST', '/api/founding-claims', 'editor', (db, body, user) => domain.createFoundingClaim(db, body, user.username));
route('POST', '/api/statements/:id/confirm-date', 'editor', (db, body, user, m) => domain.confirmInferredDate(db, m[1], body, user.username));
route('POST', '/api/statements/:id/retract', 'editor', (db, body, user, m) => domain.retractStatement(db, m[1], body.reason, user.username));
route('POST', '/api/relocations', 'editor', (db, body, user) => domain.createRelocationAndSplit(db, body, user.username));
route('POST', '/api/events/:id/confirm-date', 'editor', (db, body, user, m) => domain.confirmEventDate(db, m[1], body, user.username));
route('POST', '/api/media/:id/withdraw', 'editor', (db, body, user, m) => domain.withdrawMediaRights(db, m[1], body, user.username));
route('POST', '/api/merges', 'editor', (db, body, user) => domain.mergeSubjects(db, body, user.username));
route('POST', '/api/merges/:id/unmerge', 'editor', (db, body, user, m) => domain.unmergeSubjects(db, m[1], user.username));
route('POST', '/api/promotions', 'promotion', (db, body, user) => domain.upsertPromotion(db, body, user.username));
route('GET', '/api/pending', 'approver', (db) => ({ pending: Object.values(db.pendingChanges), personRevisions: Object.values(db.personRevisions) }), false);
route('POST', '/api/pending/:id/approve', 'approver', (db, body, user, m) => domain.approvePending(db, m[1], user.username, body));
route('POST', '/api/pending/:id/reject', 'approver', (db, body, user, m) => domain.rejectPending(db, m[1], user.username, body));
route('POST', '/api/publications', 'approver', (db, body, user) => domain.publishSnapshot(db, { actor: user.username, note: body?.note || '' }));
route('GET', '/api/publications', null, async (db) => Object.values(db.publications).sort((a, b) => b.version - a.version).map(({ snapshot, data, ...meta }) => ({ ...meta, hasSnapshot: Boolean(snapshot || data) })), false);
route('GET', '/api/publications/:id', null, async (db, body, user, m) => {
  const p = db.publications[m[1]];
  if (!p) throw Object.assign(new Error('发布版本不存在'), { status: 404 });
  return p.snapshot || { ...p, data: p.data };
}, false);
route('GET', '/api/public/current', null, async (db) => {
  const p = Object.values(db.publications).filter((x) => x.status === 'published').sort((a, b) => b.version - a.version)[0];
  if (!p) throw Object.assign(new Error('尚未发布公开版本'), { status: 404 });
  return p.snapshot || { ...p, data: p.data };
}, false);
route('POST', '/api/build', 'approver', async () => buildStatic({}), false);
route('POST', '/api/auth/login', null, async (db, body) => {
  const user = db.users[body.username];
  if (!user) throw Object.assign(new Error('未知用户'), { status: 401 });
  return { user };
}, false, true);

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const body = await readJson(req);
  let dbUser = null;
  const match = routes.find((r) => r.method === req.method && r.regex.test(pathname));
  if (!match) return send(res, 404, { error: `没有接口：${req.method} ${pathname}` });
  try {
    const result = await store.read(async (db) => {
      dbUser = match.roles ? requireUser(db, req, match.roles) : (pathname.startsWith('/api/') ? currentUser(db, req) : null);
      const m = pathname.match(match.regex);
      const run = () => match.fn(db, body, dbUser, m, req);
      return match.mutation === false ? run() : store.mutation(run);
    });
    if (pathname === '/api/auth/login') {
      return send(res, 200, result, { 'set-cookie': `archive_user=${encodeURIComponent(body.username)}; Path=/; HttpOnly; SameSite=Lax` });
    }
    return send(res, 200, { ok: true, result });
  } catch (err) {
    return sendError(res, err);
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8' };
async function serveFile(res, file) {
  const data = await fs.readFile(file);
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(data);
}

async function serveStatic(req, res, url) {
  let urlPath = decodeURIComponent(url.pathname);
  if (urlPath === '/' || urlPath === '/app') return serveFile(res, path.join(WEB, 'index.html'));
  const safe = path.normalize(urlPath).replace(/^([/\\]+)/, '');
  const candidates = [path.join(WEB, safe)];
  for (const candidate of candidates) {
    if (!candidate.startsWith(WEB)) return send(res, 403, { error: '路径越界' });
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return await serveFile(res, candidate);
    } catch {}
  }
  // Client-side route fallback.
  if (!urlPath.startsWith('/api/')) return serveFile(res, path.join(WEB, 'index.html'));
  return send(res, 404, { error: '不存在' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (err) {
    return sendError(res, err);
  }
});

export async function initServer({ listen: shouldListen = false, port = PORT } = {}) {
  await store.load(true);
  await store.mutation((db) => {
    if (!Object.values(db.publications).some((p) => p.status === 'published')) return domain.publishSnapshot(db, { actor: 'admin', note: '初始公开数据版本' });
  });
  if (shouldListen) server.listen(port, () => console.log(`商号史料关系库：http://localhost:${port}`));
  return server;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  await initServer({ listen: true });
}

export { server, store };
