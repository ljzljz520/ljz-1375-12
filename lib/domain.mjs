import { nextId, nowIso, recordAudit, mustExist, requireFields } from './store.mjs';

const OWNED = ['periods', 'events', 'signs', 'statements'];

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function publicList(db) {
  return {
    subjects: Object.values(db.subjects),
    persons: Object.values(db.persons),
    places: Object.values(db.places),
    periods: Object.values(db.periods),
    events: Object.values(db.events),
    signs: Object.values(db.signs),
    statements: Object.values(db.statements),
    sources: Object.values(db.sources),
    media: Object.values(db.media),
    promotions: Object.values(db.promotions).filter((x) => x.active)
  };
}

function touch(item, actor) {
  item.version = (item.version || 1) + 1;
  item.updatedAt = nowIso();
  item.updatedBy = actor;
}

function normalizeDate(input = {}) {
  const text = String(input.text || input.iso || '').trim();
  if (!text) {
    const err = new Error('年代必须包含原文表述 text，缺坐标可接受，缺原文不可接受。');
    err.status = 400;
    throw err;
  }
  const allowed = new Set(['day', 'month', 'year', 'decade', 'era', 'season', 'unknown']);
  const precision = input.precision || 'unknown';
  if (!allowed.has(precision)) {
    const err = new Error(`不支持的年代精度：${precision}`);
    err.status = 400;
    throw err;
  }
  return {
    text,
    iso: input.iso || null,
    precision,
    inferred: Boolean(input.inferred)
  };
}

function normalizeCoords(coords) {
  if (coords === null || coords === undefined) return null;
  if (typeof coords !== 'object' || typeof coords.lat !== 'number' || typeof coords.lng !== 'number') return null;
  if (coords.lat < -90 || coords.lat > 90 || coords.lng < -180 || coords.lng > 180) {
    const err = new Error('经纬度超出范围。');
    err.status = 400;
    throw err;
  }
  return { lat: coords.lat, lng: coords.lng };
}

function makeRefs(db, sourceRefs) {
  return asArray(sourceRefs).map((ref) => {
    const sourceId = typeof ref === 'string' ? ref : ref.sourceId;
    const source = mustExist(db.sources, sourceId, '出处');
    return {
      sourceId,
      sourceVersion: source.version,
      note: typeof ref === 'string' ? '' : ref.note || '',
      quoteExcerpt: typeof ref === 'string' ? '' : ref.quoteExcerpt || ref.note || '',
      accessedAt: typeof ref === 'string' ? null : ref.accessedAt || null
    };
  });
}

export async function createSubject(db, body, actor) {
  requireFields(body, ['name']);
  const id = nextId(db, 'subject');
  const at = nowIso();
  db.subjects[id] = {
    id,
    name: body.name.trim(),
    kind: body.kind || 'unknown',
    note: body.note || '',
    aliases: asArray(body.aliases),
    status: 'active',
    mergedInto: null,
    version: 1,
    createdAt: at,
    updatedAt: at,
    createdBy: actor,
    updatedBy: actor
  };
  recordAudit(db, { actor, action: 'create', entityType: 'subject', entityId: id });
  return db.subjects[id];
}

export async function updateSubject(db, id, body, actor) {
  const item = mustExist(db.subjects, id, '商号主体');
  if (item.status !== 'active') throw err409('该主体已合并，请先撤销合并或在存续主体上编辑。');
  if (body.version !== undefined && body.version !== item.version) throw err409('记录已被另一位编辑修改，请刷新后重试。');
  if (body.name !== undefined) item.name = body.name;
  if (body.kind !== undefined) item.kind = body.kind;
  if (body.note !== undefined) item.note = body.note;
  if (body.aliases !== undefined) item.aliases = asArray(body.aliases);
  touch(item, actor);
  recordAudit(db, { actor, action: 'update', entityType: 'subject', entityId: id });
  return item;
}

export async function createPerson(db, body, actor) {
  requireFields(body, ['name']);
  const id = nextId(db, 'person');
  const at = nowIso();
  db.persons[id] = { id, name: body.name.trim(), bio: body.bio || '', version: 1, revisions: [], createdAt: at, updatedAt: at, createdBy: actor, updatedBy: actor };
  recordAudit(db, { actor, action: 'create', entityType: 'person', entityId: id });
  return db.persons[id];
}

function statementsReferencingPerson(db, personId) {
  return Object.values(db.statements).filter((s) => s.status !== 'retracted' && (s.value?.personId === personId || s.valueText?.includes(db.persons[personId]?.name || '___')));
}

