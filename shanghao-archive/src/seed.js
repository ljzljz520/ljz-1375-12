// 种子数据：同名不同主体、冲突创立日期（并列来源）、无坐标旧址、可撤权图片出处。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbFile = path.join(__dirname, '..', 'data', 'db.json');
if (process.argv.includes('--reset')) fs.rmSync(dbFile, { force: true });

const { store } = await import('./store.js');
const { runBuild } = await import('./build.js');

if (store.allCards().length) {
  console.log('数据库非空，跳过种子（用 --reset 重置）');
  process.exit(0);
}

const S = {};
const mkSource = (k, input) => { Object.assign(S, { [k]: store.createSource(input, 'seed') }); };
mkSource('archives', { kind: 'document', title: '西安市工商业登记档案（1951）', author: '市工商局',
  citation: '西安市档案馆 全宗32-1-412，第7页' });
mkSource('qingce', { kind: 'document', title: '南货业公私合营清册（1956）',
  citation: '市工商联档案 1956-南货-018' });
mkSource('oral', { kind: 'document', title: '赵氏后人访谈记录（2019）', author: '地方志办采访',
  citation: '口述史第17辑，受访人赵守谦' });
mkSource('photo', { kind: 'image', title: '鼎丰号老匾照片（民国时期）',
  uri: 'assets/dingfeng-sign.jpg', rights: 'licensed', rightsNote: '家属授权，2019' });
mkSource('fangzhi', { kind: 'document', title: '《西安老街巷志》南院门卷', citation: '2003年版，第88页' });

// 人物
const P1 = store.createCard('person', {
  name: '赵德厚', summary: '鼎丰号创立者，原籍渭南，光绪末年来省城经商。',
  statements: [
    { predicate: 'bornOn', certainty: 'inferred', value: { raw: '光绪八年' }, sourceIds: [S.oral.id] },
    { predicate: 'diedOn', certainty: 'inferred', value: { raw: '一九五三年' }, sourceIds: [S.qingce.id] },
    { predicate: 'note', value: { text: '口述称其“少年学徒，三十出头自立门面”。' }, sourceIds: [S.oral.id] }
  ]
}, 'seed', { id: 'P1' });

const P2 = store.createCard('person', {
  name: '赵崇礼', summary: '赵德厚之子，1950 年前后接手铺面。',
  statements: [
    { predicate: 'note', value: { text: '合营后进入国营南货店任营业员。' }, sourceIds: [S.qingce.id] }
  ]
}, 'seed', { id: 'P2' });

// 地点：一处有候选坐标，一处缺坐标
const L1 = store.createCard('place', {
  name: '南院门老铺面', summary: '鼎丰号创业时的街面房，原称“南院门街北第三间”。',
  resolution: {
    rawName: '南院门街北第三间', modernName: '南院门广场西北侧',
    precision: 'block', // exact | building | block | street | district | unknown
    candidates: [
      { name: '南院门广场西北侧', coord: { lat: 34.2552, lng: 108.9391 }, precision: 'block',
        note: '依据老街巷图与街坊回忆推定，非实测点位' }
    ],
    resolvedAt: 'seed'
  },
  statements: [
    { predicate: 'note', value: { text: '老照片背景可见对面“鸿盛祥”铺面。' }, sourceIds: [S.photo.id] }
  ]
}, 'seed', { id: 'L1' });

const L2 = store.createCard('place', {
  name: '西大街口新址', summary: '1952 年迁入的两间铺面。',
  resolution: {
    rawName: '西大街东口路南第一二间', modernName: '西大街南口东侧',
    precision: 'building',
    candidates: [
      { name: '西大街南口东侧沿街', coord: { lat: 34.2591, lng: 108.9402 }, precision: 'building',
        note: '清册门牌与现状比对' }
    ],
    resolvedAt: 'seed'
  },
  statements: [
    { predicate: 'streetNumber', value: { text: '西大街 12 号（1956 年门牌）' }, sourceIds: [S.qingce.id] }
  ]
}, 'seed', { id: 'L2' });

const L3 = store.createCard('place', {
  name: '东关正街旧号', summary: '另一“鼎丰号”所在，门牌无考。',
  resolution: {
    rawName: '东关正街二郎庙对门', modernName: '东关正街（段落待考）',
    precision: 'street',
    candidates: [
      { name: '东关正街（具体段待考）', coord: null, precision: 'street', note: '二郎庙已毁，无可靠点位' }
    ],
    resolvedAt: 'seed'
  },
  statements: [
    { predicate: 'note', value: { text: '仅有口述，未见档案。' }, sourceIds: [S.oral.id] }
  ]
}, 'seed', { id: 'L3' });

