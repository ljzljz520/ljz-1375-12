const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const state = { snapshot: null, admin: null, user: null, selectedSubject: null, search: '' };

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function by(collection, id) { return state.snapshot?.data?.[collection]?.[id] || state.snapshot?.data?.[collection]?.find?.(x => x.id === id); }
function vals(collection) { const x = state.snapshot?.data?.[collection]; return Array.isArray(x) ? x : Object.values(x || {}); }
function adminVals(name) { const x = state.admin?.[name]; return Array.isArray(x) ? x : Object.values(x || {}); }
function showToast(msg, bad = false) {
  const t = $('#toast');
  t.hidden = false;
  t.style.background = bad ? '#5d1f18' : '#2d2018';
  t.textContent = msg;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { t.hidden = true; }, 5200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let payload = null;
  try { payload = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(payload?.error || `请求失败 ${res.status}`);
    err.payload = payload;
    throw err;
  }
  return payload;
}

function getEmbeddedSnapshot() {
  const tag = $('#archive-snapshot');
  const raw = tag?.textContent?.trim();
  if (!raw || raw === '__ARCHIVE_SNAPSHOT__') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function loadPublicSnapshot(force = false) {
  const embedded = getEmbeddedSnapshot();
  if (embedded && !force) state.snapshot = embedded;
  else {
    const payload = await api('/api/public/current');
    state.snapshot = payload.result;
  }
  $('#versionBadge').textContent = `公开版本 v${state.snapshot.version} · ${new Date(state.snapshot.publishedAt).toLocaleString('zh-CN')} · ${esc(state.snapshot.publishedBy)} 批准`;
}

async function whoami() {
  try {
    const payload = await api('/api/me');
    state.user = payload.result;
  } catch { state.user = null; }
  renderLogin();
}

async function loadAdmin() {
  if (!state.user) { state.admin = null; return; }
  const keys = ['subjects', 'persons', 'places', 'periods', 'events', 'signs', 'statements', 'sources', 'media', 'merges', 'promotions', 'pendingChanges', 'publications'];
  const entries = await Promise.all(keys.map(async (k) => {
    const r = await api(`/api/${k}`);
    return [k, r.result];
  }));
  state.admin = Object.fromEntries(entries);
  populateSelects();
  renderMergeList();
  renderApproval();
  renderPromo();
  renderInferred();
  renderMediaRights();
}

function renderLogin() {
  const roles = state.user ? state.user.roles.join('、') : '未登录（只读公开版本）';
  $('#loginBox').innerHTML = `
    <span>${state.user ? esc(state.user.displayName) : '游客'} <small>(${esc(roles)})</small></span>
    <select id="userSelect">
      <option value="">切换为游客</option>
      <option value="editor1">editor1 编辑甲</option>
      <option value="editor2">editor2 编辑乙</option>
      <option value="promoter">promoter 推广管理员</option>
      <option value="admin">admin 总编辑/审批</option>
    </select>
    <button id="loginBtn" class="secondary">切换</button>
    ${state.user?.roles.includes('approver') ? '<button id="buildBtn">构建静态页</button>' : ''}`;
  $('#userSelect').value = state.user?.username || '';
  $('#loginBtn').onclick = async () => {
    const username = $('#userSelect').value;
    if (username) await api('/api/auth/login', { method: 'POST', body: { username } });
    else document.cookie = 'archive_user=; Max-Age=0; path=/';
    location.reload();
  };
  const buildBtn = $('#buildBtn');
  if (buildBtn) buildBtn.onclick = async () => {
    try { const r = await api('/api/build', { method: 'POST', body: {} }); showToast(`静态页构建成功：v${r.result.version}`); }
    catch (e) { showToast(`静态页构建失败：\n${e.message}\n${(e.payload?.issues || []).filter(x=>x.severity==='error').map(x=>'• '+x.message).join('\n')}`, true); }
  };
}

function dateText(date) {
  if (!date) return '年代不详';
  const inferred = date.inferred ? '<span class="pill inferred">推测</span>' : '';
  return `${esc(date.text || date.iso || '年代不详')} <span class="pill">${esc(date.precision || 'unknown')}</span>${inferred}`;
}

function sourceRefsHtml(refs = []) {
  if (!refs.length) return '<div class="source">无出处</div>';
  return '<div class="source">出处：' + refs.map((r) => {
    const s = by('sources', r.sourceId);
    const fixed = r.sourceVersion ? `@v${r.sourceVersion}` : '';
    return `<span class="pill">${esc(s?.title || r.sourceId)}${fixed}</span>${r.note ? esc(` ${r.note}`) : ''}`;
  }).join('；') + '</div>';
}

function subjectName(id) {
  const s = by('subjects', id);
  return s ? `${s.name}${s.status === 'merged' ? '（已并入）' : ''}` : id;
}
function placeName(id) { const p = by('places', id); return p ? (p.historicalName || p.displayName || p.id) : (id || ''); }
function personName(id) { return by('persons', id)?.name || id; }

function sortDate(items) {
  return items.sort((a, b) => {
    const ai = a.iso || '9999';
    const bi = b.iso || '9999';
    return ai === bi ? a.text.localeCompare(b.text, 'zh-CN') : ai.localeCompare(bi);
  });
}

function renderTimeline() {
  const items = [];
  for (const s of vals('statements')) {
    if (s.status === 'retracted' || !s.property.startsWith('founded')) continue;
    const d = s.value?.date;
    if (s.property === 'foundedAt') items.push({ kind: '创立说', subjectId: s.subjectId, date: d, html: `<strong>${esc(subjectName(s.subjectId))}</strong>：${esc(s.valueText)} ${s.status === 'inferred' ? '<span class="pill inferred">推测日期</span>' : ''} ${s.supersedesStatementId ? '<span class="pill confirmed">已确证</span>' : ''}${sourceRefsHtml(s.sourceRefs)}` });
  }
  for (const e of vals('events')) {
    if (e.type !== 'relocation') continue;
    items.push({ kind: '迁址', subjectId: e.subjectId, date: e.date, html: `<strong>${esc(subjectName(e.subjectId))}</strong>：${esc(placeName(e.fromPlaceId))} → ${esc(placeName(e.toPlaceId))}<div class="tl-meta">${esc(e.note || '迁址事件')}</div><div class="source">出处：${e.sourceIds.map(id => `<span class="pill">${esc(by('sources', id)?.title || id)}</span>`).join('')}</div>` });
  }
  sortDate(items);
  $('#timeline').innerHTML = items.map((x) => `<div class="tl-item"><div class="tl-date">${dateText(x.date)}</div><div>${x.html}</div></div>`).join('');
}

// Simple normalized Xi'an city-centre projection. Historical coordinates are
// deliberately kept approximate or missing; this is a schematic map, not a
// gazetteer authority.
function project(coords) {
  const lat0 = 34.264, lng0 = 108.932, scale = 15000;
  const x = (coords.lng - lng0) * 111320 * Math.cos(lat0 * Math.PI / 180) / 38;
  const y = -(coords.lat - lat0) * 110540 / 38;
  return [360 + x, 280 + y];
}

function renderMap() {
  const places = vals('places');
  const located = places.filter((p) => p.coords);
  const events = vals('events').filter((e) => e.type === 'relocation' && e.fromPlaceId && e.toPlaceId);
  const lines = events.map((e) => {
    const a = by('places', e.fromPlaceId), b = by('places', e.toPlaceId);
    if (!a?.coords || !b?.coords) return '';
    const [x1, y1] = project(a.coords); const [x2, y2] = project(b.coords);
    return `<line class="map-line" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><title>${esc(subjectName(e.subjectId))}迁址</title></line>`;
  }).join('');
  const points = located.map((p, i) => {
    const [x, y] = project(p.coords);
    return `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)})"><circle r="8" fill="#7b2d26" stroke="#f7e2ad" stroke-width="2"><title>${esc(p.historicalName)}｜${esc(p.precision)}</title></circle><text class="map-label" x="12" y="2">${esc(p.historicalName)}</text><text class="map-sub" x="12" y="18">${esc(p.displayName || '')} · ${esc(p.precision)}</text></g>`;
  }).join('');
  $('#map').innerHTML = `<div class="map-wrap"><svg class="map" viewBox="0 0 720 560" role="img" aria-label="西安历史商号位置示意图">
    <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#7b2d26"/></marker></defs>
    <rect width="720" height="560" fill="#f4ead8"/>
    <path d="M70 380 C210 320,330 330,640 250" stroke="#c9b48e" stroke-width="18" fill="none" opacity=".45"/>
    <path d="M120 90 C230 200,390 240,610 420" stroke="#c9b48e" stroke-width="12" fill="none" opacity=".35"/>
    <text x="30" y="38" fill="#7a604c">西安城厢历史地点示意图（非精确底图）</text>
    ${lines}${points}
  </svg></div>`;
  const unresolved = places.filter((p) => !p.coords);
  $('#unresolvedPlaces').innerHTML = unresolved.length ? `<h3>缺坐标但保留可读原称（${unresolved.length}）</h3>` + unresolved.map((p) => `<div class="tl-item"><strong>${esc(p.historicalName)}</strong> <span class="pill inferred">${esc(p.precision)}</span><p class="small">${esc(p.note || '')}</p>${(p.candidates || []).map(c => `<div class="small">候选：${esc(c.name)}｜${esc(c.basis || '')}${c.coords ? '｜有候选坐标' : '｜无坐标'}</div>`).join('')}</div>`).join('') : '';
}

function activeSubjects() {
  return vals('subjects').filter(s => s.status === 'active');
}

function renderSubjectList() {
  const q = state.search.trim().toLowerCase();
  const all = activeSubjects();
  const related = new Map();
  if (q) {
    const hit = (text) => String(text || '').toLowerCase().includes(q);
    vals('subjects').forEach(s => { if (hit(s.name) || hit(s.note) || s.aliases.some(hit)) related.set(s.id, s.id); });
    vals('persons').forEach(p => hit(p.name) || hit(p.bio) ? vals('statements').forEach(st => st.value?.personId === p.id && related.set(st.subjectId, st.subjectId)) : null);
    vals('places').forEach(p => hit(p.historicalName) || hit(p.displayName) || hit(p.note) ? vals('periods').forEach(pe => pe.placeId === p.id && related.set(pe.subjectId, pe.subjectId)) : null);
    vals('signs').forEach(s => hit(s.title) || hit(s.inscription) ? related.set(s.subjectId, s.subjectId) : null);
    vals('sources').forEach(src => hit(src.title) || hit(src.note) ? vals('statements').forEach(st => st.sourceRefs.some(r => r.sourceId === src.id) && related.set(st.subjectId, st.subjectId)) : null);
  }
  const list = q ? all.filter(s => related.has(s.id)) : all;
  if (!state.selectedSubject || !list.some(s => s.id === state.selectedSubject)) state.selectedSubject = list[0]?.id || null;
  $('#subjectList').innerHTML = list.map((s) => {
    const promotions = vals('promotions').filter(p => p.subjectId === s.id);
    return `<div class="subject-card ${state.selectedSubject === s.id ? 'active' : ''}" data-id="${s.id}">
      <strong>${esc(s.name)}</strong>
      <div class="small">${esc(s.kind)}</div>
      <div>${s.aliases.map(a => `<span class="pill">${esc(a)}</span>`).join('')}</div>
      ${promotions.map(p => `<span class="pill promo">推广：${esc(p.label)}</span>`).join('')}
    </div>`;
  }).join('') || '<p class="notice">没有匹配的商号。</p>';
  $$('.subject-card').forEach(card => card.onclick = () => { state.selectedSubject = card.dataset.id; renderSubjectList(); renderDetail(); });
  $('#searchHelp').textContent = q ? `搜索使用公开版本 v${state.snapshot.version}，命中 ${list.length} 个商号。` : '同名商号分卡展示；不会因名称相同自动合并。';
}

function renderDetail() {
  const s = by('subjects', state.selectedSubject);
  if (!s) { $('#subjectDetail').innerHTML = ''; return; }
  const periods = vals('periods').filter(p => p.subjectId === s.id);
  const statements = vals('statements').filter(x => x.subjectId === s.id);
  const events = vals('events').filter(e => e.subjectId === s.id);
  const signs = vals('signs').filter(x => x.subjectId === s.id);
  const promotions = vals('promotions').filter(p => p.subjectId === s.id);
  const founded = statements.filter(st => st.property === 'foundedAt');
  const conflict = founded.filter(st => st.status !== 'retracted').length > 1;
  const claimsHtml = founded.map(st => {
    const person = st.value?.personId;
    return `<div class="claim ${conflict && st.status !== 'retracted' ? 'conflict' : ''}">
      <div>${dateText(st.value?.date)} ${st.status === 'inferred' ? '<span class="pill inferred">推测</span>' : ''} ${st.supersedesStatementId ? '<span class="pill confirmed">由推测确证</span>' : ''} ${st.status === 'retracted' ? '<span class="pill retracted">已撤回</span>' : ''}</div>
      <div>${esc(st.valueText)}</div>
      ${sourceRefsHtml(st.sourceRefs)}
    </div>`;
  }).join('');
  const personsHtml = statements.filter(st => st.property === 'founder').map(st => {
    const p = by('persons', st.value.personId);
    const pinned = st.value.personVersion;
    return `<div class="claim"><strong>${esc(p?.name || '')}</strong> <span class="pill">引用人物 v${pinned}</span><p class="small">旧卡固定该版本；人物被修订后由编辑批准新图。</p>${sourceRefsHtml(st.sourceRefs)}</div>`;
  }).join('');
  const periodsHtml = periods.map(p => `<tr><td>${esc(p.name)}</td><td>${dateText(p.start)}</td><td>${p.end ? dateText(p.end) : '未结束/不详'}</td><td>${esc(placeName(p.placeId))}<div class="small">${esc(by('places', p.placeId)?.precision || '')}</div></td><td>${esc(p.note)}</td></tr>`).join('');
  const eventsHtml = events.map(e => `<tr><td>${e.type === 'relocation' ? '迁址' : esc(e.type)}</td><td>${dateText(e.date)}</td><td>${esc(placeName(e.fromPlaceId))} → ${esc(placeName(e.toPlaceId))}</td><td>${esc(e.note)}</td><td>${e.sourceIds.map(id => esc(by('sources', id)?.title || id)).join('、')}</td></tr>`).join('');
  const signsHtml = signs.map(sign => {
    const media = (sign.mediaIds || []).map(id => by('media', id)).filter(Boolean);
    return `<div class="claim"><strong>${esc(sign.title)}</strong>（${esc(sign.periodId ? by('periods', sign.periodId)?.name : '时期未定')}）<div>匾文：${esc(sign.inscription)}</div>
    <div class="media-grid">${media.map(m => m.rightsStatus === 'withdrawn' ? `<div class="media-card"><div class="pill withdrawn">图片已撤权</div><p>${esc(m.title)}</p><p class="small">${esc(m.rightsNote)}</p></div>` : `<div class="media-card"><img src="${esc(m.dataUri || m.externalUrl)}" alt="${esc(m.title)}"><div class="small">${esc(m.title)} v${m.version}</div></div>`).join('')}</div>${sourceRefsHtml(sign.sourceIds.map(id => ({ sourceId: id })))}</div>`;
  }).join('');
  $('#subjectDetail').innerHTML = `<article class="card">
    <div class="detail-head"><h2>${esc(s.name)}</h2><div>${promotions.map(p => `<span class="pill promo">商业推广：${esc(p.label)}</span>`).join('')}</div></div>
    <p>${esc(s.note)}</p>
    <p class="small">别名：${s.aliases.map(esc).join('、') || '无'}</p>
    ${s.status === 'merged' ? `<p class="merged-note">此主体已并入 ${esc(subjectName(s.mergedInto))}；旧卡仍可按原标识追溯。</p>` : ''}
    <h3>创立日期：并列来源${conflict ? ' <span class="pill inferred">来源冲突，不取唯一值</span>' : ''}</h3>
    <div class="claim-list">${claimsHtml || '<p class="small">暂无日期陈述</p>'}</div>
    <h3>创立者与人物引用</h3><div class="claim-list">${personsHtml || '<p class="small">暂无人物陈述</p>'}</div>
    <h3>按时期拆分的旧址记录</h3><table><thead><tr><th>时期</th><th>开始</th><th>结束</th><th>旧址</th><th>说明</th></tr></thead><tbody>${periodsHtml}</tbody></table>
    <h3>事件关系</h3><table><thead><tr><th>类型</th><th>日期/精度</th><th>地点</th><th>说明</th><th>出处</th></tr></thead><tbody>${eventsHtml}</tbody></table>
    <h3>招牌与图片权利</h3><div class="claim-list">${signsHtml || '<p class="small">暂无招牌</p>'}</div>
  </article>`;
}

function renderPublic() { renderTimeline(); renderMap(); renderSubjectList(); renderDetail(); }

function option(list, valueKey = 'id', labelFn = x => x.name || x.title || x.historicalName || x.id) {
  return list.map(x => `<option value="${esc(x[valueKey])}">${esc(labelFn(x))} v${x.version || ''}</option>`).join('');
}
function populateSelects() {
  if (!state.admin) return;
  $$('select[data-collection]').forEach(sel => {
    const name = sel.dataset.collection;
    let list = adminVals(name);
    if (name === 'subjects') list = list.filter(x => x.status === 'active');
    const extra = name === 'periods' ? '<option value="">不绑定时期</option>' : '<option value="">（不选）</option>';
    sel.innerHTML = extra + option(list);
  });
  $('#personReviseForm select[name=id]').innerHTML = option(adminVals('persons'));
  $('#mergeForm select[name=sourceSubjectId]').innerHTML = option(adminVals('persons').length ? adminVals('subjects') : []);
  $('#mergeForm select[name=targetSubjectId]').innerHTML = option(adminVals('subjects'));
  $('#promoForm select[name=subjectId]').innerHTML = option(adminVals('subjects'));
}

function parseList(text, fallbackArray) {
  if (!text?.trim()) return fallbackArray;
  const v = JSON.parse(text);
  return Array.isArray(v) ? v : [v];
}
function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }

