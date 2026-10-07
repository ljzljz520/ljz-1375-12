// 存储层：JSON 持久化 + 串行写锁。卡片=实体，每次正文改动生成新修订（不可变）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sha256, newId, validateCardBody, extractRefs, outgoingRefs, detectCycle,
  parseHistDate, canonicalJson
} from './domain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

class Store {
  constructor() {
    this.queue = Promise.resolve();
    this.state = null;
  }

  init() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
      this.state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } else {
      this.state = {
        cards: {}, sources: {}, releases: [],
        promo: {}, // cardId -> { enabled, note, updatedBy, updatedAt }
        seq: 1
      };
      this.persist();
    }
    return this;
  }

  // 所有写操作串行化，避免“两位编辑同时合并”竞态
  async withLock(fn) {
    const run = this.queue.then(() => fn());
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  persist() {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }

  seqId(prefix) { return `${prefix}${this.state.seq++}`; }

  // ---------- 查询 ----------
  getCard(id) { return this.state.cards[id] || null; }
  getSource(id) { return this.state.sources[id] || null; }
  allCards() { return Object.values(this.state.cards); }
  follow(id) {
    const c = this.state.cards[id];
    return c && c.mergedInto ? this.follow(c.mergedInto) : id;
  }
  currentRevision(card) { return card.revisions[card.revisions.length - 1]; }
  pinnedRevision(card, revId) { return card.revisions.find((r) => r.id === revId) || null; }
  currentRelease() {
    return this.state.releases.length ? this.state.releases[this.state.releases.length - 1] : null;
  }

  // ---------- 出处 ----------
  createSource(input, actor) {
    const errors = [];
    if (!input.title || !input.title.trim()) errors.push('出处标题必填');
    if (input.kind === 'image' && !input.uri && !input.embedded) errors.push('图片出处需要 uri 或 embedded');
    if (errors.length) throw new ApiError(400, errors.join('；'));
    const id = this.seqId('S');
    const src = {
      id, kind: input.kind || 'document', title: input.title.trim(),
      author: input.author || null, citation: input.citation || '',
      uri: input.uri || null, embedded: input.embedded || null,
      rights: input.rights || 'unknown', // unknown | licensed | withdrawn
      rightsNote: input.rightsNote || '',
      createdAt: new Date().toISOString(), createdBy: actor
    };
    this.state.sources[id] = src;
    this.persist();
    return src;
  }

  // 撤权（例如来源图片撤权）：不删除出处，只标记；发布构建据此剔除图片
  setSourceRights(sourceId, rights, rightsNote, actor) {
    const src = this.getSource(sourceId);
    if (!src) throw new ApiError(404, '出处不存在');
    if (!['unknown', 'licensed', 'withdrawn'].includes(rights)) throw new ApiError(400, 'rights 非法');
    src.rights = rights;
    src.rightsNote = rightsNote ?? src.rightsNote;
    src.rightsUpdatedAt = new Date().toISOString();
    src.rightsUpdatedBy = actor;
    this.persist();
    return src;
  }

  // ---------- 卡片与修订 ----------
  createCard(type, body, actor, opts = {}) {
    const errors = validateCardBody(type, body);
    if (errors.length) throw new ApiError(400, errors.join('；'));
    const id = opts.id || this.seqId(type === 'shop' ? 'H' : type === 'person' ? 'P' : type === 'place' ? 'L' : 'Z');
    if (this.state.cards[id]) throw new ApiError(409, '卡片 ID 已存在');
    const revId = this.seqId('R');
    const card = {
      id, type, createdAt: new Date().toISOString(), createdBy: actor,
      mergedInto: null, mergedAt: null, akaPartOf: [],
      periods: body.periods || null, // 按时期拆记录：[{label, fromRaw, toRaw, statementIds}]
      revisions: [{
        id: revId, rev: 1, note: opts.note || '创立卡片', actor,
        at: new Date().toISOString(), body: normalizeBody(type, body)
      }]
    };
    this.state.cards[id] = card;
    this.assertRefsExist(card);
    const cyc = detectCycle(new Map(Object.entries(this.state.cards)), id);
    if (cyc) { delete this.state.cards[id]; throw new ApiError(409, `循环引用被拒绝: ${cyc.join(' -> ')}`); }
    this.persist();
    return card;
  }

  addRevision(cardId, body, actor, opts = {}) {
    const card = this.requireActive(cardId);
    if (opts.expectedRev && this.currentRevision(card).id !== opts.expectedRev) {
      throw new ApiError(409, `修订冲突：期望基于 ${opts.expectedRev}，当前已到 ${this.currentRevision(card).id}`);
    }
    const errors = validateCardBody(card.type, body);
    if (errors.length) throw new ApiError(400, errors.join('；'));
    const rev = {
      id: this.seqId('R'), rev: card.revisions.length + 1,
      note: opts.note || '编辑修订', actor, at: new Date().toISOString(),
      body: normalizeBody(card.type, body)
    };
    card.revisions.push(rev);
    if (body.periods !== undefined) card.periods = body.periods;
    this.assertRefsExist(card);
    const cyc = detectCycle(new Map(Object.entries(this.state.cards)), cardId);
    if (cyc) { card.revisions.pop(); throw new ApiError(409, `循环引用被拒绝: ${cyc.join(' -> ')}`); }
    this.persist();
    return card;
  }

  assertRefsExist(card) {
    const missing = new Set();
    for (const st of this.currentRevision(card).body.statements) {
      for (const e of extractRefs(st)) {
        if (!this.state.cards[e.to]) missing.add(e.to);
      }
      for (const sid of st.sourceIds) if (!this.state.sources[sid]) missing.add(`出处:${sid}`);
    }
    if (missing.size) throw new ApiError(400, `引用目标不存在: ${[...missing].join(', ')}`);
  }

  requireActive(id) {
    const card = this.state.cards[id];
    if (!card) throw new ApiError(404, '卡片不存在');
    if (card.mergedInto) throw new ApiError(409, `卡片已合并入 ${card.mergedInto}，请在存活实体上操作`);
    return card;
  }

  // ---------- 合并：同名商号不一定是同一主体，合并必须显式 ----------
  mergeCards(survivorId, mergedId, actor, opts = {}) {
    return this.withLock(() => this._mergeImpl(survivorId, mergedId, actor, opts));
  }

  _mergeImpl(survivorId, mergedId, actor, opts = {}) {
    if (survivorId === mergedId) throw new ApiError(400, '不能与自身合并');
    const a = this.requireActive(survivorId);
    const b = this.requireActive(mergedId);
    if (a.type !== b.type) throw new ApiError(400, `类型不一致（${a.type} vs ${b.type}），不能合并`);
    if (opts.expectedRev) {
      const cur = [this.currentRevision(a).id, this.currentRevision(b).id].sort().join(',');
      const want = [...opts.expectedRev].sort().join(',');
      if (cur !== want) throw new ApiError(409, `并发冲突：两卡修订已变化（当前 ${cur}）`);
    }
    const revA = this.currentRevision(a);
    const revB = this.currentRevision(b);

    // 预检：在深拷贝上模拟合并后的重定向，先做循环检测，再真正落盘（不得污染真实状态）
    const clone = new Map(Object.entries(JSON.parse(JSON.stringify(this.state.cards))));
    const simulated = new Map();
    for (const [cid, card] of clone) {
      simulated.set(cid, { ...card,
        mergedInto: cid === mergedId ? survivorId : card.mergedInto,
        akaPartOf: cid === survivorId ? [...new Set([...(card.akaPartOf || []), mergedId])] : card.akaPartOf });
    }
    // 在模拟图中临时改指并入方引用
    for (const c of simulated.values()) {
      if (c.id === a.id || c.mergedInto || c.id === mergedId) continue;
      const simStmts = c.revisions[c.revisions.length - 1].body.statements;
      for (const st of simStmts) {
        if (extractRefs(st).some((e) => e.to === mergedId)) rewriteRef(st.value, null, mergedId, survivorId);
      }
    }
    const preCyc = detectCycle(simulated, survivorId);
    if (preCyc) throw new ApiError(409, `合并将产生循环引用: ${preCyc.join(' -> ')}`);

    // 迁移规则：正文以存活卡为主，并入方陈述去重后追加（保留各自出处与日期，冲突不覆盖）
    const have = new Set(revA.body.statements.map((s) => statementKey(s)));
    const migrated = [];
    for (const st of revB.body.statements) {
      const key = statementKey(st);
      if (have.has(key)) continue;
      const copy = JSON.parse(JSON.stringify(st));
      copy.id = this.seqId('T');
      copy.migratedFromCard = mergedId;
      copy.migratedFromStatement = st.id;
      revA.body.statements.push(copy);
      migrated.push(copy.id);
      have.add(key);
    }
    // 异名加入别名
    if (revB.body.name && revB.body.name !== revA.body.name) {
      revA.body.aliases = [...new Set([...(revA.body.aliases || []), revB.body.name, ...(revB.body.aliases || [])])];
    }
    // 迁移规则：对并入方的全部入引用改指存活卡（旧引用版本仍钉在旧修订快照里）
    const redirects = [];
    for (const c of this.allCards()) {
      if (c.id === a.id || c.id === mergedId || c.mergedInto) continue;
      for (const st of this.currentRevision(c).body.statements) {
        for (const e of extractRefs(st)) {
          if (e.to === mergedId) redirects.push({ card: c.id, statement: st.id, field: e.field });
        }
      }
    }
    for (const r of redirects) {
      const st = this.currentRevision(this.state.cards[r.card]).body.statements.find((x) => x.id === r.statement);
      rewriteRef(st.value, r.field, mergedId, survivorId);
    }
    b.mergedInto = survivorId;
    b.mergedAt = new Date().toISOString();
    b.mergedBy = actor;
    b.mergeReport = { mergedId, survivorId, migratedStatementIds: migrated, redirects, at: b.mergedAt };
    a.akaPartOf = [...new Set([...(a.akaPartOf || []), mergedId])];

    this.persist();
    return { survivor: a, merged: b, report: b.mergeReport };
  }

  // ---------- 撤销合并 ----------
  unmergeCards(mergedId, actor) {
    return this.withLock(() => this._unmergeImpl(mergedId, actor));
  }

  _unmergeImpl(mergedId, actor) {
    const b = this.state.cards[mergedId];
    if (!b || !b.mergedInto) throw new ApiError(400, '该卡未处于合并状态');
    const aId = b.mergedInto;
    const a = this.state.cards[aId];
    const report = b.mergeReport;
    if (!report) throw new ApiError(400, '缺少合并报告，无法撤销');

    // 迁移规则逆向：把当时迁移的陈述撤回存活卡（若存活卡后来又改过这些陈述，列入人工核对）
    const movedOut = [];
    const reviewNeeded = [];
    for (const tid of report.migratedStatementIds) {
      const idx = this.currentRevision(a).body.statements.findIndex((s) => s.id === tid);
      if (idx >= 0) {
        const [st] = this.currentRevision(a).body.statements.splice(idx, 1);
        movedOut.push(st);
        if (st.migratedFromStatement) {
          const orig = b.revisions[b.revisions.length - 1].body.statements.find((x) => x.id === st.migratedFromStatement);
          if (orig && canonicalJson(scrubMigrate(st)) !== canonicalJson(scrubMigrate(orig))) {
            reviewNeeded.push({ statementId: tid, reason: '迁移后该陈述在存活卡上被继续编辑过，需人工核对' });
          }
        }
      } else {
        reviewNeeded.push({ statementId: tid, reason: '迁移陈述已不在存活卡当前版本' });
      }
    }
    // 重定向逆向
    for (const r of report.redirects) {
      const c = this.state.cards[r.card];
      if (!c || c.mergedInto) continue;
      const st = this.currentRevision(c).body.statements.find((x) => x.id === r.statement);
      if (st) rewriteRef(st.value, r.field, aId, mergedId);
    }
    a.akaPartOf = (a.akaPartOf || []).filter((x) => x !== mergedId);
    const revA = this.currentRevision(a);
    if (revA.body.aliases) {
      const nameB = this.currentRevision(b).body.name;
      revA.body.aliases = revA.body.aliases.filter((x) => x !== nameB);
    }
    b.mergedInto = null; b.mergedAt = null; b.mergedBy = null;
    const unreport = { id: this.seqId('U'), at: new Date().toISOString(), actor,
      restoredFrom: aId, movedOut: movedOut.map((s) => s.id), reviewNeeded };
    (b.unmergeReports = b.unmergeReports || []).push(unreport);
    this.persist();
    return { restored: b, survivor: a, report: unreport };
  }

  // ---------- 引用人物修订 -> 影响清单 ----------
  // 找出 live 图中引用了某人、但仍钉在旧修订上的陈述。
  impactForPerson(personCardId) {
    const person = this.state.cards[personCardId];
    if (!person || person.type !== 'person') throw new ApiError(404, '人物卡不存在');
    const currentId = this.currentRevision(person).id;
    const items = [];
    for (const c of this.allCards()) {
      if (c.mergedInto) continue;
      for (const st of this.currentRevision(c).body.statements) {
        const refs = extractRefs(st).filter((e) => this.follow(e.to) === personCardId);
        for (const e of refs) {
          const pin = st.pins && st.pins[e.to];
          items.push({
            id: `${c.id}:${st.id}:${e.to}`,
            cardId: c.id, cardName: this.currentRevision(c).body.name,
            statementId: st.id, predicate: st.predicate,
            personId: personCardId, personName: this.currentRevision(person).body.name,
            pinnedRev: pin || null, currentRev: pin !== currentId ? currentId : null,
            status: !pin ? 'unpinned' : pin === currentId ? 'current' : 'stale'
          });
        }
      }
    }
    return { personId: personCardId, currentRev: currentId, items };
  }

  // 编辑在批准发布时逐条决定：update=钉到新修订 / keep=保留引用版本
  resolveImpact(impactId, decision, actor) {
    const [cardId, statementId, personId] = impactId.split(':');
    const card = this.state.cards[cardId];
    if (!card) throw new ApiError(404, '影响项卡片不存在');
    const st = this.currentRevision(card).body.statements.find((x) => x.id === statementId);
    if (!st) throw new ApiError(404, '陈述不存在');
    if (!['update', 'keep', 'dismiss'].includes(decision)) throw new ApiError(400, '决定必须为 update/keep/dismiss');
    st.pins = st.pins || {};
    const person = this.state.cards[personId];
    // update=钉到最新修订；keep=保留引用版本（已有钉版则不动；未钉版则钉到人物上一修订）
    if (decision === 'update') st.pins[personId] = this.currentRevision(person).id;
    if (decision === 'keep' && !st.pins[personId]) {
      const revs = person.revisions;
      st.pins[personId] = revs.length >= 2 ? revs[revs.length - 2].id : this.currentRevision(person).id;
    }
    (st.impactResolutions = st.impactResolutions || []).push(
      { impactId, decision, actor, at: new Date().toISOString() });
    this.persist();
    return st;
  }

  // ---------- 商业推广：独立权限，正文无法覆盖 ----------
  setPromo(cardId, enabled, note, actor) {
    const card = this.state.cards[cardId];
    if (!card) throw new ApiError(404, '卡片不存在');
    if (card.type !== 'shop') throw new ApiError(400, '仅商号可设推广标识');
    this.state.promo[cardId] = {
      enabled: !!enabled, note: note || '',
      updatedBy: actor, updatedAt: new Date().toISOString()
    };
    this.persist();
    return this.state.promo[cardId];
  }

  // ---------- 发布 ----------
  buildSnapshot() {
    const cards = {};
    const errors = [];
    const cardMap = new Map(Object.entries(this.state.cards));
    for (const id of cardMap.keys()) {
      if (this.state.cards[id].mergedInto) continue;
      const cyc = detectCycle(cardMap, id);
      if (cyc) errors.push(`循环引用: ${cyc.join(' -> ')}`);
    }
    const source = (sid) => this.state.sources[sid];
    for (const card of this.allCards()) {
      const rev = this.currentRevision(card);
      const stmts = rev.body.statements.map((st) => {
        for (const sid of st.sourceIds) if (!source(sid)) errors.push(`卡片 ${card.id} 陈述 ${st.id} 引用缺失出处 ${sid}`);
        for (const e of extractRefs(st)) {
          if (!this.state.cards[e.to]) errors.push(`卡片 ${card.id} 陈述 ${st.id} 引用缺失卡片 ${e.to}`);
          else {
            const target = this.state.cards[e.to];
            const pin = st.pins && st.pins[e.to];
            if (pin && !target.revisions.some((r) => r.id === pin)) errors.push(`卡片 ${card.id} 钉住的修订 ${pin} 不存在（${e.to}）`);
          }
        }
        return publicStatement(card, st, this);
      });
      cards[card.id] = {
        id: card.id, type: card.type, name: rev.body.name,
        aliases: rev.body.aliases || [], summary: rev.body.summary || '',
        mergedInto: card.mergedInto, periods: card.periods || null,
        resolution: card.type === 'place' ? (rev.body.resolution || null) : null,
        statements: stmts,
        promo: card.type === 'shop' ? !!(this.state.promo[card.id] && this.state.promo[card.id].enabled) : false,
        revisionId: rev.id, rev: rev.rev, updatedAt: rev.at
      };
    }
    const sources = {};
    for (const s of Object.values(this.state.sources)) {
      sources[s.id] = {
        id: s.id, kind: s.kind, title: s.title, author: s.author,
        citation: s.citation,
        uri: s.kind === 'image' && s.rights === 'withdrawn' ? null : s.uri,
        embedded: s.kind === 'image' && s.rights === 'withdrawn' ? null : s.embedded,
        rights: s.rights, rightsWithdrawn: s.rights === 'withdrawn',
        rightsNote: s.rights === 'withdrawn' ? (s.rightsNote || '图片已撤权') : s.rightsNote
      };
    }
    if (errors.length) {
      const err = new ApiError(409, '发布校验失败：' + errors.slice(0, 5).join('；') + (errors.length > 5 ? ` 等 ${errors.length} 条` : ''));
      err.allErrors = [...new Set(errors)];
      throw err;
    }
    const payload = {
      format: 'shanghao-public/1',
      generatedAt: new Date().toISOString(),
      cards, sources
    };
    payload.hash = sha256({ cards: payload.cards, sources: payload.sources });
    return payload;
  }

  publish(actor, note) {
    return this.withLock(() => {
      // 发布前：人物引用若有 stale/unpinned 影响项，必须由编辑逐条批准
      const pending = this.pendingImpacts();
      if (pending.length) {
        throw new ApiError(409, `存在 ${pending.length} 条人物引用影响未批准（先处理影响清单）`, { pending: pending.slice(0, 20) });
      }
      const snapshot = this.buildSnapshot();
      const release = {
        id: this.seqId('V'), at: new Date().toISOString(), actor,
        note: note || '', hash: snapshot.hash, snapshot
      };
      this.state.releases.push(release);
      this.persist();
      const { snapshot: _s, ...meta } = release;
      return meta;
    });
  }

  pendingImpacts() {
    const people = this.allCards().filter((c) => c.type === 'person');
    const all = [];
    for (const p of people) {
      const { items } = this.impactForPerson(p.id);
      for (const it of items) {
        const card = this.state.cards[it.cardId];
        const st = this.currentRevision(card).body.statements.find((x) => x.id === it.statementId);
        // 必须存在一次明确决定；且对 stale 项，决定时间不得早于人物最新修订
        const personRevAt = this.currentRevision(p).at;
        const decisions = (st.impactResolutions || [])
          .filter((r) => r.impactId === it.id && (r.decision === 'update' || r.decision === 'keep'));
        const resolved = decisions.length > 0 &&
          (it.status === 'unpinned' || decisions.some((r) => r.at >= personRevAt));
        if ((it.status === 'stale' || it.status === 'unpinned') && !resolved) all.push(it);
      }
    }
    return all;
  }
}


