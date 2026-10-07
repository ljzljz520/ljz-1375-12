// 领域常量与纯函数：日期解析、引用/循环检测、快照校验、公开视图组装。
import crypto from 'node:crypto';

export const ROLES = { EDITOR: 'editor', APPROVER: 'approver', PROMO: 'promo', VIEWER: 'viewer' };

export const DATE_PRECISION = ['era', 'year', 'month', 'day'];
// certainty: inferred=推测(可升级) / confirmed=确证 / disputed=有争议
export const CERTAINTY = ['inferred', 'confirmed', 'disputed'];

// 卡片类型 -> 允许的陈述谓词
export const PREDICATES = {
  shop: ['foundedOn', 'foundedBy', 'dissolvedOn', 'locatedAt', 'relocatedTo', 'usesSign',
         'operatedInPeriod', 'aka', 'ownedBy', 'sells', 'note'],
  person: ['bornOn', 'diedOn', 'aka', 'note'],
  place: ['streetNumber', 'partOf', 'aka', 'note'],
  sign: ['inscribedText', 'createdOn', 'aka', 'note']
};
// 陈述字段中“引用其他卡片”的字段（与谓词无关，按字段名统一解析）
const REF_FIELDS = ['placeId', 'fromPlaceId', 'personId', 'shopId', 'signId', 'partOf'];
// 参与结构性循环检查的谓词（时间/普通关系不强制无环）
const STRUCTURAL_PREDICATES = new Set(['locatedAt', 'relocatedTo', 'usesSign', 'ownedBy', 'partOf', 'operatedInPeriod']);

export function sha256(obj) {
  return crypto.createHash('sha256').update(canonicalJson(obj)).digest('hex');
}
export function canonicalJson(obj) {
  return JSON.stringify(sortKeys(obj));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  }
  return v;
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

// ---------- 历史年代解析：保留原称，候选解析与精度 ----------
const ERA_TABLE = {
  '光绪': { start: 1875, end: 1908 }, '宣统': { start: 1909, end: 1911 },
  '民国': { start: 1912, end: 1949 }, '乾隆': { start: 1736, end: 1795 },
  '嘉庆': { start: 1796, end: 1820 }, '道光': { start: 1821, end: 1850 },
  '咸丰': { start: 1851, end: 1861 }, '同治': { start: 1862, end: 1874 },
  '康熙': { start: 1662, end: 1722 }, '雍正': { start: 1723, end: 1735 },
  '洪武': { start: 1368, end: 1398 }
};

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9 };

// 解析“光绪十二年”“民国二十三年”“二十”等中文数字（支持到百位）
export function parseCnNumber(s) {
  if (!s) return null;
  s = s.replace(/[年个月号]/g, '');
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let total = 0; let section = 0; let num = 0; let seen = false;
  for (const ch of s) {
    if (ch in CN_DIGITS) { num = CN_DIGITS[ch]; seen = true; }
    else if (ch === '十') { section += (num || 1) * 10; num = 0; seen = true; }
    else if (ch === '百') { section += (num || 1) * 100; num = 0; seen = true; }
    else return null;
  }
  total = section + num;
  return seen ? total : null;
}