export async function updatePerson(db, id, body, actor) {
  const before = mustExist(db.persons, id, '人物');
  if (body.version !== undefined && body.version !== before.version) throw err409('人物记录已被修改，请刷新。');
  requireFields(body, ['name']);
  const impacts = statementsReferencingPerson(db, id).map((s) => ({
    statementId: s.id,
    subjectId: s.subjectId,
    periodId: s.periodId || null,
    eventId: s.eventId || null,
    property: s.property,
    pinnedPersonVersion: s.value?.personVersion || null,
    reason: '该陈述引用了被修订人物；已发布旧卡继续使用固定版本，新发布需人工批准。'
  }));
  const revision = { version: before.version, name: before.name, bio: before.bio, revisedAt: before.updatedAt, revisedBy: before.updatedBy };
  before.revisions.push(revision);
  before.name = body.name.trim();
  if (body.bio !== undefined) before.bio = body.bio;
  touch(before, actor);

  const revId = nextId(db, 'personrev');
  db.personRevisions[revId] = { id: revId, personId: id, fromVersion: revision.version, toVersion: before.version, old: revision, next: { name: before.name, bio: before.bio }, impacts, createdAt: nowIso(), createdBy: actor, pendingChangeId: null };
  const pending = createPendingChange(db, {
    objectType: 'personRevision',
    objectId: revId,
    actor,
    summary: `人物“${revision.name}”被修订为“${before.name}”，影响 ${impacts.length} 条引用`,
    impact: impacts
  });
  db.personRevisions[revId].pendingChangeId = pending.id;
  recordAudit(db, { actor, action: 'revise-person', entityType: 'person', entityId: id, details: { impacts: impacts.length, pendingChangeId: pending.id } });
  return { person: before, revision: db.personRevisions[revId], pendingChange: pending };
}

export async function createPlace(db, body, actor) {
  requireFields(body, ['historicalName']);
  const id = nextId(db, 'place');
  const at = nowIso();
  db.places[id] = {
    id,
    historicalName: body.historicalName.trim(),
    displayName: body.displayName || body.historicalName.trim(),
    coords: normalizeCoords(body.coords),
    precision: body.coords ? (body.precision || 'approximate') : 'unresolved',
    candidates: asArray(body.candidates).map((c) => ({
      name: c.name,
      coords: normalizeCoords(c.coords),
      basis: c.basis || '',
      confidence: Number.isFinite(Number(c.confidence)) ? Number(c.confidence) : null
    })),
    note: body.note || '',
    version: 1,
    createdAt: at,
    updatedAt: at,
    createdBy: actor,
    updatedBy: actor
  };
  recordAudit(db, { actor, action: 'create', entityType: 'place', entityId: id });
  return db.places[id];
}

export async function updatePlace(db, id, body, actor) {
  const item = mustExist(db.places, id, '地点');
  if (body.version !== undefined && body.version !== item.version) throw err409('地点记录已被修改，请刷新。');
  if (body.historicalName !== undefined) item.historicalName = body.historicalName;
  if (body.displayName !== undefined) item.displayName = body.displayName;
  if (body.note !== undefined) item.note = body.note;
  if (body.coords !== undefined) {
    item.coords = normalizeCoords(body.coords);
    item.precision = item.coords ? (body.precision || item.precision || 'approximate') : 'unresolved';
  }
  if (body.precision !== undefined) item.precision = body.precision;
  if (body.candidates !== undefined) item.candidates = asArray(body.candidates).map((c) => ({ ...c, coords: normalizeCoords(c.coords) }));
  touch(item, actor);
  recordAudit(db, { actor, action: 'update', entityType: 'place', entityId: id });
  return item;
}

export async function createPeriod(db, body, actor) {
  requireFields(body, ['subjectId', 'name', 'start']);
  const subject = mustExist(db.subjects, body.subjectId, '商号主体');
  if (subject.status !== 'active') throw err409('不能给已合并主体直接新增时期，请撤销合并后操作。');
  if (body.placeId) mustExist(db.places, body.placeId, '地点');
  const id = nextId(db, 'period');
  const at = nowIso();
  db.periods[id] = {
    id, subjectId: subject.id, name: body.name,
    start: normalizeDate(body.start), end: body.end ? normalizeDate(body.end) : null,
    placeId: body.placeId || null, note: body.note || '',
    sourcePeriodId: body.sourcePeriodId || null,
    version: 1, createdAt: at, updatedAt: at, createdBy: actor, updatedBy: actor
  };
  recordAudit(db, { actor, action: 'create', entityType: 'period', entityId: id });
  return db.periods[id];
}