async function submitGeneric(form) {
  const path = form.dataset.api;
  const o = formObject(form);
  Object.keys(o).forEach(k => { if (typeof o[k] === 'string') o[k] = o[k].trim(); });
  if (o.aliases) o.aliases = o.aliases.split(/[,，]/).filter(Boolean);
  if (path === '/api/places') {
    o.coords = o.lat && o.lng ? { lat: Number(o.lat), lng: Number(o.lng) } : null;
    if (o.candidates) o.candidates = JSON.parse(o.candidates || '[]');
    delete o.lat; delete o.lng;
  }
  if (path === '/api/periods') {
    o.start = { text: o.startText, iso: o.startIso || null, precision: o.startPrecision, inferred: form.startInferred.checked };
    o.end = o.endText ? { text: o.endText, precision: 'unknown', inferred: true } : null;
    o.placeId = o.placeId || null;
  }
  if (path === '/api/founding-claims') {
    o.date = { text: o.text, iso: o.iso || null, precision: o.precision, inferred: form.inferred.checked };
    o.sourceRefs = JSON.parse(o.sourceRefs);
    o.periodId = o.periodId || null;
  }
  if (path === '/api/statements') {
    o.periodId = o.periodId || null;
    o.sourceRefs = JSON.parse(o.sourceRefs);
    o.value = { personId: o.personId };
  }
  if (path === '/api/relocations') {
    o.date = { text: o.dateText, iso: o.dateIso || null, precision: o.datePrecision, inferred: form.dateInferred.checked };
    o.sourceIds = parseList(o.sourceIds, []);
  }
  if (path === '/api/signs') {
    o.sourceIds = parseList(o.sourceIds, []);
    o.mediaIds = parseList(o.mediaIds, []);
    o.periodId = o.periodId || null;
  }
  await api(path, { method: 'POST', body: o });
  showToast('已保存为待发布编辑数据。需审批发布后公开页才会变更。');
  form.reset();
  await loadAdmin();
}

