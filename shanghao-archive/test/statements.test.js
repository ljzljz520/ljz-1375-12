import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDataDir, freshStore, seedMinimal, publishClean } from './helpers.js';

test('冲突创立日期并列保留：发布后仍是两条独立陈述，各带来源', async () => {
  const store = await freshStore(tempDataDir());
  seedMinimal(store);
  await publishClean(store);
  const snap = store.currentRelease().snapshot;
  const f = snap.cards.H1.statements.filter((s) => s.predicate === 'foundedOn');
  assert.equal(f.length, 2, '两条创立陈述都必须存在');
  assert.deepEqual(f.map((x) => x.value.raw).sort(), ['民国二十三年', '民国二十四年前后']);
  assert.equal(f.find((x) => x.certainty === 'confirmed').sourceIds[0], 'S1');
  assert.equal(f.find((x) => x.certainty === 'disputed').sourceIds[0], 'S2');
});

test('编辑保存生成新修订，旧版本仍在；乐观锁阻止覆盖', async () => {
  const store = await freshStore(tempDataDir());
  seedMinimal(store);
  const h1 = store.getCard('H1');
  const revBefore = h1.revisions.length;
  const expected = h1.revisions[revBefore - 1].id;
  const body = h1.revisions[revBefore - 1].body;
  store.addRevision('H1', { ...body, summary: '改了摘要' }, 'editor', { expectedRev: expected });
  assert.equal(store.getCard('H1').revisions.length, revBefore + 1);
  assert.equal(store.getCard('H1').revisions[0].body.summary, '测试商号'); // 旧版不变
  assert.throws(() => store.addRevision('H1', { ...body, summary: '迟到编辑' }, 'editor2',
    { expectedRev: expected }), /修订冲突/);
});

test('推测日期可升级为确证（新修订，不改写旧陈述）', async () => {
  const store = await freshStore(tempDataDir());
  seedMinimal(store);
  // 招牌制成年代：光绪三十三年由 inferred 升级为 confirmed（有新档案）
  const z = store.getCard('Z1');
  const body = JSON.parse(JSON.stringify(z.revisions[z.revisions.length - 1].body));
  const st = body.statements.find((s) => s.predicate === 'createdOn');
  assert.equal(st.certainty, 'inferred');
  st.certainty = 'confirmed';
  st.sourceIds = [...new Set([...st.sourceIds, 'S1'])];
  store.addRevision('Z1', body, 'editor', {});
  const snap0 = store.buildSnapshot();
  const pub = snap0.cards.Z1.statements.find((s) => s.predicate === 'createdOn');
  assert.equal(pub.certainty, 'confirmed');
  // 旧修订保留推测状态
  assert.equal(store.getCard('Z1').revisions[0].body.statements.find((s) => s.predicate === 'createdOn').certainty, 'inferred');
});

test('缺坐标地点仍可读：快照保留原称/候选/精度，公开数据不丢卡', async () => {
  const store = await freshStore(tempDataDir());
  seedMinimal(store);
  await publishClean(store);
  const l2 = store.currentRelease().snapshot.cards.L2;
  assert.equal(l2.resolution.candidates[0].coord, null);
  assert.equal(l2.resolution.rawName, '西大街口');
  assert.equal(l2.resolution.precision, 'street');
  assert.ok(l2.statements.length >= 1);
});
