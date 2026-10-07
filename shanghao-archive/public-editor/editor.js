// 编辑台 SPA：零依赖、原生 DOM。陈述式模型（每条陈述独立出处/年代/确定性）。
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  token: localStorage.getItem('sh-token') || '',
  who: null, cards: [], sources: [], selectedId: null, view: 'cards',
  draft: { statements: [] }
};

const PRED_META = {
  shop: [
    ['foundedOn', '创立日期（原称）', { date: true }],
    ['foundedBy', '创立者（人物卡）', { person: true }],
    ['locatedAt', '所在地点', { place: true, date: true }],
    ['relocatedTo', '迁址事件（to/from/时间）', { move: true }],
    ['usesSign', '使用招牌', { sign: true }],
    ['operatedInPeriod', '经营时期', { period: true }],
    ['sells', '经营内容', { text: true }],
    ['dissolvedOn', '歇业日期（原称）', { date: true }],
    ['aka', '别称', { text: true }],
    ['note', '备注', { text: true }]
  ],
  person: [
    ['bornOn', '生年（原称）', { date: true }], ['diedOn', '卒年（原称）', { date: true }],
    ['aka', '别称', { text: true }], ['note', '备注', { text: true }]
  ],
  place: [
    ['streetNumber', '门牌/街名', { text: true }], ['aka', '别称', { text: true }], ['note', '备注', { text: true }]
  ],
  sign: [
    ['inscribedText', '匾文', { text: true }], ['createdOn', '制成年代（原称）', { date: true }],
    ['aka', '别称', { text: true }], ['note', '备注', { text: true }]
  ]
};
const CERTS = [['inferred', '推测'], ['confirmed', '确证'], ['disputed', '争议']];
const TYPE_LABEL = { shop: '商号', person: '人物', place: '地点', sign: '招牌' };

async function api(path, opts = {}) {
  const res = await fetch('/api/' + path, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', ...(state.token ? { authorization: 'Bearer ' + state.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || ('HTTP ' + res.status));
    e.status = res.status; e.data = data; throw e;
  }
  return data;
}
function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : ''); t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

// ---------- 启动 ----------
$('#token').value = state.token;
$('#token').addEventListener('change', async (e) => {
  state.token = e.target.value;
  localStorage.setItem('sh-token', state.token);
  await refreshSession(); await loadAll(); render();
});
$$('.topbar nav button').forEach((b) => b.addEventListener('click', () => {
  state.view = b.dataset.view;
  $$('.topbar nav button').forEach((x) => x.classList.toggle('active', x === b));
  render();
}));
$('#type-filter').addEventListener('change', renderCardList);
$('#name-filter').addEventListener('input', renderCardList);
$('#new-card').addEventListener('click', newCardDraft);

async function refreshSession() {
  try { state.who = await api('session'); $('#who').textContent = `${state.who.user} · ${state.who.role}`; }
  catch { state.who = null; $('#who').textContent = '未登录'; }
}
const can = (role) => state.who && state.who.role === role;
const canEdit = () => can('editor');

async function loadAll() {
  state.cards = await api('cards').catch(() => []);
  state.sources = await api('sources').catch(() => []);
  try { const imp = await api('impacts'); setImpactCount(imp.pending.length); }
  catch { setImpactCount(0); }
}
function setImpactCount(n) {
  const el = $('#impact-count'); el.hidden = n === 0; el.textContent = n;
}

// ---------- 侧栏 ----------
function renderCardList() {
  const type = $('#type-filter').value;
  const q = $('#name-filter').value.trim();
  const ul = $('#card-list');
  const list = state.cards
    .filter((c) => (!type || c.type === type) && (!q || (c.current.body.name + (c.current.body.aliases || []).join()).includes(q)))
    .sort((a, b) => Number(!!a.mergedInto) - Number(!!b.mergedInto) || a.id.localeCompare(b.id));
  ul.innerHTML = '';
  for (const c of list) {
    const li = document.createElement('li');
    if (c.mergedInto) li.className = 'merged';
    if (c.id === state.selectedId) li.classList.add('active');
    li.innerHTML = `<span class="ctype-tag">${TYPE_LABEL[c.type]}</span>
      <span>${escHtml(c.current.body.name)}</span>
      ${c.promo && c.promo.enabled ? '<span class="ctype-tag" style="border-color:#b98a3e;color:#b98a3e">推广</span>' : ''}
      ${c.mergedInto ? `<span class="muted" style="font-size:.72rem">→${c.mergedInto}</span>` : ''}`;
    li.addEventListener('click', () => { state.selectedId = c.id; render(); });
    ul.appendChild(li);
  }
}

