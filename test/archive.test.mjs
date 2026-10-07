import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Store } from '../lib/store.mjs';
import * as d from '../lib/domain.mjs';
import { buildStatic } from '../scripts/build.mjs';

const snapOf = (publication) => publication.snapshot || publication;

async function setupStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firm-archive-'));
  const file = path.join(dir, 'store.json');
  const store = new Store(file);
  await store.load(true);
  await store.mutation((db) => d.publishSnapshot(db, { actor: 'admin', note: '测试初始版本' }));
  return { store, dir, file };
}

test('互相冲突的创立日期并列保存，不被最后编辑值覆盖', async () => {
  const { store } = await setupStore();
  await store.mutation((db) => d.createFoundingClaim(db, {
    subjectId: 'subject_0001',
    date: { text: '民国四年春', iso: '1915-03', precision: 'season', inferred: false },
    sourceRefs: [{ sourceId: 'source_0003', note: '另一条追述' }]
  }, 'editor1'));
  const claims = await store.read((db) => Object.values(db.statements).filter((s) => s.subjectId === 'subject_0001' && s.property === 'foundedAt' && s.status !== 'retracted'));
  assert.ok(claims.length >= 3);
  assert.deepEqual(new Set(claims.map((s) => s.value.date.text)), new Set(['清光绪末年', '民国三年', '民国四年春']));
  assert.ok(claims.every((s) => s.sourceRefs.length > 0));
});

test('推测日期被新出处确证时，旧陈述保留并产生新的活跃陈述', async () => {
  const { store } = await setupStore();
  const result = await store.mutation((db) => d.confirmInferredDate(db, 'statement_0001', {
    date: { text: '宣统二年', iso: '1910', precision: 'year', inferred: false },
    sourceRefs: [{ sourceId: 'source_0004', note: '登记表旁证' }]
  }, 'editor1'));
  assert.equal(result.oldStatement.status, 'superseded');
  assert.equal(result.confirmedStatement.status, 'active');
  assert.equal(result.confirmedStatement.value.date.inferred, false);
  assert.equal(result.confirmedStatement.supersedesStatementId, result.oldStatement.id);
  assert.equal(result.oldStatement.sourceRefs[0].sourceId, 'source_0001');
});

test('历史地点可缺坐标：保留原称和候选位置，只给 warning 不阻断发布', async () => {
  const { store } = await setupStore();
  const pub = await store.read((db) => Object.values(db.publications).sort((a, b) => b.version - a.version)[0]);
  const place = snapOf(pub).data.places.place_0003;
  assert.equal(place.coords, null);
  assert.equal(place.historicalName, '东关正街老牛市口');
  assert.ok(place.candidates[0].name);
  const unresolved = snapOf(pub).validationIssues.filter((i) => i.code === 'UNRESOLVED_COORDS');
  assert.ok(unresolved.some((i) => i.placeId === 'place_0003'));
  assert.ok(unresolved.every((i) => i.severity === 'warning'));
});

test('人物修订生成引用影响清单；批准后旧陈述仍固定引用版本', async () => {
  const { store } = await setupStore();
  const { revision, pendingChange } = await store.mutation((db) => d.updatePerson(db, 'person_0001', { version: 1, name: '张懋斋', bio: '据碑刻校定为懋' }, 'editor2'));
  assert.equal(revision.fromVersion, 1);
  assert.equal(revision.toVersion, 2);
  assert.ok(revision.impacts.some((i) => i.statementId === 'statement_0003'));
  assert.equal(pendingChange.status, 'pending');
  const approved = await store.mutation((db) => d.approvePending(db, pendingChange.id, 'admin').then((x) => x.publication));
  const st = snapOf(approved).data.statements.statement_0003;
  assert.equal(st.value.personVersion, 1);
  assert.ok(snapOf(approved).data.personVersions['person_0001@1']);
  assert.equal(snapOf(approved).data.persons.person_0001.version, 2);
  await store.read((db) => assert.equal(db.pendingChanges[pendingChange.id].status, 'approved'));
});

test('来源图片撤权生成影响；新公开快照隐藏图像数据，旧快照保留已发布内容', async () => {
  const { store } = await setupStore();
  const before = await store.read((db) => Object.values(db.publications).find((p) => p.status === 'published'));
  assert.ok(snapOf(before).data.media.media_0001.dataUri);
  const { pendingChange: pending, impact } = await store.mutation((db) => d.withdrawMediaRights(db, 'media_0001', { reason: '家属撤回授权' }, 'editor1'));
  assert.ok(impact.some((i) => i.signId === 'sign_0001'));
  const after = await store.mutation((db) => d.approvePending(db, pending.id, 'admin').then((x) => x.publication));
  assert.equal(snapOf(after).data.media.media_0001.rightsStatus, 'withdrawn');
  assert.equal(snapOf(after).data.media.media_0001.dataUri, undefined);
  assert.ok(snapOf(before).data.media.media_0001.dataUri);
});

test('人物影响清单不能被普通发布绕过；驳回后才可重新发布', async () => {
  const { store } = await setupStore();
  const { pendingChange } = await store.mutation((db) => d.updatePerson(db, 'person_0003', { version: 1, name: '陈永庆（待考）', bio: '口述校字' }, 'editor1'));
  await assert.rejects(store.mutation((db) => d.publishSnapshot(db, { actor: 'admin' })), /PENDING_APPROVAL_REQUIRED|未处理的影响清单/);
  await store.mutation((db) => d.rejectPending(db, pendingChange.id, 'admin', { note: '证据不足' }));
  const published = await store.mutation((db) => d.publishSnapshot(db, { actor: 'admin', note: '驳回后重新发布' }));
  assert.equal(snapOf(published).version, 2);
});