export async function updatePeriod(db, id, body, actor) {
  const item = mustExist(db.periods, id, '时期');
  if (body.version !== undefined && body.version !== item.version) throw err409('时期记录已被修改，请刷新。');
  if (body.name !== undefined) item.name = body.name;
  if (body.note !== undefined) item.note = body.note;
  if (body.start !== undefined) item.start = normalizeDate(body.start);
  if (body.end !== undefined) item.end = body.end ? normalizeDate(body.end) : null;
  if (body.placeId !== undefined) {
    if (body.placeId) mustExist(db.places, body.placeId, '地点');
    item.placeId = body.placeId;
  }
  touch(item, actor);
  recordAudit(db, { actor, action: 'update', entityType: 'period', entityId: id });
  return item;
}

export async function createStatement(db, body, actor) {
  requireFields(body, ['subjectId', 'property', 'valueText', 'sourceRefs']);
  const subject = mustExist(db.subjects, body.subjectId, '商号主体');
  if (subject.status !== 'active') throw err409('请在存续主体上增加陈述；被合并主体只作重定向。');
  if (body.periodId) mustExist(db.periods, body.periodId, '时期');
  if (body.eventId) mustExist(db.events, body.eventId, '事件');
  const refs = makeRefs(db, body.sourceRefs);
  if (!refs.length) {
    const err = new Error('每条陈述至少需要一个出处。');
    err.status = 400;
    throw err;
  }
  const id = nextId(db, 'statement');
  const at = nowIso();
  const value = body.value || {};
  if (body.property === 'foundedAt' || body.property === 'eventDate') value.date = normalizeDate(value.date || body.date || {});
  if (body.property === 'founder') {
    const p = mustExist(db.persons, value.personId, '创立者');
    value.personVersion = value.personVersion || p.version;
    value.role = value.role || 'founder';
  }
  db.statements[id] = {
    id, subjectId: subject.id, periodId: body.periodId || null, eventId: body.eventId || null,
    property: body.property, valueText: body.valueText, value, sourceRefs: refs,
    status: body.status === 'inferred' ? 'inferred' : 'active', kind: body.property === 'foundedAt' ? 'founding-date-claim' : 'claim',
    confidence: body.confidence || (body.status === 'inferred' ? 'low' : 'medium'),
    supersedesStatementId: body.supersedesStatementId || null,
    version: 1, createdAt: at, updatedAt: at, createdBy: actor, updatedBy: actor, retractedReason: null
  };
  recordAudit(db, { actor, action: 'create', entityType: 'statement', entityId: id });
  return db.statements[id];
}

export async function createFoundingClaim(db, body, actor) {
  requireFields(body, ['subjectId', 'date', 'sourceRefs']);
  const date = normalizeDate(body.date);
  return createStatement(db, {
    subjectId: body.subjectId,
    periodId: body.periodId,
    property: 'foundedAt',
    valueText: body.valueText || `${date.text}创立`,
    value: { date },
    sourceRefs: body.sourceRefs,
    status: date.inferred ? 'inferred' : 'active',
    confidence: body.confidence
  }, actor);
}

export async function confirmInferredDate(db, statementId, body, actor) {
  const old = mustExist(db.statements, statementId, '陈述');
  if (!['foundedAt', 'eventDate'].includes(old.property)) throw err400('该操作只用于日期陈述。');
  const refs = makeRefs(db, body.sourceRefs || []);
  if (!refs.length) throw Object.assign(new Error('确证日期必须提供新出处。'), { status: 400 });
  const date = normalizeDate(body.date || old.value?.date || {});
  date.inferred = false;
  date.precision = body.date?.precision || date.precision;
  old.status = 'superseded';
  touch(old, actor);
  const fresh = await createStatement(db, {
    subjectId: old.subjectId,
    periodId: old.periodId,
    eventId: old.eventId,
    property: old.property,
    valueText: body.valueText || `${date.text}（确证）`,
    value: { ...old.value, date, confirmationOf: old.id },
    sourceRefs: refs,
    status: 'active',
    confidence: 'high',
    supersedesStatementId: old.id
  }, actor);
  recordAudit(db, { actor, action: 'confirm-date', entityType: 'statement', entityId: fresh.id, details: { oldStatementId: old.id } });
  return { oldStatement: old, confirmedStatement: fresh };
}

export async function retractStatement(db, id, reason, actor) {
  const item = mustExist(db.statements, id, '陈述');
  item.status = 'retracted';
  item.retractedReason = reason || '出处不再支持该陈述';
  touch(item, actor);
  recordAudit(db, { actor, action: 'retract', entityType: 'statement', entityId: id, details: { reason } });
  return item;
}

