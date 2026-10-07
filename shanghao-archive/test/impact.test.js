import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDataDir, freshStore, seedMinimal, publishClean } from './helpers.js';

test('引用人物被修订后生成影响清单；未批准前发布被阻止', async () => {
  const store = await freshStore(tempDataDir());
  seedMinimal(store);
  await publishClean(store, 'v1');

  // 人物 P1 被修订（新考出生年）
  const p1 = store.getCard('P1');
  const body = JSON.parse(JSON.stringify(p1.revisions[p1.revisions.length - 1].body));
  body.summary = '补证生卒';
  store.addRevision('P1', body, 'editor', {});

  const impact = store.impactForPerson('P1');
  const h1Item = impact.items.find((i) => i.cardId === 'H1' && i.predicate === 'foundedBy');
  assert.ok(h1Item);
  assert.notEqual(h1Item.status, 'current');

  // 发布被阻止
  await assert.rejects(store.publish('approver', 'v2?'), /影响未批准/);

  // 编辑批准“更新到新修订”
  store.resolveImpact(h1Item.id, 'update', 'editor');
  assert.equal(store.pendingImpacts().length, 0);

  // 新发布图里引用指向新修订
  const rel = await store.publish('approver', 'v2');
  const st = store.currentRelease().snapshot.cards.H1.statements.find((s) => s.predicate === 'foundedBy');
  const ref = st.refs.find((r) => r.cardId === 'P1');
  assert.equal(ref.pinnedRev, store.currentRevision(store.getCard('P1')).id);
});

test('选择保留：旧卡引用钉在旧人物修订，发布图保持旧版', async () => {
  const store = await freshStore(tempDataDir());
  seedMinimal(store);
  await publishClean(store, 'v1');
  const oldPersonRev = store.currentRevision(store.getCard('P1')).id;

  store.addRevision('P1', JSON.parse(JSON.stringify(
    store.currentRevision(store.getCard('P1')).body)), 'editor', { note: '新修订' });
  const newRev = store.currentRevision(store.getCard('P1')).id;
  assert.notEqual(oldPersonRev, newRev);

  const item = store.impactForPerson('P1').items.find((i) => i.cardId === 'H1');
  store.resolveImpact(item.id, 'keep', 'editor'); // 保留引用版本
  await store.publish('approver', 'v2');
  const ref = store.currentRelease().snapshot.cards.H1.statements
    .find((s) => s.predicate === 'foundedBy').refs[0];
  assert.equal(ref.pinnedRev, oldPersonRev, '旧卡应继续引用旧人物修订');
});