// ---------- 主视图 ----------
function render() {
  renderCardList();
  const main = $('#main');
  main.innerHTML = '';
  if (state.view === 'cards') renderCardsView(main);
  if (state.view === 'sources') renderSourcesView(main);
  if (state.view === 'impacts') renderImpactsView(main);
  if (state.view === 'release') renderReleaseView(main);
}

function renderCardsView(main) {
  if (!state.selectedId) { main.innerHTML = '<div class="empty muted">从左侧选择一张卡片，或新建。</div>'; return; }
  const card = state.cards.find((c) => c.id === state.selectedId);
  if (!card) return;
  const tpl = $('#tpl-card').content.cloneNode(true);
  const root = tpl.querySelector('.card-editor');
  const cur = card.current.body;
  $('.card-title-row h1', tpl).textContent = cur.name;
  $('.merged-flag', tpl).hidden = !card.mergedInto;
  $('.promo-flag', tpl).hidden = !(card.promo && card.promo.enabled);
  $('.ctype', tpl).textContent = TYPE_LABEL[card.type];
  $('.rev-info', tpl).textContent = `修订 ${card.current.revisionId}（r${card.current.rev}） · ${card.current.at.slice(0, 16).replace('T', ' ')} · ${card.current.actor}`;
  $('.f-name', tpl).value = cur.name;
  $('.f-aliases', tpl).value = (cur.aliases || []).join('，');
  $('.f-summary', tpl).value = cur.summary || '';
  if (card.mergedInto) {
    $('.merge-banner', tpl).hidden = false;
    $('.merge-banner', tpl).textContent = `本卡已并入 ${card.mergedInto}（${card.mergedAt || ''}）。可在下方撤销合并；正文编辑已锁定。`;
  }

  // 地点解析
  if (card.type === 'place') {
    const box = $('.place-resolution', tpl); box.hidden = false;
    const r = cur.resolution || { rawName: '', modernName: '', precision: 'unknown', candidates: [] };
    const cand = (r.candidates && r.candidates[0]) || {};
    $('.r-raw', tpl).value = r.rawName || '';
    $('.r-modern', tpl).value = r.modernName || '';
    $('.r-precision', tpl).value = r.precision || 'unknown';
    $('.r-lat', tpl).value = cand.coord && cand.coord.lat != null ? cand.coord.lat : '';
    $('.r-lng', tpl).value = cand.coord && cand.coord.lng != null ? cand.coord.lng : '';
    $('.r-cprec', tpl).value = cand.precision || 'street';
  }

  // 时期（商号）
  if (card.type === 'shop') {
    const box = $('.periods', tpl); box.hidden = false;
    const list = $('.period-list', tpl);
    const periods = card.periods || [];
    list.innerHTML = '';
    periods.forEach((p, i) => addPeriodRow(list, p, i));
    const add = document.createElement('button');
    add.textContent = '＋ 增加时期';
    add.addEventListener('click', () => addPeriodRow(list, { label: '', fromRaw: '', toRaw: '' }, list.children.length));
    list.appendChild(add);
  }

  // 陈述表
  const tbody = $('.stmts tbody', tpl);
  (cur.statements || []).forEach((st) => tbody.appendChild(stmtRow(card, st)));
  $('.add-stmt', tpl).addEventListener('click', () => {
    tbody.appendChild(stmtRow(card, { predicate: PRED_META[card.type][0][0], value: {}, certainty: 'inferred', sourceIds: [] }));
  });

  const readonly = !!card.mergedInto || !canEdit();
  $$('input,textarea,select,button', tpl).forEach((el) => {
    if (el.closest('.promo-admin') || el.classList.contains('unmerge')) return;
    if (readonly && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) el.disabled = true;
    if (readonly && el.classList.contains('save')) el.disabled = true;
    if (readonly && (el.classList.contains('merge') || el.classList.contains('add-stmt'))) el.disabled = true;
  });
  $('.save', tpl).addEventListener('click', () => saveRevision(card, tpl));

  // 合并目标（同类型、非自身、活跃）
  const sel = $('.merge-target', tpl);
  state.cards.filter((x) => x.type === card.type && x.id !== card.id && !x.mergedInto)
    .forEach((x) => {
      const o = document.createElement('option');
      o.value = x.id;
      o.textContent = `${x.current.body.name}（${x.id}，r${x.current.rev}）`;
      sel.appendChild(o);
    });
  $('.merge', tpl).disabled = !!card.mergedInto || !canEdit();
  $('.merge', tpl).addEventListener('click', async () => {
    const mergedId = sel.value;
    if (!mergedId) return;
    const expected = [card.current.revisionId, state.cards.find((x) => x.id === mergedId).current.revisionId];
    if (!confirm(`确认把「${cur.name}」并入「${state.cards.find((x) => x.id === mergedId).current.body.name}」？\n陈述将按值+出处去重迁移，入引用自动改指，可撤销。`)) return;
    try {
      const r = await api(`cards/${card.id}/merge`, { method: 'POST', body: { mergedId, expectedRev: expected } });
      toast(`合并完成：迁移 ${r.report.migratedStatementIds.length} 条陈述，改指 ${r.report.redirects.length} 处引用`);
      await loadAll(); render();
    } catch (e) { toast('合并失败：' + e.message + (e.data && e.data.pending ? '' : ''), true); }
  });
  const unmergeBtn = $('.unmerge', tpl);
  unmergeBtn.disabled = !card.mergedInto || !canEdit();
  unmergeBtn.addEventListener('click', async () => {
    if (!confirm('撤销合并：迁移陈述将退回本卡，改指引用恢复；被继续编辑过的陈述会列入人工核对。继续？')) return;
    try {
      const r = await api(`cards/${card.id}/unmerge`, { method: 'POST', body: {} });
      toast(`已撤销合并，${r.report.reviewNeeded.length} 条需人工核对`);
      await loadAll(); render();
    } catch (e) { toast('撤销失败：' + e.message, true); }
  });
  const reports = [...(card.mergeReport ? [card.mergeReport] : []), ...(card.unmergeReports || [])];
  $('.merge-report', tpl).textContent = reports.length ? JSON.stringify(reports, null, 2) : '（尚无合并/撤销记录）';

  // 修订史
  const rh = $('.rev-history', tpl);
  (card.revisions || []).slice().reverse().forEach((r) => {
    const li = document.createElement('li');
    li.textContent = `${r.revisionId}（r${r.rev}） ${r.at.slice(0, 16).replace('T', ' ')} ${r.actor}：${r.note}`;
    rh.appendChild(li);
  });

  // 推广（独立权限）
  const promoBox = $('.promo-admin', tpl);
  const promoBtn = $('.promo-save', tpl);
  if (card.type !== 'shop') promoBox.remove();
  else {
    $('.promo-enabled', tpl).checked = !!(card.promo && card.promo.enabled);
    $('.promo-note', tpl).value = card.promo ? card.promo.note || '' : '';
    promoBtn.disabled = !can('promo');
    promoBtn.title = can('promo') ? '' : '只有 promo 角色可维护推广标识，编辑无法通过故事正文改动它';
    promoBtn.addEventListener('click', async () => {
      try {
        await api(`cards/${card.id}/promo`, { method: 'PUT',
          body: { enabled: $('.promo-enabled', tpl).checked, note: $('.promo-note', tpl).value } });
        $('.promo-msg', tpl).textContent = '已保存（独立权限）';
        await loadAll(); renderCardList();
      } catch (e) { $('.promo-msg', tpl).textContent = '失败：' + e.message; }
    });
  }

  main.appendChild(tpl);
}