function renderInferred() {
  const inferred = adminVals('statements').filter(s => s.status === 'inferred' && ['foundedAt', 'eventDate'].includes(s.property));
  $('#inferredList').innerHTML = `<h2>推测日期 → 确证（保留旧陈述）</h2>${inferred.length ? '<table><thead><tr><th>陈述</th><th>当前年代</th><th>确证操作</th></tr></thead><tbody>' + inferred.map(s => `<tr><td>${esc(s.valueText)}</td><td>${esc(s.value.date.text)}</td><td><input data-id="${s.id}" placeholder="确证年代原称"><input data-id="${s.id}" class="src" placeholder='新出处JSON [{"sourceId":"..."}]'><button class="confirm-date" data-id="${s.id}">确证</button></td></tr>`).join('') + '</tbody></table>' : '<p class="small">暂无推测日期。</p>'}`;
  $$('.confirm-date').forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.id;
    const inputs = $$(`input[data-id="${id}"]`);
    try {
      await api(`/api/statements/${id}/confirm-date`, { method: 'POST', body: { date: { text: inputs[0].value, precision: 'year', inferred: false }, sourceRefs: JSON.parse(inputs[1].value) } });
      showToast('旧推测陈述已标记 superseded，新确证陈述并列保存。');
      await loadAdmin();
    } catch (e) { showToast(e.message, true); }
  });
}

