import { promises as fs } from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.join(process.cwd(), 'data');
export const DATA_FILE = path.join(DATA_DIR, 'store.json');
export const PUBLIC_DIR = path.join(process.cwd(), 'dist');

export function nowIso() {
  return new Date().toISOString();
}

export function emptyDb() {
  return {
    schemaVersion: 1,
    counters: {},
    users: {
      editor1: { username: 'editor1', displayName: '史料编辑甲', roles: ['editor'] },
      editor2: { username: 'editor2', displayName: '史料编辑乙', roles: ['editor'] },
      promoter: { username: 'promoter', displayName: '商业标识管理员', roles: ['promotion'] },
      admin: { username: 'admin', displayName: '总编辑', roles: ['editor', 'promotion', 'approver'] }
    },
    subjects: {},
    persons: {},
    places: {},
    periods: {},
    events: {},
    signs: {},
    statements: {},
    sources: {},
    media: {},
    promotions: {},
    merges: {},
    personRevisions: {},
    pendingChanges: {},
    approvals: {},
    publications: {},
    audit: []
  };
}

export class Store {
  constructor(file = DATA_FILE) {
    this.file = file;
    this.db = emptyDb();
    this.chain = Promise.resolve();
  }

  async load(seed = true) {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.db = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.db = emptyDb();
      if (seed) await import('./seed.mjs').then((m) => m.seed(this.db));
      await this.save();
    }
    return this.db;
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await fs.writeFile(tmp, JSON.stringify(this.db, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }

  // A tiny process-local mutex. The JSON store is intended for small teams and
  // the test/dev server, but merges and approvals still need read-modify-write
  // atomicity against concurrent requests.
  mutation(fn) {
    const run = this.chain.then(async () => {
      const result = await fn(this.db);
      await this.save();
      return result;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  read(fn) {
    return fn(this.db);
  }
}

export function nextId(db, prefix) {
  db.counters[prefix] = (db.counters[prefix] || 0) + 1;
  return `${prefix}_${String(db.counters[prefix]).padStart(4, '0')}`;
}

export function recordAudit(db, { actor, action, entityType, entityId, details = {} }) {
  const id = nextId(db, 'audit');
  const item = { id, at: nowIso(), actor, action, entityType, entityId, details };
  db.audit.push(item);
  if (db.audit.length > 5000) db.audit = db.audit.slice(-5000);
  return item;
}

export function mustExist(collection, id, label = '记录') {
  const item = collection[id];
  if (!item) {
    const err = new Error(`${label}不存在：${id}`);
    err.status = 404;
    throw err;
  }
  return item;
}

export function requireFields(body, fields) {
  const missing = fields.filter((name) => body[name] === undefined || body[name] === null || body[name] === '');
  if (missing.length) {
    const err = new Error(`缺少必填字段：${missing.join('、')}`);
    err.status = 400;
    throw err;
  }
}