export class ApiError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; Object.assign(this, extra); }
}

function normalizeBody(type, body) {
  const out = {
    name: body.name.trim(),
    aliases: body.aliases || [],
    summary: body.summary || '',
    statements: (body.statements || []).map((st) => ({
      id: st.id || `T_${Math.random().toString(36).slice(2, 10)}`,
      predicate: st.predicate,
      certainty: st.certainty || 'inferred',
      value: st.value,
      sourceIds: [...st.sourceIds],
      pins: st.pins || {},
      migratedFromCard: st.migratedFromCard, migratedFromStatement: st.migratedFromStatement
    }))
  };
  // 地点解析：保留原称、候选位置、精度；缺坐标仍可阅读
  if (type === 'place') {
    out.resolution = body.resolution || null;
  }
  return out;
}

function statementKey(st) {
  // 去重键：谓词 + 去掉 id/pins/迁移痕迹的值 + 出处集合
  const v = JSON.parse(JSON.stringify(st.value));
  return canonicalJson({ p: st.predicate, v, s: [...(st.sourceIds || [])].sort() });
}
function scrubMigrate(st) {
  const c = JSON.parse(JSON.stringify(st));
  delete c.id; delete c.pins; delete c.migratedFromCard; delete c.migratedFromStatement;
  return c;
}
function rewriteRef(value, field, from, to) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((v) => rewriteRef(v, field, from, to)); return; }
  const REF = ['placeId', 'fromPlaceId', 'personId', 'shopId', 'signId', 'partOf'];
  for (const k of Object.keys(value)) {
    const matchField = field == null ? REF.includes(k) : k === field;
    if (matchField && value[k] === from) value[k] = to;
    else if (matchField && Array.isArray(value[k]) && value[k].includes(from)) value[k] = value[k].map((x) => (x === from ? to : x));
    else if (value[k] && typeof value[k] === 'object') rewriteRef(value[k], field, from, to);
  }
}

// 陈述 -> 公开形态：日期解析、地点解析原样保留、引用钉版信息
function publicStatement(card, st, store) {
  const out = {
    id: st.id, predicate: st.predicate, certainty: st.certainty,
    value: st.value, sourceIds: [...st.sourceIds],
    date: st.value && st.value.raw != null && datePredicates.has(st.predicate) ? parseHistDate(st.value.raw) : null,
    refs: extractRefs(st).map((e) => {
      const target = store.state.cards[e.to];
      const pin = st.pins && st.pins[e.to];
      let targetRev = null;
      if (pin) targetRev = pin;
      else if (target) targetRev = store.currentRevision(target).id;
      return { field: e.field, cardId: e.to, pinnedRev: pin || null, targetRev };
    })
  };
  if (st.migratedFromCard) { out.migratedFrom = { card: st.migratedFromCard, statement: st.migratedFromStatement }; }
  return out;
}
const datePredicates = new Set(['foundedOn', 'dissolvedOn', 'createdOn', 'bornOn', 'diedOn']);

export const store = new Store().init();
