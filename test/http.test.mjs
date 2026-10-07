import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { initServer, server } from '../server.mjs';

await initServer();
async function listen() {
  if (!server.listening) {
    server.listen(0);
    await once(server, 'listening');
  }
  return `http://127.0.0.1:${server.address().port}`;
}
async function req(base, path, { method = 'GET', user, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  return { status: res.status, json };
}

test.after(async () => {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
});


test('推广标识由独立 promotion 权限维护，普通故事编辑不能覆盖', async () => {
  const base = await listen();
  const forbidden = await req(base, '/api/promotions', { method: 'POST', user: 'editor1', body: { subjectId: 'subject_0001', label: '隐形广告', body: '故事正文试图覆盖' } });
  assert.equal(forbidden.status, 403);
  const allowed = await req(base, '/api/promotions', { method: 'POST', user: 'promoter', body: { subjectId: 'subject_0002', label: '旅游推荐', body: '独立授权' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.json.result.promotion.label, '旅游推荐');
});

test('公开接口无需登录，编辑接口需要登录', async () => {
  const base = await listen();
  const pub = await req(base, '/api/public/current');
  assert.equal(pub.status, 200);
  assert.equal(pub.json.result.version > 0, true);
  const denied = await req(base, '/api/subjects', { method: 'POST', body: { name: '游客商号' } });
  assert.equal(denied.status, 401);
});