function addPeriodRow(list, p) {
  const row = document.createElement('div');
  row.className = 'period-row';
  row.innerHTML = `<input placeholder="时期名（如：南院门创业期）" value="${escAttr(p.label || '')}">
    <input placeholder="起（原称）" value="${escAttr(p.fromRaw || '')}">
    <input placeholder="止（原称）" value="${escAttr(p.toRaw || '')}">
    <button type="button">删</button>`;
  row.querySelector('button').addEventListener('click', () => row.remove());
  list.appendChild(row);
}

function stmtRow(card, st) {
  const tr = document.createElement('tr');
  tr.className = 'certainty-' + (st.certainty || 'inferred');
  const predSel = document.createElement('select');
  PRED_META[card.type].forEach(([p, label]) => {
    const o = document.createElement('option');
    o.value = p; o.textContent = label; if (p === st.predicate) o.selected = true;
    predSel.appendChild(o);
  });
  const tdPred = document.createElement('td'); tdPred.appendChild(predSel);
  const tdVal = document.createElement('td');
  const tdCert = document.createElement('td');
  const certSel = document.createElement('select');
  CERTS.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === (st.certainty || 'inferred')) o.selected = true; certSel.appendChild(o); });
  tdCert.appendChild(certSel);
  const tdSrc = document.createElement('td');
  const tdDel = document.createElement('td');
  const del = document.createElement('button'); del.className = 'del'; del.textContent = '删';
  tdDel.appendChild(del);

  function drawValue() {
    const [, , meta] = PRED_META[card.type].find(([p]) => p === predSel.value);
    tdVal.innerHTML = '';
    if (meta.date) tdVal.appendChild(dateInput(st.value));
    if (meta.person) tdVal.appendChild(refInput(st.value, 'personId', 'person', '人物'));
    if (meta.place) { tdVal.appendChild(refInput(st.value, 'placeId', 'place', '地点')); tdVal.appendChild(rawInput(st.value, '原称地址')); }
    if (meta.move) {
      tdVal.appendChild(refInput(st.value, 'placeId', 'place', '迁入地点'));
      tdVal.appendChild(refInput(st.value, 'fromPlaceId', 'place', '迁出地点（可空）'));
      tdVal.appendChild(dateInput(st.value));
      tdVal.appendChild(rawInput(st.value, '备注', 'note'));
    }
    if (meta.sign) tdVal.appendChild(refInput(st.value, 'signId', 'sign', '招牌'));
    if (meta.period) {
      ['label', 'text'].forEach(() => {});
      tdVal.appendChild(simpleInput(st.value, 'label', '时期名'));
      tdVal.appendChild(dateInput((st.value.from = st.value.from || {}), 'from.raw', '起'));
      tdVal.appendChild(dateInput((st.value.to = st.value.to || {}), 'to.raw', '止'));
    }
    if (meta.text) tdVal.appendChild(simpleInput(st.value, 'text', '文本'));
  }
  predSel.addEventListener('change', () => { st.predicate = predSel.value; drawValue(); });
  certSel.addEventListener('change', () => { st.certainty = certSel.value; tr.className = 'certainty-' + certSel.value; });
  drawValue();

  // 出处多选
  function drawSources() {
    tdSrc.innerHTML = '<div class="src-chips"></div><select multiple size="3"></select>';
    const chips = $('.src-chips', tdSrc);
    const sel = tdSrc.querySelector('select');
    state.sources.forEach((s) => {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = `${s.id} ${s.title}${s.rights === 'withdrawn' ? '（已撤权）' : ''}`;
      if ((st.sourceIds || []).includes(s.id)) o.selected = true;
      sel.appendChild(o);
    });
    const renderChips = () => {
      chips.innerHTML = (st.sourceIds || []).map((id) => {
        const s = state.sources.find((x) => x.id === id);
        return `<span title="${escAttr(s ? s.citation : '')}">${escHtml(id)}${s && s.rights === 'withdrawn' ? '⚠' : ''}</span>`;
      }).join('');
    };
    sel.addEventListener('change', () => {
      st.sourceIds = [...sel.selectedOptions].map((o) => o.value);
      renderChips();
    });
    renderChips();
  }
  drawSources();
  del.addEventListener('click', () => tr.remove());
  tr.append(tdPred, tdVal, tdCert, tdSrc, tdDel);
  tr._getStatement = () => { st.predicate = predSel.value; st.certainty = certSel.value; return st; };
  return tr;
}
function simpleInput(value, key, ph) {
  const i = document.createElement('input');
  i.placeholder = ph; i.value = value[key] || '';
  i.addEventListener('input', () => { value[key] = i.value; });
  return i;
}
function rawInput(value, ph, key = 'raw') { return simpleInput(value, key, ph); }
function dateInput(value, field = 'raw', ph = '原称年代（如 民国二十三年 / 光绪三十三年 / 一九五二年春）') {
  return simpleInput(value, field, ph);
}
function refInput(value, key, type, label) {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'font-size:.74rem;color:#837768';
  wrap.textContent = label + ' ';
  const sel = document.createElement('select');
  const none = document.createElement('option'); none.value = ''; none.textContent = '—'; sel.appendChild(none);
  state.cards.filter((c) => c.type === type).forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = `${c.current.body.name}（${c.id}）`;
    if (value[key] === c.id) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => { value[key] = sel.value || undefined; });
  wrap.appendChild(sel);
  return wrap;
}