test('同一商号多次迁址：事件与按时期拆分并存', async () => {
  const { store } = await setupStore();
  const first = await store.mutation((db) => d.createRelocationAndSplit(db, {
    subjectId: 'subject_0002', date: { text: '民国二十一年', iso: '1932', precision: 'year', inferred: false },
    fromPlaceId: 'place_0004', toPlaceId: 'place_0001', sourceIds: ['source_0004']
  }, 'editor1'));
  const second = await store.mutation((db) => d.createRelocationAndSplit(db, {
    subjectId: 'subject_0002', date: { text: '民国二十四年', iso: '1935', precision: 'year', inferred: false },
    fromPlaceId: 'place_0001', toPlaceId: 'place_0002', sourceIds: ['source_0001'], periodFromId: first.periodTo.id
  }, 'editor1'));
  assert.notEqual(first.event.id, second.event.id);
  assert.notEqual(first.periodTo.id, second.periodTo.id);
  assert.equal(second.periodTo.placeId, 'place_0002');
});

test('合并迁移时期、事件、招牌和陈述；撤销合并按账本恢复', async () => {
  const { store } = await setupStore();
  const { merge } = await store.mutation((db) => d.mergeSubjects(db, { sourceSubjectId: 'subject_0003', targetSubjectId: 'subject_0002' }, 'editor1'));
  assert.ok(merge.changes.some((c) => c.collection === 'periods' && c.id === 'period_0004'));
  assert.ok(merge.changes.some((c) => c.collection === 'signs' && c.id === 'sign_0002'));
  await store.read((db) => {
    assert.equal(db.periods.period_0004.subjectId, 'subject_0002');
    assert.equal(db.subjects.subject_0003.status, 'merged');
    assert.ok(db.subjects.subject_0002.aliases.includes('永庆和（东关）'));
  });
  await store.mutation((db) => d.unmergeSubjects(db, merge.id, 'editor2'));
  await store.read((db) => {
    assert.equal(db.periods.period_0004.subjectId, 'subject_0003');
    assert.equal(db.signs.sign_0002.subjectId, 'subject_0003');
    assert.equal(db.subjects.subject_0003.status, 'active');
    assert.equal(db.merges[merge.id].status, 'undone');
  });
});

test('两位编辑同时合并同名商号时只有一个迁移成功，另一个冲突且数据不半迁移', async () => {
  const { store } = await setupStore();
  const [a, b] = await Promise.allSettled([
    store.mutation((db) => d.mergeSubjects(db, { sourceSubjectId: 'subject_0003', targetSubjectId: 'subject_0002' }, 'editor1')),
    store.mutation((db) => d.mergeSubjects(db, { sourceSubjectId: 'subject_0003', targetSubjectId: 'subject_0001' }, 'editor2'))
  ]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.match(b.reason.message, /存续商号可合并/);
  const moved = await store.read((db) => Object.values(db.periods).filter((p) => p.subjectId === 'subject_0002').length);
  assert.ok(moved >= 1);
});

test('循环合并引用阻断发布', async () => {
  const { store } = await setupStore();
  await store.mutation((db) => {
    db.subjects.subject_0002.status = 'merged';
    db.subjects.subject_0002.mergedInto = 'subject_0003';
    db.subjects.subject_0003.status = 'merged';
    db.subjects.subject_0003.mergedInto = 'subject_0002';
  });
  await assert.rejects(store.mutation((db) => d.publishSnapshot(db, { actor: 'admin' })), /MERGE_CYCLE|合并关系存在循环/);
});

test('静态页构建在发布校验失败时失败且保留旧 dist', async () => {
  const { dir, file } = await setupStore();
  const out = path.join(dir, 'dist');
  await fs.promises.mkdir(out, { recursive: true });
  await fs.promises.writeFile(path.join(out, 'keep.txt'), 'old build');
  const store2 = new Store(file);
  await store2.load(false);
  await store2.mutation((db) => {
    const st = Object.values(db.statements)[0];
    st.sourceRefs = [];
    st.status = 'active';
  });
  const result = await buildStatic({ dataFile: file, outDir: out, webDir: path.join(process.cwd(), 'web'), publishInitial: false, corruptCheck: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /静态页构建失败|没有已批准|发布校验失败|NO_SOURCE/);
  assert.equal(await fs.promises.readFile(path.join(out, 'keep.txt'), 'utf8'), 'old build');
});

test('成功静态页使用同一公开版本并注入快照', async () => {
  const { dir, file } = await setupStore();
  const out = path.join(dir, 'dist');
  const result = await buildStatic({ dataFile: file, outDir: out, webDir: path.join(process.cwd(), 'web') });
  assert.equal(result.ok, true);
  const html = await fs.promises.readFile(path.join(out, 'index.html'), 'utf8');
  assert.ok(!html.includes('__ARCHIVE_SNAPSHOT__'));
  assert.ok(html.includes('公开时间轴'));
  const version = JSON.parse(await fs.promises.readFile(path.join(out, 'version.json'), 'utf8'));
  assert.ok(version.version >= 1);
});