// parseHistDate(raw): { raw, year, month, day, precision, certainty } | { raw, precision:'unknown' }
function parseHistDateInner(original) {
  if (!original) return { raw: original, precision: 'unknown' };
  // 公元 ISO
  let m = original.match(/^(\d{3,4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/);
  if (m) {
    const year = parseInt(m[1], 10);
    if (m[3]) return { raw: original, year, month: +m[2], day: +m[3], precision: 'day' };
    if (m[2]) return { raw: original, year, month: +m[2], precision: 'month' };
    return { raw: original, year, precision: 'year' };
  }
  // 汉字数字公元纪年：一九五三年 / 一九五二年春 / 一九五二
  m = original.match(/^([〇零一二三四五六七八九]{4})年?(.*)$/);
  if (m) {
    const digits = [...m[1]].map((ch) => CN_DIGITS[ch]);
    const year = digits[0] * 1000 + digits[1] * 100 + digits[2] * 10 + digits[3];
    const out = { raw: original, year, precision: 'year', calendar: 'cn-numeral' };
    if (/春|春季/.test(m[2])) { out.month = 3; out.precision = 'month'; out.season = '春'; }
    if (/夏|夏季/.test(m[2])) { out.month = 6; out.precision = 'month'; out.season = '夏'; }
    if (/秋|秋季/.test(m[2])) { out.month = 9; out.precision = 'month'; out.season = '秋'; }
    if (/冬|冬季|年底|年末/.test(m[2])) { out.month = 12; out.precision = 'month'; out.season = '冬'; }
    return out;
  }
  // 「光绪十二年」「民国23年」「光绪十二年三月」「民国二十三年五月初十」
  m = original.match(/^(光绪|宣统|民国|乾隆|嘉庆|道光|咸丰|同治|康熙|雍正|洪武)([元一二三两四五六七八九十百零〇\d]+)年(?:([正一二三四五六七八九十冬腊\d]+)月(?:([初廿卅一二三两四五六七八九十\d]+)日)?)?/);
  if (m) {
    const era = ERA_TABLE[m[1]];
    const n = parseCnNumber(m[2]);
    if (!era || n == null) return { raw: original, precision: 'era', era: m[1], eraYear: n ?? null };
    // 民国年可精确换算；其它年号只给候选区间
    if (m[1] === '民国') {
      const year = 1911 + n;
      if (m[3] && m[4]) {
        const mo = lunarMonth(m[3]); const da = lunarDay(m[4]);
        if (mo && da) return { raw: original, year, month: mo, day: da, precision: 'day', calendar: 'lunar-to-approx', era: '民国', eraYear: n };
      }
      if (m[3]) {
        const mo = lunarMonth(m[3]);
        if (mo) return { raw: original, year, month: mo, precision: 'month', calendar: 'lunar-to-approx', era: '民国', eraYear: n };
      }
      return { raw: original, year, precision: 'year', era: '民国', eraYear: n };
    }
    const year0 = era.start + n - 1;
    return {
      raw: original, era: m[1], eraYear: n,
      candidateRange: [year0, Math.min(year0, era.end)],
      year: year0 <= era.end ? year0 : era.start,
      precision: 'year', calendar: 'era-year'
    };
  }
  // 仅年号，如「清末」「光绪年间」
  m = original.match(/^(光绪|宣统|民国|乾隆|嘉庆|道光|咸丰|同治|康熙|雍正|洪武)(?:初|末|年间|年間)?$/);
  if (m) {
    const era = ERA_TABLE[m[1]];
    return { raw: original, era: m[1], precision: 'era', candidateRange: [era.start, era.end] };
  }
  if (/清末/.test(original)) return { raw: original, era: '光绪', precision: 'era', candidateRange: [1875, 1911] };
  return { raw: original, precision: 'unknown' };
}
export function parseHistDate(raw) {
  const original = String(raw ?? '').trim();
  const r = parseHistDateInner(original);
  if (original && /前后|左右|约|初叶|中叶|末叶/.test(original)) r.approximate = true;
  return r;
}
function lunarMonth(s) {
  const map = { 正: 1, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 冬: 11, 腊: 12 };
  if (/^\d+$/.test(s)) return Math.min(12, parseInt(s, 10));
  return map[s] ?? null;
}
function lunarDay(s) {
  if (/^\d+$/.test(s)) return Math.min(30, parseInt(s, 10));
  let t = s;
  if (t.startsWith('初') || t.startsWith('廿') || t.startsWith('卅')) {
    const base = t[0] === '初' ? 0 : t[0] === '廿' ? 20 : 30;
    const n = parseCnNumber(t.slice(1));
    if (n != null) return Math.min(30, base + n);
  }
  const n = parseCnNumber(t);
  return n != null && n <= 30 ? n : null;
}

// 可比较的年代键：未知年代排最后
export function dateKey(date) {
  if (!date || date.precision === 'unknown' || date.year == null) return Number.MAX_SAFE_INTEGER;
  let k = date.year * 10000;
  if (date.precision === 'month' || date.precision === 'day') k += (date.month || 1) * 100;
  if (date.precision === 'day') k += date.day || 1;
  return k;
}

// ---------- 校验 ----------
export function validateCardBody(type, body) {
  const errors = [];
  if (!PREDICATES[type]) errors.push(`未知卡片类型: ${type}`);
  if (!body || typeof body !== 'object') return ['卡片正文缺失'];
  if (typeof body.name !== 'string' || !body.name.trim()) errors.push('名称必填');
  const allowed = new Set(PREDICATES[type] || []);
  const stmts = body.statements || [];
  if (!Array.isArray(stmts)) errors.push('陈述必须是数组');
  else stmts.forEach((st, i) => {
    if (!st || typeof st !== 'object') return errors.push(`陈述#${i} 不是对象`);
    if (!allowed.has(st.predicate)) errors.push(`陈述#${i} 谓词 ${st.predicate} 不允许用于 ${type}`);
    if (!st.value || typeof st.value !== 'object') errors.push(`陈述#${i} 缺少 value`);
    if (!st.sourceIds || !st.sourceIds.length) errors.push(`陈述#${st.value && st.value.raw || i} 必须至少标注一个出处`);
    if (st.certainty && !CERTAINTY.includes(st.certainty)) errors.push(`陈述#${i} certainty 非法`);
  });
  return errors;
}

// 从陈述中抽取引用边：{from,to,predicate,field}
export function extractRefs(st) {
  const edges = [];
  const walk = (v, field) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, field)); return; }
    for (const f of REF_FIELDS) {
      if (typeof v[f] === 'string') edges.push({ to: v[f], predicate: st.predicate, field: f });
      else if (Array.isArray(v[f])) v[f].forEach((t) => { if (typeof t === 'string') edges.push({ to: t, predicate: st.predicate, field: f }); });
    }
    // 嵌套结构（如 period.from/to 中也可能有引用）
    for (const k of Object.keys(v)) {
      if (v[k] && typeof v[k] === 'object') walk(v[k], field || k);
    }
  };
  walk(st.value, null);
  return edges;
}