// ---------- 保存修订 ----------
async function saveRevision(card, root) {
  const msg = $('.save-msg', root);
  msg.className = 'save-msg'; msg.textContent = '';
  const statements = $$('.stmts tbody tr', root).map((tr) => tr._getStatement()).map((st) => ({
    predicate: st.predicate, certainty: st.certainty, value: st.value,
    sourceIds: [...new Set(st.sourceIds || [])]
  }));
  const errors = [];
  statements.forEach((st, i) => { if (!st.sourceIds.length) errors.push(`第 ${i + 1} 条陈述缺少出处`); });
  if (errors.length) { msg.textContent = errors.join('；'); msg.classList.add('err'); return; }

  const body = {
    name: $('.f-name', root).value.trim(),
    aliases: $('.f-aliases', root).value.split(/[，,]/).map((x) => x.trim()).filter(Boolean),
    summary: $('.f-summary', root).value.trim(),
    statements
  };
  if (card.type === 'place') {
    const lat = parseFloat($('.r-lat', root).value);
    const lng = parseFloat($('.r-lng', root).value);
    body.resolution = {
      rawName: $('.r-raw', root).value.trim(),
      modernName: $('.r-modern', root).value.trim(),
      precision: $('.r-precision', root).value,
      candidates: [{
        name: $('.r-modern', root).value.trim(),
        coord: Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null,
        precision: $('.r-cprec', root).value
      }]
    };
  }
  if (card.type === 'shop') {
    body.periods = $$('.period-list .period-row', root).map((row) => {
      const ins = $$('input', row);
      return { label: ins[0].value.trim(), fromRaw: ins[1].value.trim(), toRaw: ins[2].value.trim() };
    });
  }
  try {
    // expectedRev 乐观锁：防止最后编辑覆盖
    const saved = await api(`cards/${card.id}/revisions`, {
      method: 'POST',
      body: { ...body, note: '编辑台修订', expectedRev: card.current.revisionId }
    });
    msg.textContent = `已生成新修订 ${saved.current.revisionId}（旧版本保留）`;
    msg.classList.add('ok');
    await loadAll(); render();
  } catch (e) {
    msg.textContent = '保存失败：' + e.message;
    msg.classList.add('err');
    if (e.status === 409) {
      msg.textContent += '（可能他人已保存：请刷新查看，冲突事实应并列新增陈述，而非覆盖）';
    }
  }
}

