import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDataDir, freshStore, seedMinimal, publishClean } from './helpers.js';

test('来源图片撤权：发布图剔除画面但保留著录与陈述', async () => {
  const store = await freshStore(tempDataDir());
  const seed = seedMinimal(store);
  await publishClean(store, 'v1');
  store.setSourceRights(seed.si.id, 'withdrawn', '家属撤回授权', 'editor');
  // 直接快照（未发布的当前数据）反映撤权
  const snap = store.buildSnapshot();
  const si = snap.sources[seed.si.id];
  assert.equal(si.rightsWithdrawn, true);
  assert.equal(si.uri, null);
  assert.equal(si.embedded, null);
  assert.equal(si.title, '老照片', '著录文字仍保留');
  // 引用该出处的陈述仍在
  const st = snap.cards.Z1.statements.find((s) => s.predicate === 'inscribedText');
  assert.ok(st.sourceIds.includes(seed.si.id));
  // 旧发布版本保持撤权前的画面（已发布不可变）
  const old = store.currentRelease().snapshot.sources[seed.si.id];
  assert.equal(old.rightsWithdrawn, false);
});

test('推广标识只能由 promo 独立维护，故事正文不携带也无法覆盖', async () => {
  const store = await freshStore(tempDataDir());
  seedMinimal(store);
  // 编辑器写入的正文里没有 promo 字段；即便伪造也无效
  const h1 = store.getCard('H1');
  const body = JSON.parse(JSON.stringify(h1.revisions[h1.revisions.length - 1].body));
  body.promo = { enabled: true }; // 试图从正文夹带
  store.addRevision('H1', body, 'editor', {});
  const snap0 = store.buildSnapshot();
  assert.equal(snap0.cards.H1.promo, false);
  // promo 角色设置后才在发布图出现
  store.setPromo('H1', true, '商业合作', 'promo-admin');
  const snap1 = store.buildSnapshot();
  assert.equal(snap1.cards.H1.promo, true);
  // 再编辑正文不会清掉推广
  const body2 = JSON.parse(JSON.stringify(store.currentRevision(store.getCard('H1')).body));
  body2.summary = '普通编辑更新';
  store.addRevision('H1', body2, 'editor', {});
  assert.equal(store.buildSnapshot().cards.H1.promo, true);
});

test('人物/地点卡不能设置推广', async () => {
  const store = await freshStore(tempDataDir());
  seedMinimal(store);
  assert.throws(() => store.setPromo('P1', true, '', 'p'), /仅商号/);
});
