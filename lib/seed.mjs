import { nextId, nowIso, recordAudit } from './store.mjs';

const createdAt = '2026-01-01T00:00:00.000Z';

export function seed(db) {
  const person = (id, name, bio) => { db.persons[id] = { id, name, bio, version: 1, createdAt, updatedAt: createdAt, createdBy: 'admin', updatedBy: 'admin', revisions: [] }; };
  person('person_0001', '张茂斋', '晚清至民国时期西安南院门商人，字号与生平仍需碑刻、户籍或同业公会材料互证。');
  person('person_0002', '李永庆', '同名商人候选，史料中至少出现两位活动区域不同的“李永庆”，暂不得合并。');
  person('person_0003', '陈掌柜', '东关商行经营者，目前仅有口述材料。');

  const source = (id, title, kind, issuedAt, note) => {
    db.sources[id] = { id, title, kind, issuedAt, note, version: 1, createdAt, updatedAt: createdAt, createdBy: 'admin', updatedBy: 'admin', revisions: [] };
  };
  source('source_0001', '《西安商业志》节选', 'book', '1992-05-01', '出版志书；页码与条目需在正式整理时补录。');
  source('source_0002', '南院门老照片背面题字', 'photo', '1935-01-01', '题字作“民国二十四年春”，日期精度为年。');
  source('source_0003', '李氏后人访谈记录', 'oral', '2021-09-18', '访谈地点：西安碑林；存在追忆误差。');
  source('source_0004', '1953年同业公会登记表抄件', 'archive', '1953-06-10', '抄录件，原档号待补。');

  const place = (id, displayName, historicalName, coords, precision, candidates = [], note = '') => {
    db.places[id] = { id, displayName, historicalName, coords, precision, candidates, note, version: 1, createdAt, updatedAt: createdAt, createdBy: 'admin', updatedBy: 'admin' };
  };
  place('place_0001', '西安南院门（今西安市南院门街片区）', '南院门街路东', { lat: 34.2588, lng: 108.9402 }, 'approximate', [{ name: '南院门街路东', coords: { lat: 34.2588, lng: 108.9402 }, basis: '门牌重绘与口述', confidence: 0.62 }], '历史门牌已变化，只标到街片。');
  place('place_0002', '西安竹笆市', '竹笆市南口', { lat: 34.2592, lng: 108.9445 }, 'street', [{ name: '竹笆市南口', basis: '老照片街景轮廓', confidence: 0.55 }], '具体铺面暂不能定点。');
  place('place_0003', '西安东关正街（旧址待考）', '东关正街老牛市口', null, 'unresolved', [{ name: '牛市口', basis: '口述“东关牛市口附近”', confidence: 0.35 }], '缺现代坐标；公开页仍保留原称和候选地。');
  place('place_0004', '西安西大街', '西大街鼓楼西', { lat: 34.2603, lng: 108.9389 }, 'approximate', [{ name: '鼓楼西二百步', coords: { lat: 34.2603, lng: 108.9389 }, basis: '志书相对方位', confidence: 0.58 }]);

  const subject = (id, name, kind, note, aliases = []) => {
    db.subjects[id] = { id, name, kind, note, aliases, status: 'active', mergedInto: null, version: 1, createdAt, updatedAt: createdAt, createdBy: 'admin', updatedBy: 'admin' };
  };
  subject('subject_0001', '德懋恭', 'food', '以水晶饼著称；本卡先建立稳定商号主体，再按时段挂接铺面与招牌。', ['德懋恭南记']);
  subject('subject_0002', '永庆和（南院门）', 'general', '与东关“永庆和”同名但创办者、街区和经营时段均不相同，初始状态为两个主体。');
  subject('subject_0003', '永庆和（东关）', 'general', '同名商号，不得仅凭名称与南院门永庆和合并。');

  const period = (id, subjectId, name, start, end, placeId, note) => {
    db.periods[id] = { id, subjectId, name, start, end, placeId, note, version: 1, createdAt, updatedAt: createdAt, createdBy: 'admin', updatedBy: 'admin' };
  };
  period('period_0001', 'subject_0001', '南院门创立期', { text: '清光绪末年', iso: null, precision: 'era', inferred: true }, { text: '1937年', iso: '1937', precision: 'year', inferred: false }, 'place_0001', '创立年代有晚清说与民国说，并列陈述。');
  period('period_0002', 'subject_0001', '竹笆市经营期', { text: '1937年前后', iso: '1937', precision: 'year', inferred: true }, null, 'place_0002', '迁址后招牌沿用。');
  period('period_0003', 'subject_0002', '南院门时期', { text: '民国十年前后', iso: '1921', precision: 'year', inferred: true }, { text: '1956年', iso: '1956', precision: 'year', inferred: false }, 'place_0004', '');
  period('period_0004', 'subject_0003', '东关待考时期', { text: '民国十九年', iso: '1930', precision: 'year', inferred: false }, null, 'place_0003', '地点缺坐标。');

  const statement = (id, subjectId, property, valueText, value, sources, status = 'active', periodId = null, eventId = null) => {
    db.statements[id] = { id, subjectId, periodId, eventId, property, valueText, value, sourceRefs: sources.map(([sid, note, personVersion]) => ({ sourceId: sid, note, personVersion: personVersion || null, quoteExcerpt: note })), status, kind: 'claim', supersedesStatementId: null, confidence: status === 'inferred' ? 'low' : 'medium', createdAt, updatedAt: createdAt, createdBy: 'admin', updatedBy: 'admin', retractedReason: null };
  };
  statement('statement_0001', 'subject_0001', 'foundedAt', '清光绪末年（创立说之一）', { date: { text: '清光绪末年', iso: null, precision: 'era', inferred: true } }, [['source_0001', '志书追述称“光绪末设店”']], 'active', 'period_0001');
  statement('statement_0002', 'subject_0001', 'foundedAt', '民国三年（创立说之二）', { date: { text: '民国三年', iso: '1914', precision: 'year', inferred: false } }, [['source_0002', '照片题字旁注“甲寅始创”，但题字晚于事件']], 'active', 'period_0001');
  statement('statement_0003', 'subject_0001', 'founder', '张茂斋（候选创立者）', { personId: 'person_0001', personVersion: 1, role: 'founder' }, [['source_0001', '志书列创办人']], 'active', 'period_0001');
  statement('statement_0004', 'subject_0002', 'founder', '李永庆（南院门）', { personId: 'person_0002', personVersion: 1, role: 'founder' }, [['source_0003', '后人访谈']], 'active', 'period_0003');
  statement('statement_0005', 'subject_0003', 'founder', '陈掌柜（口述，一名“永庆”）', { personId: 'person_0003', personVersion: 1, role: 'founder' }, [['source_0003', '东关访谈，不与南院门李氏混同']], 'active', 'period_0004');

  const event = (id, subjectId, type, date, fromPlaceId, toPlaceId, sourceIds, note, periodFromId = null, periodToId = null) => {
    db.events[id] = { id, subjectId, type, date, fromPlaceId, toPlaceId, sourceIds, note, periodFromId, periodToId, version: 1, createdAt, updatedAt: createdAt, createdBy: 'admin', updatedBy: 'admin' };
  };
  event('event_0001', 'subject_0001', 'relocation', { text: '1937年前后', iso: '1937', precision: 'year', inferred: true }, 'place_0001', 'place_0002', ['source_0001', 'source_0002'], '同一名号可能先短暂停业再迁址，事件日期不写成确定日。', 'period_0001', 'period_0002');
  event('event_0002', 'subject_0003', 'relocation', { text: '民国二十六年春', iso: '1937', precision: 'season', inferred: false }, 'place_0003', 'place_0004', ['source_0004'], '登记表记载由东关迁至鼓楼西；该事件可触发拆分新经营期。', 'period_0004');

  const sign = (id, subjectId, periodId, title, inscription, sourceIds, note) => {
    db.signs[id] = { id, subjectId, periodId, title, inscription, sourceIds, mediaIds: [], status: 'active', note, version: 1, createdAt, updatedAt: createdAt, createdBy: 'admin', updatedBy: 'admin' };
  };
  sign('sign_0001', 'subject_0001', 'period_0001', '黑底金字“德懋恭”', '德懋恭', ['source_0002'], '老照片可见匾额边缘；照片授权状态独立维护。');
  sign('sign_0002', 'subject_0003', 'period_0004', '木刻“永庆和”匾', '永庆和', ['source_0004'], '匾名与南院门永庆和相同，不能作为自动合并依据。');

  const svg = (label, bg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${bg}"/><text x="320" y="175" text-anchor="middle" font-size="42" fill="#f7d77d" font-family="serif">${label}</text><text x="320" y="230" text-anchor="middle" font-size="22" fill="#f8ead2">演示史料图（内嵌 SVG）</text></svg>`)}`;
  db.media['media_0001'] = { id: 'media_0001', title: '南院门铺面旧影', kind: 'image', dataUri: svg('南院门铺面旧影', '#3d1f1a'), rightsStatus: 'active', rightsNote: '占位图，测试可撤销。', sourceId: 'source_0002', version: 1, createdAt, updatedAt: createdAt, createdBy: 'admin', updatedBy: 'admin' };
  db.media['media_0002'] = { id: 'media_0002', title: '永庆和木匾登记表附图', kind: 'image', dataUri: svg('永庆和木匾', '#263126'), rightsStatus: 'active', rightsNote: '档案抄件占位图。', sourceId: 'source_0004', version: 1, createdAt, updatedAt: createdAt, createdBy: 'admin', updatedBy: 'admin' };
  db.signs['sign_0001'].mediaIds.push('media_0001');
  db.signs['sign_0002'].mediaIds.push('media_0002');

  db.promotions['promo_0001'] = { id: 'promo_0001', subjectId: 'subject_0001', label: '官方非遗合作商户', body: '商业推广标识示例；只能由商业标识权限维护。', active: true, startIso: '2026-01-01T00:00:00.000Z', endIso: null, version: 1, createdAt: nowIso(), updatedAt: nowIso(), createdBy: 'promoter', updatedBy: 'promoter' };

  db.counters = {
    person: 3, source: 4, place: 4, subject: 3, period: 4, statement: 5, event: 2, sign: 2, media: 2, promotion: 1
  };

  recordAudit(db, { actor: 'admin', action: 'seed', entityType: 'system', entityId: 'seed' });
}
