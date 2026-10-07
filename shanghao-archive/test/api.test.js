import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8911;
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = { editor: 'tok-editor', approver: 'tok-approver', promo: 'tok-promo', viewer: 'tok-viewer' };
let child, dataDir;

function req(method, p, token, body) {
  return fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join('/tmp', 'shanghao-api-'));
  await new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['src/server.js'], {
      cwd: root, env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir }, stdio: ['ignore', 'ignore', 'inherit']
    });
    child.on('error', reject);
    const t0 = Date.now();
    const tick = setInterval(async () => {
      try {
        const r = await fetch(`${BASE}/api/cards`);
        if (r.ok) { clearInterval(tick); resolve(); }
      } catch { if (Date.now() - t0 > 8000) { clearInterval(tick); reject(new Error('server timeout')); } }
    }, 100);
  });
});
after(() => { try { child.kill(); } catch {} });

test('HTTP：未认证 401；viewer 只读；promo 独立', async () => {
  assert.equal((await req('GET', '/api/session')).status, 401);
  const created = await req('POST', '/api/cards', TOK.viewer, { type: 'shop', name: 'x', statements: [] });
  assert.equal(created.status, 403);
  const sess = await req('GET', '/api/session', TOK.editor);
  assert.equal(sess.json.role, 'editor');
});

test('HTTP 全流程：出处→卡片（冲突创立并列）→发布→撤权→再发布→构建', async () => {
  const s1 = await req('POST', '/api/sources', TOK.editor, { kind: 'document', title: '档案' });
  const s2 = await req('POST', '/api/sources', TOK.editor, { kind: 'document', title: '口述' });
  const si = await req('POST', '/api/sources', TOK.editor, { kind: 'image', title: '照片', uri: 'x.jpg', rights: 'licensed' });
  assert.equal(s1.status, 201);

  const p1 = await req('POST', '/api/cards', TOK.editor, {
    type: 'person', name: '赵德厚',
    statements: [{ predicate: 'note', value: { text: '创立者' }, sourceIds: [s1.json.id] }]
  });
  const z1 = await req('POST', '/api/cards', TOK.editor, {
    type: 'sign', name: '老匾',
    statements: [{ predicate: 'inscribedText', certainty: 'confirmed', value: { text: '鼎豐號' }, sourceIds: [si.json.id] }]
  });
  const h1 = await req('POST', '/api/cards', TOK.editor, {
    type: 'shop', name: '鼎丰号',
    statements: [
      { predicate: 'foundedOn', certainty: 'confirmed', value: { raw: '民国二十三年' }, sourceIds: [s1.json.id] },
      { predicate: 'foundedOn', certainty: 'disputed', value: { raw: '民国二十四年前后' }, sourceIds: [s2.json.id] },
      { predicate: 'foundedBy', certainty: 'confirmed', value: { personId: p1.json.id }, sourceIds: [s1.json.id] },
      { predicate: 'usesSign', value: { signId: z1.json.id }, sourceIds: [si.json.id] }
    ]
  });
  assert.equal(h1.status, 201);
  // 缺出处被拒
  const bad = await req('POST', '/api/cards', TOK.editor, {
    type: 'shop', name: '无据商号',
    statements: [{ predicate: 'note', value: { text: '口说无凭' }, sourceIds: [] }]
  });
  assert.equal(bad.status, 400);

  // 首次发布会被人物引用影响阻塞；处理后再发
  const blocked = await req('POST', '/api/releases', TOK.approver, {});
  assert.equal(blocked.status, 409);
  assert.ok(blocked.json.pending.length >= 1);
  for (const it of blocked.json.pending) {
    await req('POST', `/api/impacts/${encodeURIComponent(it.id)}/decision`, TOK.editor, { decision: 'update' });
  }
  const rel = await req('POST', '/api/releases', TOK.approver, { note: 'v1' });
  assert.equal(rel.status, 201);
  const relData = await req('GET', `/api/releases/latest/data`, TOK.editor);
  const fDates = relData.json.cards[h1.json.id].statements.filter((x) => x.predicate === 'foundedOn');
  assert.equal(fDates.length, 2);

  // editor 不能动推广；promo 可以
  assert.equal((await req('PUT', `/api/cards/${h1.json.id}/promo`, TOK.editor, { enabled: true })).status, 403);
  const promo = await req('PUT', `/api/cards/${h1.json.id}/promo`, TOK.promo, { enabled: true, note: '合作' });
  assert.equal(promo.status, 200);

  // 撤权图片后重新发布 + 构建
  const wd = await req('PUT', `/api/sources/${si.json.id}/rights`, TOK.editor, { rights: 'withdrawn' });
  assert.equal(wd.status, 200);
  const rel2 = await req('POST', '/api/releases', TOK.approver, { note: 'v2 撤权' });
  assert.equal(rel2.status, 201);
  const built = await req('POST', '/api/build', TOK.approver, { persist: true });
  assert.equal(built.status, 200);
  assert.ok(built.json.ok);

  // 公开站可访问且引用的新数据文件中图片已剔除
  const home = await fetch(`${BASE}/site/`);
  assert.equal(home.status, 200);
  const snap = relData.json;
  assert.equal(snap.sources[si.json.id].rightsWithdrawn, false, '旧版仍有授权');
  const latestSnap = (await req('GET', `/api/releases/latest?data=1`, TOK.editor)).json;
  assert.equal(latestSnap.sources[si.json.id].uri, null);
});

test('HTTP：两位编辑并发合并同一目标，恰好一胜一败', async () => {
  const s1 = (await req('POST', '/api/sources', TOK.editor, { kind: 'document', title: '档' })).json;
  const mk = async (name) => (await req('POST', '/api/cards', TOK.editor, {
    type: 'shop', name,
    statements: [{ predicate: 'foundedOn', certainty: 'inferred', value: { raw: '民国十年' }, sourceIds: [s1.id] }]
  })).json;
  const A = await mk('并发甲');
  const B = await mk('并发乙');
  const revA = A.current.revisionId;
  const revB = B.current.revisionId;
  const [r1, r2] = await Promise.all([
    req('POST', `/api/cards/${A.id}/merge`, TOK.editor, { mergedId: B.id, expectedRev: [revA, revB] }),
    req('POST', `/api/cards/${A.id}/merge`, TOK.editor, { mergedId: B.id, expectedRev: [revA, revB] })
  ]);
  const status = [r1.status, r2.status].sort().join(',');
  assert.equal(status, '200,409', `期望一成一败，实际 ${status}`);
  // 失败者可在刷新基准后看到已合并状态
  const cardB = (await req('GET', `/api/cards/${B.id}`, TOK.editor)).json;
  assert.equal(cardB.mergedInto, A.id);
});