async function newCardDraft() {
  if (!canEdit()) return toast('只有 editor 可以新建卡片', true);
  const type = prompt('卡片类型：shop / person / place / sign', 'shop');
  if (!TYPE_LABEL[type]) return;
  const name = prompt('名称（同名商号也可以各自独立建卡）');
  if (!name) return;
  try {
    const card = await api('cards', { method: 'POST', body: { type, name, aliases: [], summary: '', statements: [] } });
    state.selectedId = card.id;
    await loadAll(); render();
  } catch (e) { toast('新建失败：' + e.message, true); }
}

// ---------- 出处库 ----------
function renderSourcesView(main) {
  const box = document.createElement('div');
  box.className = 'view-pane';
  box.innerHTML = `<h2>出处库</h2>
    <div class="src-new">
      <h3>登记出处</h3>
      <div class="grid4">
        <label>标题 <input id="s-title"></label>
        <label>类型 <select id="s-kind"><option value="document">文献</option><option value="image">图片</option></select></label>
        <label>作者/机构 <input id="s-author"></label>
        <label>URI（图片相对路径或链接） <input id="s-uri"></label>
        <label>完整引注 <input id="s-citation"></label>
        <label>权利状态 <select id="s-rights"><option value="unknown">unknown</option><option value="licensed">licensed</option></select></label>
      </div>
      <button class="primary" id="s-create">登记出处</button>
    </div>
    <h3>已登记（${state.sources.length}）</h3>
    <div id="s-list"></div>`;
  main.appendChild(box);
  $('#s-create').addEventListener('click', async () => {
    try {
      await api('sources', { method: 'POST', body: {
        title: $('#s-title').value, kind: $('#s-kind').value, author: $('#s-author').value,
        uri: $('#s-uri').value, citation: $('#s-citation').value, rights: $('#s-rights').value
      } });
      await loadAll(); render(); toast('出处已登记');
    } catch (e) { toast('失败：' + e.message, true); }
  });
  const list = $('#s-list', box);
  state.sources.forEach((s) => {
    const div = document.createElement('div');
    div.className = 'src-card' + (s.rights === 'withdrawn' ? ' withdrawn' : '');
    div.innerHTML = `<strong>${escHtml(s.id)} ${escHtml(s.title)}</strong>
      <div class="muted small">${escHtml(s.kind)} · ${escHtml(s.author || '')} · ${escHtml(s.citation || '')}</div>
      ${s.kind === 'image' ? `<div class="small">图片：${s.rights === 'withdrawn' ? '<b>已撤权（公开页剔除画面，保留著录）</b>' : escHtml(s.uri || '')}</div>` : ''}
      <div class="small">权利：${escHtml(s.rights)} ${escHtml(s.rightsNote || '')}</div>`;
    if (canEdit()) {
      const btn = document.createElement('button');
      btn.textContent = s.rights === 'withdrawn' ? '恢复授权' : '撤销图片权利';
      btn.addEventListener('click', async () => {
        const withdrawn = s.rights !== 'withdrawn';
        const note = withdrawn ? prompt('撤权原因（公开页将不展示该图）', '权利方撤回授权') : '恢复授权';
        if (note === null) return;
        await api(`sources/${s.id}/rights`, { method: 'PUT',
          body: { rights: withdrawn ? 'withdrawn' : 'licensed', rightsNote: note } });
        await loadAll(); render(); toast('权利状态已更新（下次发布生效）');
      });
      div.appendChild(btn);
    }
    list.appendChild(div);
  });
}

