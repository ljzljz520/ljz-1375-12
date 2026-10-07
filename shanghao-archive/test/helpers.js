// 每个测试文件使用独立临时数据目录，保证隔离、可重复。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shanghao-'));
  return dir;
}

export async function freshStore(dataDir) {
  process.env.DATA_DIR = dataDir;
  // store 在首次 import 时按 DATA_DIR 初始化；用查询参数缓存失效
  const mod = await import(`../src/store.js?dir=${encodeURIComponent(dataDir)}`);
  return mod.store;
}

export function seedMinimal(store) {
  // 人物 + 出处 + 商号（含两条并列创立日期）+ 地点（含无坐标）+ 招牌
  const s1 = store.createSource({ kind: 'document', title: '档案甲' }, 'test');
  const s2 = store.createSource({ kind: 'document', title: '口述乙' }, 'test');
  const si = store.createSource({ kind: 'image', title: '老照片', uri: 'a.jpg', rights: 'licensed' }, 'test');
  const p1 = store.createCard('person', {
    name: '张三', statements: [
      { predicate: 'bornOn', certainty: 'inferred', value: { raw: '光绪十年' }, sourceIds: [s2.id] },
      { predicate: 'note', value: { text: '创立者' }, sourceIds: [s2.id] }
    ]
  }, 'test', { id: 'P1' });
  const l1 = store.createCard('place', {
    name: '南院门', resolution: {
      rawName: '南院门街北', modernName: '南院门广场', precision: 'block',
      candidates: [{ name: '南院门广场', coord: { lat: 34.2552, lng: 108.9391 }, precision: 'block' }]
    }, statements: [{ predicate: 'note', value: { text: '旧址' }, sourceIds: [s1.id] }]
  }, 'test', { id: 'L1' });
  const l2 = store.createCard('place', {
    name: '西大街', resolution: {
      rawName: '西大街口', modernName: '西大街南口', precision: 'street',
      candidates: [{ name: '待考段', coord: null, precision: 'street' }]
    }, statements: [{ predicate: 'note', value: { text: '新址，无坐标' }, sourceIds: [s2.id] }]
  }, 'test', { id: 'L2' });
  const z1 = store.createCard('sign', {
    name: '老匾', statements: [
      { predicate: 'inscribedText', certainty: 'confirmed', value: { text: '鼎豐號' }, sourceIds: [si.id] },
      { predicate: 'createdOn', certainty: 'inferred', value: { raw: '光绪三十三年' }, sourceIds: [s2.id] }
    ]
  }, 'test', { id: 'Z1' });
  const h1 = store.createCard('shop', {
    name: '鼎丰号', summary: '测试商号', statements: [
      { predicate: 'foundedOn', certainty: 'confirmed', value: { raw: '民国二十三年' }, sourceIds: [s1.id] },
      { predicate: 'foundedOn', certainty: 'disputed', value: { raw: '民国二十四年前后' }, sourceIds: [s2.id] },
      { predicate: 'foundedBy', certainty: 'confirmed', value: { personId: 'P1' }, sourceIds: [s1.id] },
      { predicate: 'locatedAt', value: { placeId: 'L1', raw: '南院门街北' }, sourceIds: [s1.id, si.id] },
      { predicate: 'relocatedTo', certainty: 'inferred',
        value: { placeId: 'L2', fromPlaceId: 'L1', raw: '一九五二年春' }, sourceIds: [s2.id] },
      { predicate: 'usesSign', value: { signId: 'Z1' }, sourceIds: [si.id] }
    ]
  }, 'test', { id: 'H1' });
  const h2 = store.createCard('shop', {
    name: '鼎丰号', summary: '同名异主体',
    statements: [{ predicate: 'foundedOn', certainty: 'inferred', value: { raw: '民国十八年' }, sourceIds: [s2.id] }]
  }, 'test', { id: 'H2' });
  return { s1, s2, si, p1, l1, l2, z1, h1, h2 };
}

export async function publishClean(store, note = '测试版本') {
  for (const it of store.pendingImpacts()) store.resolveImpact(it.id, 'update', 'test');
  return await store.publish('test-approver', note);
}