export async function createEvent(db, body, actor) {
  requireFields(body, ['subjectId', 'type', 'date']);
  const subject = mustExist(db.subjects, body.subjectId, '商号主体');
  if (subject.status !== 'active') throw err409('已合并主体不能新增事件。');
  const date = normalizeDate(body.date);
  if (body.fromPlaceId) mustExist(db.places, body.fromPlaceId, '迁出地点');
  if (body.toPlaceId) mustExist(db.places, body.toPlaceId, '迁入地点');
  const sourceIds = asArray(body.sourceIds);
  sourceIds.forEach((sid) => mustExist(db.sources, sid, '出处'));
  const id = nextId(db, 'event');
  const at = nowIso();
  db.events[id] = {
    id, subjectId: subject.id, type: body.type, date, dateHistory: [],
    fromPlaceId: body.fromPlaceId || null, toPlaceId: body.toPlaceId || null,
    sourceIds, note: body.note || '',
    periodFromId: body.periodFromId || null, periodToId: body.periodToId || null,
    version: 1, createdAt: at, updatedAt: at, createdBy: actor, updatedBy: actor
  };
  recordAudit(db, { actor, action: 'create', entityType: 'event', entityId: id });
  return db.events[id];
}

export async function confirmEventDate(db, id, body, actor) {
  const event = mustExist(db.events, id, '事件');
  const refs = makeRefs(db, body.sourceRefs || []);
  if (!refs.length) throw Object.assign(new Error('确证事件日期需要出处。'), { status: 400 });
  const next = normalizeDate(body.date || event.date);
  next.inferred = false;
  event.dateHistory.push({ date: event.date, sourceRefs: refs, confirmedAt: nowIso(), confirmedBy: actor });
  event.date = next;
  touch(event, actor);
  recordAudit(db, { actor, action: 'confirm-event-date', entityType: 'event', entityId: id });
  return event;
}

export async function createRelocationAndSplit(db, body, actor) {
  requireFields(body, ['subjectId', 'date', 'fromPlaceId', 'toPlaceId']);
  const subject = mustExist(db.subjects, body.subjectId, '商号主体');
  mustExist(db.places, body.fromPlaceId, '迁出地点');
  mustExist(db.places, body.toPlaceId, '迁入地点');
  const sourceIds = asArray(body.sourceIds);
  sourceIds.forEach((sid) => mustExist(db.sources, sid, '出处'));

  let periodTo = body.periodToId ? mustExist(db.periods, body.periodToId, '迁入时期') : null;
  if (!periodTo && body.splitPeriod !== false) {
    const at = nowIso();
    const pid = nextId(db, 'period');
    periodTo = {
      id: pid, subjectId: subject.id,
      name: body.newPeriodName || `迁址后时期（${normalizeDate(body.date).text}）`,
      start: normalizeDate(body.date), end: null, placeId: body.toPlaceId,
      note: body.newPeriodNote || '由迁址事件自动拆分；同一名号的新阶段，不覆盖旧时期。',
      sourcePeriodId: body.periodFromId || null,
      version: 1, createdAt: at, updatedAt: at, createdBy: actor, updatedBy: actor
    };
    db.periods[pid] = periodTo;
  }
  const payload = { ...body, type: 'relocation', periodToId: periodTo?.id || body.periodToId || null };
  const event = await createEvent(db, payload, actor);
  recordAudit(db, { actor, action: 'split-period-by-relocation', entityType: 'event', entityId: event.id, details: { periodToId: periodTo?.id || null } });
  return { event, periodTo };
}

export async function createSign(db, body, actor) {
  requireFields(body, ['subjectId', 'title']);
  const subject = mustExist(db.subjects, body.subjectId, '商号主体');
  if (body.periodId) {
    const p = mustExist(db.periods, body.periodId, '时期');
    if (p.subjectId !== subject.id) throw err400('招牌所属时期必须属于同一商号主体。');
  }
  const sourceIds = asArray(body.sourceIds);
  sourceIds.forEach((sid) => mustExist(db.sources, sid, '出处'));
  const id = nextId(db, 'sign');
  const at = nowIso();
  db.signs[id] = {
    id, subjectId: subject.id, periodId: body.periodId || null, title: body.title,
    inscription: body.inscription || '', sourceIds, mediaIds: asArray(body.mediaIds),
    status: 'active', note: body.note || '',
    version: 1, createdAt: at, updatedAt: at, createdBy: actor, updatedBy: actor
  };
  recordAudit(db, { actor, action: 'create', entityType: 'sign', entityId: id });
  return db.signs[id];
}