// ---------- 影响清单 ----------
async function renderImpactsView(main) {
  const box = document.createElement('div');
  box.className = 'view-pane';
  box.innerHTML = `<h2>引用人物修订 · 影响清单</h2>
    <p class="muted small">人物卡被修订后，引用他的商号卡不会静默跟随：编辑须逐条批准“更新到新发布图”或“保留引用版本”，全部处理完才能发布。</p>
    <div id="imp-list">加载中…</div>`;
  main.appendChild(box);
  const list = $('#imp-list', box);
  let pending;
  try { const r = await api('impacts'); pending = r.pending; } catch (e) { list.textContent = '无权查看（需要 editor / approver）'; return; }
  if (!pending.length) { list.innerHTML = '<div class="muted">没有待处理的引用影响。</div>'; return; }
  pending.forEach((it) => {
    const div = document.createElement('div');
    div.className = 'impact-item';
    div.innerHTML = `<div><b>${escHtml(it.cardName)}</b>（${it.cardId}）的「${escHtml(it.predicate)}」引用人物
      <b>${escHtml(it.personName)}</b>：${it.status === 'unpinned' ? '此前未钉版本' : `仍钉在旧修订 ${it.pinnedRev}`}，最新为 ${it.currentRev}</div>`;
    const up = document.createElement('button'); up.className = 'primary'; up.textContent = '批准：更新到新修订';
    const keep = document.createElement('button'); keep.textContent = '保留引用版本（旧卡照旧）';
    up.addEventListener('click', () => decide(it.id, 'update'));
    keep.addEventListener('click', () => decide(it.id, 'keep'));
    div.append(up, keep);
    list.appendChild(div);
  });
  async function decide(impactId, decision) {
    try { await api(`impacts/${encodeURIComponent(impactId)}/decision`, { method: 'POST', body: { decision } });
      await loadAll(); render(); toast('已记录决定');
    } catch (e) { toast('失败：' + e.message, true); }
  }
}

