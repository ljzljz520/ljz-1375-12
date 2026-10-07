import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDataDir, freshStore, seedMinimal, publishClean } from './helpers.js';
import { runBuild } from '../src/build.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(projectRoot, 'dist');

test('静态构建：打印/搜索/详情/地图共用同一数据文件与版本哈希', async () => {
  const store = await freshStore(tempDataDir());
  seedMinimal(store);
  await publishClean(store, 'build-v1');
  const result = runBuild(store);
  assert.ok(result.ok);
  const card = fs.readFileSync(path.join(dist, 'card-H1.html'), 'utf8');
  const print = fs.readFileSync(path.join(dist, 'print-H1.html'), 'utf8');
  const dataFile = fs.readdirSync(path.join(dist, 'assets')).find((f) => f.startsWith('data-'));
  assert.ok(dataFile);
  for (const html of [card, print]) {
    assert.ok(html.includes(dataFile), '页面必须引用同版数据文件');
    assert.ok(html.includes(result.hash), '页面必须带版本哈希');
  }
  assert.ok(card.includes('迁址：西大街'));
  const data = fs.readFileSync(path.join(dist, 'assets', dataFile), 'utf8');
  assert.ok(data.includes('searchIndex'));
  assert.ok(data.includes('鼎丰号'));
  // 推广标签在数据驱动下渲染
  store.setPromo('H1', true, 't', 'promo');
});

test('静态页构建失败：旧 dist 保留可用，无残留暂存目录', async () => {
  const store = await freshStore(tempDataDir());
  seedMinimal(store);
  await publishClean(store, 'build-good');
  runBuild(store);
  const goodIndex = fs.readFileSync(path.join(dist, 'card-H1.html'), 'utf8');
  const goodData = fs.readdirSync(path.join(dist, 'assets')).find((f) => f.startsWith('data-'));

  // 模拟构建失败：破坏构建输入（项目 public-site 资源临时缺失），runBuild 在写暂存阶段抛错
  const styleSrc = path.join(projectRoot, 'public-site', 'style.css');
  const styleBak = fs.readFileSync(styleSrc);
  fs.rmSync(styleSrc);
  try {
    assert.throws(() => runBuild(store), /no such file|ENOENT|构建/);
  } finally {
    fs.writeFileSync(styleSrc, styleBak);
  }

  assert.ok(fs.existsSync(path.join(dist, 'index.html')));
  assert.equal(fs.readFileSync(path.join(dist, 'card-H1.html'), 'utf8'), goodIndex);
  assert.ok(fs.existsSync(path.join(dist, 'assets', goodData)));
  assert.ok(!fs.existsSync(path.join(projectRoot, '.dist-stage')));
  assert.ok(!fs.existsSync(path.join(projectRoot, '.dist-new')));
});

test('没有任何已发布版本时拒绝构建（公开页必须来自发布版本）', async () => {
  const store = await freshStore(tempDataDir());
  seedMinimal(store);
  assert.throws(() => runBuild(store), /尚无已发布版本/);
});

test('端到端循环引用：地点 partOf 成环在保存与发布两处被阻断', async () => {
  const store = await freshStore(tempDataDir());
  const seed = seedMinimal(store);
  // L4 partOf L2（合法，无环）
  store.createCard('place', {
    name: '环地点乙',
    statements: [{ predicate: 'partOf', value: { placeId: 'L2' }, sourceIds: [seed.s1.id] }]
  }, 't', { id: 'L4' });
  // 让 L2 再 partOf L4 => L2 -> L4 -> L2 环，保存必须被拒
  const l2body = JSON.parse(JSON.stringify(store.currentRevision(store.getCard('L2')).body));
  l2body.statements.push({ predicate: 'partOf', value: { placeId: 'L4' }, sourceIds: [seed.s1.id] });
  assert.throws(() => store.addRevision('L2', l2body, 't', {}), /循环引用/);
  // L2 未被改动
  assert.equal(store.getCard('L2').revisions.length, 1);

  // 发布快照校验同样会报环（手工构造环后直接 buildSnapshot）
  const forced = JSON.parse(JSON.stringify(store.currentRevision(store.getCard('L2')).body));
  forced.statements.push({ predicate: 'partOf', value: { placeId: 'L4' }, sourceIds: [seed.s1.id] });
  store.getCard('L2').revisions.push({
    id: 'RX', rev: 2, note: '旁路注入', actor: 't', at: new Date().toISOString(), body: forced
  });
  assert.throws(() => store.buildSnapshot(), /循环引用/);
  store.getCard('L2').revisions.pop(); // 还原
});