// 招牌
const Z1 = store.createCard('sign', {
  name: '「鼎丰號」金字老匾', summary: '黑底金字横匾，传为赵德厚自立门面时所立。',
  statements: [
    { predicate: 'inscribedText', certainty: 'confirmed', value: { text: '鼎豐號' }, sourceIds: [S.photo.id] },
    { predicate: 'createdOn', certainty: 'inferred', value: { raw: '光绪三十三年' }, sourceIds: [S.oral.id] },
    { predicate: 'note', value: { text: '匾背面墨书“光绪丁未”字样，照片可见。' }, sourceIds: [S.photo.id, S.oral.id] }
  ]
}, 'seed', { id: 'Z1' });

// 商号主体：冲突的创立日期并列两条陈述（绝不覆盖）
const H1 = store.createCard('shop', {
  name: '鼎丰号', aliases: ['鼎豐號南货店'],
  summary: '西安南院门一带南货茶叶商号，1950 年代迁至西大街，1956 年公私合营。',
  periods: [
    { label: '南院门创业期', fromRaw: '民国二十三年', toRaw: '一九五二年春', statementIds: [] },
    { label: '西大街时期', fromRaw: '一九五二年春', toRaw: '一九五六年', statementIds: [] }
  ],
  statements: [
    { predicate: 'foundedOn', certainty: 'confirmed',
      value: { raw: '民国二十三年' }, sourceIds: [S.archives.id, S.qingce.id] },
    { predicate: 'foundedOn', certainty: 'disputed',
      value: { raw: '民国二十四年前后' }, sourceIds: [S.oral.id] },
    { predicate: 'foundedBy', certainty: 'confirmed', value: { personId: P1.id }, sourceIds: [S.oral.id, S.qingce.id] },
    { predicate: 'locatedAt', certainty: 'confirmed',
      value: { placeId: L1.id, raw: '南院门街北第三间' }, sourceIds: [S.fangzhi.id, S.photo.id] },
    { predicate: 'relocatedTo', certainty: 'inferred',
      value: { placeId: L2.id, fromPlaceId: L1.id, raw: '一九五二年春', note: '清册记载迁西街，口述略早于此' },
      sourceIds: [S.qingce.id, S.oral.id] },
    { predicate: 'usesSign', value: { signId: Z1.id }, sourceIds: [S.photo.id] },
    { predicate: 'sells', value: { text: '南货、茶叶、海味' }, sourceIds: [S.qingce.id] },
    { predicate: 'operatedInPeriod',
      value: { label: '南院门创业期', from: { raw: '民国二十三年' }, to: { raw: '一九五二年春' } },
      sourceIds: [S.archives.id] },
    { predicate: 'operatedInPeriod',
      value: { label: '西大街时期', from: { raw: '一九五二年春' }, to: { raw: '一九五六年' } },
      sourceIds: [S.qingce.id] },
    { predicate: 'dissolvedOn', certainty: 'confirmed', value: { raw: '一九五六年' }, sourceIds: [S.qingce.id] }
  ]
}, 'seed', { id: 'H1' });

// 同名商号：不同主体，独立卡片（不自动合并）
store.createCard('shop', {
  name: '鼎丰号', aliases: ['鼎丰号东关分记'],
  summary: '东关正街一家杂货铺，与南院门鼎丰号无资本关系，仅同名。受访人明确否认联号。',
  statements: [
    { predicate: 'foundedOn', certainty: 'inferred', value: { raw: '民国十八年' }, sourceIds: [S.oral.id] },
    { predicate: 'locatedAt', certainty: 'inferred', value: { placeId: L3.id, raw: '东关正街二郎庙对门' }, sourceIds: [S.oral.id] },
    { predicate: 'note', value: { text: '注意：与 H1 同名但非同一主体，合并须有确证并显式操作。' }, sourceIds: [S.oral.id] }
  ]
}, 'seed', { id: 'H2' });

// 首版发布：把人物引用影响逐条“批准为最新版”
for (const it of store.pendingImpacts()) {
  store.resolveImpact(it.id, 'update', 'seed');
}
const v1 = await store.publish('seed', '种子数据初版');
const built = runBuild(store);
console.log('种子完成:', JSON.stringify({ release: v1.id, build: built.cards + ' 张公开卡' }));