function renderMediaRights() {
  const media = adminVals('media');
  $('#mediaRightsList').innerHTML = `<h2>来源图片与撤权</h2><table><thead><tr><th>图片</th><th>权利状态</th><th>操作</th></tr></thead><tbody>${media.map(m => `<tr><td>${esc(m.title)} v${m.version}</td><td>${m.rightsStatus === 'withdrawn' ? '<span class="pill withdrawn">已撤权</span>' : '<span class="pill confirmed">可用</span>'}<div class="small">${esc(m.rightsNote || '')}</div></td><td>${m.rightsStatus === 'active' ? `<input placeholder="撤权原因" data-media="${m.id}"><button class="withdraw-media" data-id="${m.id}">撤销授权</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
  $$('.withdraw-media').forEach(btn => btn.onclick = async () => {
    const reason = $(`[data-media="${btn.dataset.id}"]`).value;
    try { const r = await api(`/api/media/${btn.dataset.id}/withdraw`, { method: 'POST', body: { reason } }); showToast(`已撤权，影响 ${r.result.impact.length} 张卡，等待批准发布。`); await loadAdmin(); }
    catch (e) { showToast(e.message, true); }
  });
}

async function setupForms() {
  $$('form.edit-form[data-api]').forEach(form => form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await submitGeneric(form); } catch (err) { showToast(`${err.message}\n${JSON.stringify(err.payload?.issues || [], null, 2)}`, true); }
  }));
  $('#personReviseForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const o = formObject(e.currentTarget);
    try {
      const r = await api(`/api/persons/${encodeURIComponent(o.id)}`, { method: 'PATCH', body: { version: Number(o.version), name: o.name, bio: o.bio } });
      showToast(`人物修订已生成影响清单 ${r.result.result?.revision?.id || ''}，旧卡保留引用版本。`);
      await loadAdmin();
    } catch (err) { showToast(err.message, true); }
  });
  $('#mergeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const o = formObject(e.currentTarget);
    try { const r = await api('/api/merges', { method: 'POST', body: o }); showToast(`合并完成：迁移 ${r.result.result.merge.changes.length} 条子记录。`); await loadAdmin(); }
    catch (err) { showToast(err.message, true); }
  });
}

function renderMergeList() {
  const merges = adminVals('merges');
  $('#mergeList').innerHTML = merges.map(m => `<div class="claim"><strong>${esc(subjectName(m.sourceSubjectId))} → ${esc(subjectName(m.targetSubjectId))}</strong> <span class="pill ${m.status}">${m.status === 'active' ? '有效' : '已撤销'}</span><div class="small">${new Date(m.createdAt).toLocaleString('zh-CN')}｜迁移 ${m.changes.length} 条</div>${m.status === 'active' ? `<button data-id="${m.id}" class="unmerge">撤销合并并迁回记录</button>` : ''}</div>`).join('') || '<p class="small">暂无合并账本。</p>';
  $$('.unmerge').forEach(b => b.onclick = async () => {
    try { await api(`/api/merges/${b.dataset.id}/unmerge`, { method: 'POST', body: {} }); showToast('合并已撤销，时期、事件、招牌、陈述均按账本迁回。'); await loadAdmin(); }
    catch (e) { showToast(e.message, true); }
  });
}

function renderApproval() {
  if (!state.user?.roles.includes('approver')) {
    $('#approvalPanel').innerHTML = '<p class="notice">只有 approver/admin 可以查看影响清单并批准发布。编辑保存内容不会立刻影响公开版本。</p>';
    return;
  }
  const pending = adminVals('pendingChanges').filter(p => p.status === 'pending');
  const pubs = adminVals('publications');
  $('#approvalPanel').innerHTML = `<h2>待批准影响清单</h2>${pending.length ? '<table><thead><tr><th>变更</th><th>影响</th><th>操作</th></tr></thead><tbody>' + pending.map(p => `<tr><td>${esc(p.summary)}<div class="small">${p.objectType} ${esc(p.objectId)} · ${esc(p.requestedBy)}</div></td><td>${p.impact.map(i => `<span class="pill">${esc(i.statementId || i.signId || i.subjectId || i.reason)}</span>${esc(i.reason)}`).join('<br>') || '无直接引用'}</td><td><button class="approve" data-id="${p.id}">批准并发布新版本</button><button class="reject secondary" data-id="${p.id}">驳回</button></td></tr>`).join('') + '</tbody></table>' : '<p class="small">没有待审批变更。</p>'}
  <h2>发布版本</h2><p><button id="publishAll">校验并发布当前编辑数据</button></p>
  <table><thead><tr><th>版本</th><th>状态</th><th>时间</th><th>说明</th></tr></thead><tbody>${pubs.map(p => `<tr><td>v${p.version}</td><td>${esc(p.status)}</td><td>${new Date(p.updatedAt || p.createdAt).toLocaleString('zh-CN')}</td><td>${esc(p.note || '')}</td></tr>`).join('')}</tbody></table>`;
  $$('.approve').forEach(b => b.onclick = async () => { try { const r = await api(`/api/pending/${b.dataset.id}/approve`, { method: 'POST', body: {} }); showToast(`已发布 v${r.result.publication.version}`); await refreshAll(); } catch (e) { showToast(`${e.message}\n${(e.payload?.issues||[]).map(x=>x.message).join('\n')}`, true); } });
  $$('.reject').forEach(b => b.onclick = async () => {
    const note = prompt('请输入驳回原因');
    if (note === null) return;
    try { await api(`/api/pending/${b.dataset.id}/reject`, { method: 'POST', body: { note } }); showToast('影响清单已驳回，未发布新版本。'); await refreshAll(); }
    catch (e) { showToast(e.message, true); }
  });
  $('#publishAll').onclick = async () => { try { const r = await api('/api/publications', { method: 'POST', body: {} }); showToast(`已发布 v${r.result.result.version}`); await refreshAll(); } catch (e) { showToast(`${e.message}\n${(e.payload?.issues||[]).map(x=>x.message).join('\n')}`, true); } };
}

function renderPromo() {
  if (!state.user) { $('#promoList').innerHTML = '<p class="notice">登录后查看推广授权状态。</p>'; return; }
  const can = state.user.roles.includes('promotion');
  $('#promoForm').style.display = can ? '' : 'none';
  const list = adminVals ? adminVals('promotions') : [];
  $('#promoList').innerHTML = `<table><thead><tr><th>商号</th><th>标识</th><th>状态</th><th>维护者</th></tr></thead><tbody>${list.map(p => `<tr><td>${esc(subjectName(p.subjectId))}</td><td>${esc(p.label)}</td><td>${p.active ? '有效' : '停用'}</td><td>${esc(p.updatedBy)}</td></tr>`).join('')}</tbody></table>`;
}

async function setupPromo() {
  $('#promoForm').addEventListener('submit', async e => {
    e.preventDefault();
    const o = formObject(e.currentTarget);
    try { await api('/api/promotions', { method: 'POST', body: o }); showToast('推广标识已保存，等待发布；故事正文不能覆盖它。'); await loadAdmin(); }
    catch (err) { showToast(err.message, true); }
  });
}

async function refreshAll() {
  await loadPublicSnapshot(true);
  await loadAdmin();
  renderPublic();
}

function setupTabs() {
  $$('#tabs button').forEach(btn => btn.onclick = () => {
    $$('#tabs button').forEach(b => b.classList.remove('active'));
    $$('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'editor' && !state.user) showToast('当前为游客，只能浏览。editor1/editor2 可编辑史料。');
  });
  $('#printBtn').onclick = () => window.print();
  $('#searchInput').addEventListener('input', e => { state.search = e.target.value; renderSubjectList(); renderDetail(); });
  $('#clearSearch').onclick = () => { $('#searchInput').value = ''; state.search = ''; renderSubjectList(); renderDetail(); };
}

(async function init() {
  setupTabs();
  setupForms();
  setupPromo();
  try {
    await loadPublicSnapshot();
    renderPublic();
    await whoami();
    await loadAdmin();
  } catch (err) {
    showToast(`初始化失败：${err.message}`, true);
  }
})();