// ---------- 发布 / 构建 ----------
async function renderReleaseView(main) {
  const box = document.createElement('div');
  box.className = 'view-pane';
  box.innerHTML = `<h2>发布与公开站点</h2>
  <div class="release-box">
    <div>
      <h3>新版本</h3>
      <p class="muted small">发布生成不可变快照（打印、搜索、详情、地图共用同一数据版本与哈希）。approver 角色操作。</p>
      <input id="rel-note" placeholder="版本说明" style="width:100%;padding:.4rem;margin:.3rem 0">
      <div class="big-actions">
        <button class="primary" id="btn-publish">① 发布新公开版本</button>
        <button id="btn-build">② 构建静态站点（失败保留旧站）</button>
        <a href="/site/" target="_blank"><button type="button">打开公开站 ↗</button></a>
      </div>
      <div id="rel-msg" class="small"></div>
      <h3>待处理影响</h3>
      <div id="rel-pending"></div>
    </div>
    <div>
      <h3>历史版本</h3>
      <div class="release-list" id="rel-list"></div>
    </div>
  </div>`;
  main.appendChild(box);
  const releases = await api('releases').catch(() => []);
  $('#rel-list', box).innerHTML = releases.map((r) =>
    `<div><code>${r.id}</code> ${r.at.slice(0, 16).replace('T', ' ')} · ${r.actor} · ${r.hash.slice(0, 10)}…<br><span class="muted">${escHtml(r.note || '')}（${r.cardCount} 卡）</span></div>`
  ).reverse().join('') || '<div class="muted">尚无版本</div>';
  const pending = state.who ? await api('impacts').then((r) => r.pending).catch(() => []) : [];
  $('#rel-pending', box).innerHTML = pending.length
    ? `<b style="color:#9b3026">${pending.length} 条引用影响未批准，发布会被阻止。</b><br><a href="#" onclick="document.querySelector('[data-view=impacts]').click();return false">去处理 →</a>`
    : '<span class="muted">无阻塞项。</span>';
  $('#btn-publish', box).addEventListener('click', async () => {
    try {
      const r = await api('releases', { method: 'POST', body: { note: $('#rel-note', box).value } });
      $('#rel-msg', box).innerHTML = `<span style="color:#3f6b47">已发布 ${r.id}，哈希 ${r.hash.slice(0, 16)}…</span>`;
      await loadAll(); render();
    } catch (e) {
      $('#rel-msg', box).innerHTML = `<span style="color:#9b3026">发布被拒：${escHtml(e.message)}</span>`;
    }
  });
  $('#btn-build', box).addEventListener('click', async () => {
    try {
      const r = await api('build', { method: 'POST', body: { persist: true } });
      $('#rel-msg', box).innerHTML = `<span style="color:#3f6b47">构建成功：${r.cards} 张卡，输出 dist/（版本 ${r.releaseId}）</span>`;
    } catch (e) {
      $('#rel-msg', box).innerHTML = `<span style="color:#9b3026">静态页构建失败，旧站保留：${escHtml(e.message)}</span>`;
    }
  });
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escAttr = escHtml;

(async function init() {
  await refreshSession();
  await loadAll();
  render();
})();