export async function updateSign(db, id, body, actor) {
  const item = mustExist(db.signs, id, '招牌');
  if (body.version !== undefined && body.version !== item.version) throw err409('招牌记录已被修改，请刷新。');
  for (const f of ['title', 'inscription', 'note', 'status']) if (body[f] !== undefined) item[f] = body[f];
  if (body.sourceIds !== undefined) {
    asArray(body.sourceIds).forEach((sid) => mustExist(db.sources, sid, '出处'));
    item.sourceIds = asArray(body.sourceIds);
  }
  if (body.mediaIds !== undefined) {
    asArray(body.mediaIds).forEach((mid) => mustExist(db.media, mid, '图片'));
    item.mediaIds = asArray(body.mediaIds);
  }
  touch(item, actor);
  recordAudit(db, { actor, action: 'update', entityType: 'sign', entityId: id });
  return item;
}

export async function createSource(db, body, actor) {
  requireFields(body, ['title', 'kind']);
  const id = nextId(db, 'source');
  const at = nowIso();
  db.sources[id] = { id, title: body.title, kind: body.kind, issuedAt: body.issuedAt || null, author: body.author || '', archiveRef: body.archiveRef || '', note: body.note || '', rights: body.rights || '', version: 1, revisions: [], createdAt: at, updatedAt: at, createdBy: actor, updatedBy: actor };
  recordAudit(db, { actor, action: 'create', entityType: 'source', entityId: id });
  return db.sources[id];
}

export async function updateSource(db, id, body, actor) {
  const item = mustExist(db.sources, id, '出处');
  if (body.version !== undefined && body.version !== item.version) throw err409('出处已被修改，请刷新。');
  item.revisions.push({ version: item.version, title: item.title, note: item.note, revisedAt: item.updatedAt, revisedBy: item.updatedBy });
  for (const f of ['title', 'kind', 'issuedAt', 'author', 'archiveRef', 'note', 'rights']) if (body[f] !== undefined) item[f] = body[f];
  touch(item, actor);
  const impact = Object.values(db.statements).filter((s) => s.sourceRefs.some((r) => r.sourceId === id)).map((s) => ({ statementId: s.id, subjectId: s.subjectId, reason: '出处元数据被修订，旧发布仍保留固定出处版本。' }));
  const pending = createPendingChange(db, { objectType: 'sourceRevision', objectId: id, actor, summary: `出处《${item.revisions.at(-1).title}》元数据修订`, impact });
  recordAudit(db, { actor, action: 'update', entityType: 'source', entityId: id, details: { pendingChangeId: pending.id } });
  return { source: item, pendingChange: pending };
}

export async function createMedia(db, body, actor) {
  requireFields(body, ['title']);
  const id = nextId(db, 'media');
  const at = nowIso();
  db.media[id] = { id, title: body.title, kind: body.kind || 'image', dataUri: body.dataUri || '', externalUrl: body.externalUrl || '', rightsStatus: 'active', rightsNote: body.rightsNote || '', sourceId: body.sourceId || null, version: 1, createdAt: at, updatedAt: at, createdBy: actor, updatedBy: actor };
  recordAudit(db, { actor, action: 'create', entityType: 'media', entityId: id });
  return db.media[id];
}

export async function withdrawMediaRights(db, id, body, actor) {
  const item = mustExist(db.media, id, '图片');
  if (item.rightsStatus === 'withdrawn') throw err409('图片授权已撤销，请勿重复操作。');
  item.rightsStatus = 'withdrawn';
  item.rightsNote = body?.reason || '授权撤回或来源不明';
  touch(item, actor);
  const impact = [];
  for (const sign of Object.values(db.signs)) {
    if (sign.mediaIds.includes(id)) impact.push({ signId: sign.id, subjectId: sign.subjectId, periodId: sign.periodId, reason: '招牌图引用了被撤权图片，新发布必须隐藏图像。' });
  }
  const pending = createPendingChange(db, { objectType: 'mediaRights', objectId: id, actor, summary: `图片“${item.title}”撤权，影响 ${impact.length} 张招牌卡`, impact });
  recordAudit(db, { actor, action: 'withdraw-media-rights', entityType: 'media', entityId: id, details: { pendingChangeId: pending.id } });
  return { media: item, pendingChange: pending, impact };
}

export async function upsertPromotion(db, body, actor) {
  requireFields(body, ['subjectId', 'label']);
  mustExist(db.subjects, body.subjectId, '商号主体');
  let item;
  const at = nowIso();
  if (body.id) {
    item = mustExist(db.promotions, body.id, '推广标识');
    if (body.version !== undefined && body.version !== item.version) throw err409('推广标识已被修改，请刷新。');
  } else {
    const id = nextId(db, 'promo');
    item = { id, subjectId: body.subjectId, label: body.label, body: '', active: true, startIso: at, endIso: null, version: 0, createdAt: at, updatedAt: at, createdBy: actor, updatedBy: actor };
    db.promotions[id] = item;
  }
  item.label = body.label;
  item.body = body.body || '';
  item.active = body.active !== undefined ? Boolean(body.active) : item.active;
  item.endIso = body.endIso || item.endIso;
  item.version += 1;
  item.updatedAt = at;
  item.updatedBy = actor;
  const pending = createPendingChange(db, { objectType: 'promotion', objectId: item.id, actor, summary: `商业推广标识“${item.label}”待发布`, impact: [{ subjectId: item.subjectId, reason: '推广字段独立授权；故事编辑不能写入。' }] });
  recordAudit(db, { actor, action: 'upsert-promotion', entityType: 'promotion', entityId: item.id, details: { pendingChangeId: pending.id } });
  return { promotion: item, pendingChange: pending };
}

