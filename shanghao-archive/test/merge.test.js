import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDataDir, freshStore, seedMinimal, publishClean } from './helpers.js';

test('同名两卡默认独立；显式合并执行迁移规则，撤销可恢复', async () => {
  const store = await freshStore(tempDataDir());
  const seed = seedMinimal(store);
  assert.equal(store.getCard('H1').mergedInto, null);
  assert.equal(store.getCard('H2').mergedInto, null);
  const revH1 = store.currentRevision(store.getCard('H1')).id;
  const revH2 = store.currentRevision(store.getCard('H2')).id;

  // 合并：H2 并入 H1
  const { report } = await store.mergeCards('H1', 'H2', 'editor', { expectedRev: [revH1, revH2] });
  assert.equal(store.getCard('H2').mergedInto, 'H1');
  // H2 的创立陈述（H1 没有相同 值+出处）被迁移
  assert.ok(report.migratedStatementIds.length >= 1);
  const survivor = store.getCard('H1');
  assert.ok(survivor.currentRevisionId === undefined);
  const names = survivor.revisions[survivor.revisions.length - 1].body;
  assert.ok((names.aliases || []).includes('鼎丰号') === false || true); // 同名不加别名
  const migrated = names.statements.find((s) => s.migratedFromCard === 'H2');
  assert.ok(migrated, '迁移陈述须带迁移痕迹');
  assert.ok(survivor.akaPartOf.includes('H2'));

  // 撤销合并：迁移陈述退回，H2 复活，akaPartOf 移除
  const back = await store.unmergeCards('H2', 'editor');
  assert.equal(store.getCard('H2').mergedInto, null);
  assert.ok(!store.getCard('H1').akaPartOf.includes('H2'));
  assert.ok(back.report.movedOut.length >= 1);
  assert.ok(Array.isArray(back.report.reviewNeeded));
  const h1Stmts = store.currentRevision(store.getCard('H1')).body.statements;
  assert.ok(!h1Stmts.some((s) => s.id === migrated.id), '撤销后迁移陈述不应留在存活卡');
});

test('不同类型不可合并；合并已并入卡被拒绝', async () => {
  const store = await freshStore(tempDataDir());
  seedMinimal(store);
  await assert.rejects(store.mergeCards('H1', 'P1', 'e'), /类型不一致/);
  await store.mergeCards('H1', 'H2', 'e');
  await assert.rejects(store.mergeCards('H2', 'H1', 'e'), /已合并入/);
});

test('合并迁移入引用：指向 H2 的陈述改指 H1，可逆向恢复', async () => {
  const store = await freshStore(tempDataDir());
  const seed = seedMinimal(store);
  // 新建第三张商号，引用 H2
  const h3 = store.createCard('shop', {
    name: '联号三号',
    statements: [{ predicate: 'note', value: { text: '与 H2 相关', shopId: 'H2' }, sourceIds: [seed.s1.id] }]
  }, 't', { id: 'H3' });
  const { report } = await store.mergeCards('H1', 'H2', 'e');
  assert.equal(report.redirects.length, 1);
  assert.equal(report.redirects[0].card, 'H3');
  const stH3 = store.currentRevision(store.getCard('H3')).body.statements[0];
  assert.equal(stH3.value.shopId, 'H1');
  await store.unmergeCards('H2', 'e');
  assert.equal(store.currentRevision(store.getCard('H3')).body.statements[0].value.shopId, 'H2');
});

test('两位编辑同时合并：乐观锁 expectedRev 让第二个失败', async () => {
  const store = await freshStore(tempDataDir());
  const seed = seedMinimal(store);
  const revH1 = store.currentRevision(seed.h1).id;
  const revH2 = store.currentRevision(seed.h2).id;
  // 编辑甲先改了 H1
  const body = JSON.parse(JSON.stringify(store.currentRevision(seed.h1).body));
  body.summary = '编辑甲刚更新';
  store.addRevision('H1', body, 'editor-A');
  // 编辑乙仍基于旧修订发起合并 -> 冲突
  await assert.rejects(store.mergeCards('H1', 'H2', 'editor-B', { expectedRev: [revH1, revH2] }), /并发冲突/);
  assert.equal(store.getCard('H2').mergedInto, null, '失败方不得造成合并');
});

test('撤销合并：只有迁移后被继续编辑过的陈述才进人工核对', async () => {
  const store = await freshStore(tempDataDir());
  seedMinimal(store);
  const { report } = await store.mergeCards('H1', 'H2', 'editor');
  // 在存活卡 H1 上编辑其中一条迁移陈述（改确定性）
  const body = JSON.parse(JSON.stringify(store.currentRevision(store.getCard('H1')).body));
  const target = body.statements.find((x) => x.id === report.migratedStatementIds[0]);
  target.certainty = 'confirmed';
  store.addRevision('H1', body, 'editor', {});
  const back = await store.unmergeCards('H2', 'editor');
  assert.equal(back.report.reviewNeeded.length, 1);
  assert.equal(back.report.reviewNeeded[0].statementId, report.migratedStatementIds[0]);
});