// 结构性循环引用检测（跟随 mergedInto 重定向）。返回环路径或 null。
export function detectCycle(cards, startFromId) {
  const follow = (id) => {
    const c = cards.get(id);
    return c && c.mergedInto ? c.mergedInto : id;
  };
  const adj = new Map();
  for (const [id, card] of cards) {
    if (card.mergedInto) continue;
    const rev = card.revisions[card.revisions.length - 1];
    const set = new Set();
    for (const st of rev.body.statements) {
      if (!STRUCTURAL_PREDICATES.has(st.predicate)) continue;
      for (const e of extractRefs(st)) {
        if (cards.has(e.to)) set.add(follow(e.to));
      }
    }
    // akaPartOf 只是“曾并入哪些实体”的治理记录，不构成结构边，不参与环检测
    adj.set(id, [...set]);
  }
  // DFS
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const stack = [];
  function dfs(u) {
    color.set(u, GRAY); stack.push(u);
    for (const v of adj.get(u) || []) {
      if (!adj.has(v)) continue;
      if ((color.get(v) ?? WHITE) === GRAY) {
        const idx = stack.indexOf(v);
        return stack.slice(idx).concat(v);
      }
      if ((color.get(v) ?? WHITE) === WHITE) {
        const cyc = dfs(v);
        if (cyc) return cyc;
      }
    }
    stack.pop(); color.set(u, BLACK);
    return null;
  }
  return dfs(follow(startFromId));
}

// 找出一张卡当前版本的所有引用
export function outgoingRefs(card) {
  const rev = card.revisions[card.revisions.length - 1];
  const out = [];
  for (const st of rev.body.statements) for (const e of extractRefs(st)) out.push(e);
  return out;
}