export function createPendingChange(db, { objectType, objectId, actor, summary, impact = [] }) {
  const id = nextId(db, 'pending');
  const at = nowIso();
  db.pendingChanges[id] = { id, objectType, objectId, requestedBy: actor, summary, impact, status: 'pending', createdAt: at, decidedBy: null, decidedAt: null, publicationId: null, decisionNote: '' };
  return db.pendingChanges[id];
}

function findMergeCycle(db) {
  const adj = {};
  for (const s of Object.values(db.subjects)) if (s.status === 'merged' && s.mergedInto) (adj[s.id] ||= []).push(s.mergedInto);
  const color = {};
  const stack = [];
  function dfs(u) {
    color[u] = 1;
    stack.push(u);
    for (const v of adj[u] || []) {
      if (!color[v]) {
        const found = dfs(v);
        if (found) return found;
      } else if (color[v] === 1) {
        const i = stack.indexOf(v);
        return [...stack.slice(i), v];
      }
    }
    stack.pop();
    color[u] = 2;
    return null;
  }
  for (const id of Object.keys(adj)) if (!color[id]) {
    const cycle = dfs(id);
    if (cycle) return cycle;
  }
  return null;
}

export async function mergeSubjects(db, body, actor) {
  requireFields(body, ['sourceSubjectId', 'targetSubjectId']);
  const { sourceSubjectId, targetSubjectId } = body;
  if (sourceSubjectId === targetSubjectId) throw err400('不能把主体合并到自身。');
  const source = mustExist(db.subjects, sourceSubjectId, '被合并商号');
  const target = mustExist(db.subjects, targetSubjectId, '目标商号');
  if (source.status !== 'active') throw err409(`被合并商号当前状态为 ${source.status}，只有存续商号可合并。`);
  if (target.status !== 'active') throw err409('目标商号不是存续主体，不能作为合并目标。');

  // Tentatively set edge before cycle detection; a cycle rolls back by leaving
  // the supplied source untouched because no child records have moved yet.
  source.mergedInto = target.id;
  const cycle = findMergeCycle(db);
  if (cycle) {
    source.mergedInto = null;
    throw err409(`检测到合并循环：${cycle.join(' → ')}，迁移已中止。`);
  }

  const id = nextId(db, 'merge');
  const changes = [];
  const aliasesBefore = [...target.aliases];
  if (source.name && !target.aliases.includes(source.name)) target.aliases.push(source.name);
  source.aliases.forEach((a) => { if (!target.aliases.includes(a)) target.aliases.push(a); });

  for (const coll of OWNED) {
    for (const item of Object.values(db[coll])) {
      if (item.subjectId === source.id) {
        changes.push({ collection: coll, id: item.id, fromSubjectId: source.id, toSubjectId: target.id });
        item.subjectId = target.id;
      }
    }
  }
  source.status = 'merged';
  source.mergedInto = target.id;
  touch(source, actor);
  touch(target, actor);
  const at = nowIso();
  db.merges[id] = {
    id, sourceSubjectId, targetSubjectId, changes, aliasesBefore,
    status: 'active', createdAt: at, createdBy: actor, undoneAt: null, undoneBy: null
  };
  recordAudit(db, { actor, action: 'merge-subject', entityType: 'merge', entityId: id, details: { moved: changes.length } });
  return { merge: db.merges[id], source, target };
}

export async function unmergeSubjects(db, mergeId, actor) {
  const merge = mustExist(db.merges, mergeId, '合并记录');
  if (merge.status !== 'active') throw err409('该合并记录已经撤销。');
  const source = mustExist(db.subjects, merge.sourceSubjectId, '原商号');
  const target = mustExist(db.subjects, merge.targetSubjectId, '合并目标');
  if (target.status === 'merged') throw err409('合并目标此后又被并入其他主体。请按时间倒序先撤销最近一次合并。');
  for (const ch of merge.changes) {
    const item = db[ch.collection]?.[ch.id];
    if (!item) throw err409(`迁移账本中的 ${ch.collection}/${ch.id} 已丢失，拒绝自动撤销。`);
    if (item.subjectId !== target.id) throw err409(`${ch.collection}/${ch.id} 在合并后又发生主体迁移，不能由本合并规则自动撤销。`);
  }
  for (const ch of [...merge.changes].reverse()) {
    db[ch.collection][ch.id].subjectId = source.id;
  }
  target.aliases = merge.aliasesBefore;
  source.status = 'active';
  source.mergedInto = null;
  touch(source, actor);
  touch(target, actor);
  merge.status = 'undone';
  merge.undoneAt = nowIso();
  merge.undoneBy = actor;
  recordAudit(db, { actor, action: 'unmerge-subject', entityType: 'merge', entityId: mergeId, details: { restored: merge.changes.length } });
  return { merge, source, target };
}

function addIssue(issues, severity, code, message, refs = {}) {
  issues.push({ severity, code, message, ...refs });
}

export function validateForPublication(db) {
  const issues = [];
  const exists = (coll, id) => Boolean(db[coll]?.[id]);
  const activeSubjects = new Set(Object.values(db.subjects).filter((s) => s.status === 'active').map((s) => s.id));

  const cycle = findMergeCycle(db);
  if (cycle) addIssue(issues, 'error', 'MERGE_CYCLE', `合并关系存在循环：${cycle.join(' → ')}`);

  for (const s of Object.values(db.statements)) {
    if (s.status === 'retracted') continue;
    if (!activeSubjects.has(s.subjectId) && !exists('subjects', s.subjectId)) addIssue(issues, 'error', 'BROKEN_STATEMENT_SUBJECT', '陈述缺少商号主体', { statementId: s.id });
    if (!s.sourceRefs?.length) addIssue(issues, 'error', 'NO_SOURCE', '陈述没有出处', { statementId: s.id });
    for (const ref of s.sourceRefs || []) if (!exists('sources', ref.sourceId)) addIssue(issues, 'error', 'MISSING_SOURCE', '陈述引用了不存在的出处', { statementId: s.id, sourceId: ref.sourceId });
    if (s.property === 'founder' && s.value?.personId && !exists('persons', s.value.personId)) addIssue(issues, 'error', 'MISSING_PERSON', '创立者引用了不存在的人物', { statementId: s.id });
    if (['foundedAt', 'eventDate'].includes(s.property) && !s.value?.date?.text) addIssue(issues, 'error', 'BAD_DATE', '日期陈述缺少原称年代', { statementId: s.id });
    if (s.periodId && !exists('periods', s.periodId)) addIssue(issues, 'error', 'MISSING_PERIOD', '陈述引用了不存在的时期', { statementId: s.id });
  }

  for (const p of Object.values(db.periods)) {
    if (!exists('subjects', p.subjectId)) addIssue(issues, 'error', 'MISSING_PERIOD_SUBJECT', '时期缺少商号主体', { periodId: p.id });
    if (p.placeId && !exists('places', p.placeId)) addIssue(issues, 'error', 'MISSING_PLACE', '时期引用了不存在的地点', { periodId: p.id });
    if (!p.start?.text) addIssue(issues, 'error', 'BAD_PERIOD_START', '时期缺少开始年代原称', { periodId: p.id });
  }

  for (const e of Object.values(db.events)) {
    if (!exists('subjects', e.subjectId)) addIssue(issues, 'error', 'MISSING_EVENT_SUBJECT', '事件缺少商号主体', { eventId: e.id });
    if (!e.date?.text) addIssue(issues, 'error', 'BAD_EVENT_DATE', '事件缺少年代原称', { eventId: e.id });
    if (e.fromPlaceId && !exists('places', e.fromPlaceId)) addIssue(issues, 'error', 'MISSING_FROM_PLACE', '事件迁出地点不存在', { eventId: e.id });
    if (e.toPlaceId && !exists('places', e.toPlaceId)) addIssue(issues, 'error', 'MISSING_TO_PLACE', '事件迁入地点不存在', { eventId: e.id });
    for (const sid of e.sourceIds || []) if (!exists('sources', sid)) addIssue(issues, 'error', 'MISSING_EVENT_SOURCE', '事件出处不存在', { eventId: e.id, sourceId: sid });
  }

  for (const sign of Object.values(db.signs)) {
    if (!exists('subjects', sign.subjectId)) addIssue(issues, 'error', 'MISSING_SIGN_SUBJECT', '招牌缺少主体', { signId: sign.id });
    for (const mid of sign.mediaIds || []) if (!exists('media', mid)) addIssue(issues, 'error', 'MISSING_MEDIA', '招牌引用了不存在的图片', { signId: sign.id });
  }

  for (const place of Object.values(db.places)) {
    if (!place.historicalName) addIssue(issues, 'error', 'NO_HISTORICAL_PLACE_NAME', '地点缺少历史原称', { placeId: place.id });
    if (!place.coords) addIssue(issues, 'warning', 'UNRESOLVED_COORDS', '地点暂无可信坐标，公开页将列入“缺坐标地点”，不阻止阅读。', { placeId: place.id });
  }
  return issues;
}

function versionsOf(items, type) {
  const out = {};
  for (const item of items) {
    for (const rev of item.revisions || []) out[`${item.id}@${rev.version}`] = { type, id: item.id, ...rev };
    out[`${item.id}@${item.version}`] = { type, id: item.id, version: item.version, name: item.name, title: item.title, bio: item.bio, note: item.note };
  }
  return out;
}

export async function publishSnapshot(db, { actor = 'admin', note = '', includePending = [] } = {}) {
  const issues = validateForPublication(db);
  const blocking = issues.filter((x) => x.severity === 'error');
  const unresolvedPending = Object.values(db.pendingChanges).filter((p) => p.status === 'pending' && !includePending.includes(p.id));
  const missingPending = includePending.filter((id) => !db.pendingChanges[id]);
  if (missingPending.length || unresolvedPending.length) {
    const err = new Error(`存在未处理的影响清单：${[...missingPending.map((id) => `${id}（不存在）`), ...unresolvedPending.map((p) => `${p.id} ${p.summary}`)].join('；')}。请逐条批准或驳回，不能用普通发布绕过。`);
    err.status = 409;
    err.code = 'PENDING_APPROVAL_REQUIRED';
    err.issues = issues;
    throw err;
  }
  if (blocking.length) {
    const err = new Error(`发布校验失败：${blocking.map((x) => x.message).join('；')}`);
    err.status = 409;
    err.issues = issues;
    throw err;
  }
  const version = Math.max(0, ...Object.values(db.publications).map((p) => p.version || 0)) + 1;
  const id = nextId(db, 'publication');
  const publicMedia = Object.fromEntries(Object.values(db.media).map((m) => [m.id, m.rightsStatus === 'withdrawn'
    ? { id: m.id, title: m.title, kind: m.kind, rightsStatus: 'withdrawn', rightsNote: m.rightsNote, version: m.version }
    : structuredClone(m)]));
  const snapshot = {
    id,
    version,
    publishedAt: nowIso(),
    publishedBy: actor,
    note,
    validationIssues: issues,
    data: {
      subjects: structuredClone(db.subjects),
      persons: structuredClone(db.persons),
      personVersions: versionsOf(Object.values(db.persons), 'person'),
      sources: structuredClone(db.sources),
      sourceVersions: versionsOf(Object.values(db.sources), 'source'),
      places: structuredClone(db.places),
      periods: structuredClone(db.periods),
      events: structuredClone(db.events),
      signs: structuredClone(db.signs),
      statements: structuredClone(db.statements),
      media: publicMedia,
      promotions: Object.fromEntries(Object.values(db.promotions).filter((p) => p.active).map((p) => [p.id, structuredClone(p)]))
    }
  };
  db.publications[id] = { ...snapshot, status: 'published' };
  for (const pub of Object.values(db.publications)) if (pub.id !== id && pub.status === 'published') pub.status = 'superseded';
  for (const pid of includePending) {
    const p = db.pendingChanges[pid];
    if (p) {
      p.status = 'approved';
      p.decidedAt = nowIso();
      p.decidedBy = actor;
      p.publicationId = id;
    }
  }
  recordAudit(db, { actor, action: 'publish', entityType: 'publication', entityId: id, details: { version, pending: includePending.length } });
  return db.publications[id];
}

export async function approvePending(db, pendingId, actor, body = {}) {
  const pending = mustExist(db.pendingChanges, pendingId, '待发布变更');
  if (pending.status !== 'pending') throw err409(`该影响清单已处理：${pending.status}`);
  const publication = await publishSnapshot(db, { actor, note: body.note || `批准发布：${pending.summary}`, includePending: [pendingId] });
  return { pending, publication };
}

export async function rejectPending(db, pendingId, actor, body = {}) {
  const pending = mustExist(db.pendingChanges, pendingId, '待发布变更');
  if (pending.status !== 'pending') throw err409(`该影响清单已处理：${pending.status}`);
  pending.status = 'rejected';
  pending.decidedAt = nowIso();
  pending.decidedBy = actor;
  pending.decisionNote = body.note || '审批驳回';
  recordAudit(db, { actor, action: 'reject-pending', entityType: 'pendingChange', entityId: pendingId, details: { note: pending.decisionNote } });
  return { pending };
}

function err409(message) {
  return Object.assign(new Error(message), { status: 409 });
}

export { normalizeDate, findMergeCycle };
