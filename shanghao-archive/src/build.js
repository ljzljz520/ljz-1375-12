// 公开静态站点构建：从“已发布版本”取数；详情/打印/搜索/地图共用同一 data-<hash>.js。
// 失败时不触碰 dist/（保留上一可用站点）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dateKey } from './domain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escAttr = esc;

function deriveEvents(card, cards) {
  const events = [];
  const refName = (id) => (cards[id] ? cards[id].name : id);
  for (const st of card.statements) {
    const d = st.date;
    const base = { statementId: st.id, certainty: st.certainty, sources: st.sourceIds, date: d };
    if (st.predicate === 'foundedOn') events.push({ ...base, kind: 'found', title: '创立', raw: st.value.raw });
    if (st.predicate === 'createdOn') events.push({ ...base, kind: 'sign-created', title: '招牌制成', raw: st.value.raw });
    if (st.predicate === 'relocatedTo') events.push({
      ...base, kind: 'move', title: `迁址：${refName(st.value.placeId)}`,
      raw: st.value.raw, placeId: st.value.placeId,
      fromPlaceId: st.value.fromPlaceId || null, note: st.value.note || ''
    });
    if (st.predicate === 'locatedAt') events.push({ ...base, kind: 'locate', title: `位于：${refName(st.value.placeId)}`, placeId: st.value.placeId, raw: st.value.raw });
    if (st.predicate === 'dissolvedOn') events.push({ ...base, kind: 'dissolve', title: '歇业', raw: st.value.raw });
  }
  return events.sort((a, b) => dateKey(a.date) - dateKey(b.date));
}

function buildSearchIndex(snapshot) {
  const cards = snapshot.cards;
  return Object.values(cards).filter((c) => !c.mergedInto).map((c) => {
    const locs = [];
    for (const st of c.statements) {
      if (st.predicate === 'relocatedTo' || st.predicate === 'locatedAt') {
        const place = cards[st.value.placeId];
        if (place) locs.push(place.name);
      }
    }
    return {
      id: c.id, type: c.type, name: c.name, aliases: c.aliases,
      summary: c.summary, places: [...new Set(locs)],
      text: [c.name, ...(c.aliases || []), c.summary, ...[...new Set(locs)]].join(' '),
      promo: c.promo
    };
  });
}

function headerHtml(meta) {
  return `<header class="site-header">
  <a class="brand" href="index.html">商号史料关系库<span class="brand-sub">公开版</span></a>
  <input id="search" type="search" placeholder="搜索商号 / 人物 / 地点 / 招牌…" aria-label="搜索">
  <div id="search-results" class="search-results" hidden></div>
  <span class="version">版本 ${esc(meta.releaseId)} · ${esc(meta.hash.slice(0, 10))}</span>
</header>`;
}

function pageShell({ title, body, meta, pageId, cardId = '' }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · 商号史料关系库</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
      onerror="this.remove()">
<link rel="stylesheet" href="assets/style.css">
<noscript><style>#map,.timeline-filter{display:none}</style></noscript>
</head>
<body data-page="${pageId}" data-card="${escAttr(cardId)}" data-release="${escAttr(meta.releaseId)}" data-hash="${escAttr(meta.hash)}">
${headerHtml(meta)}
<main>
${body}
</main>
<footer class="site-footer">
  <span>公开数据版本 <code>${esc(meta.releaseId)}</code> · 内容哈希 <code>${esc(meta.hash)}</code></span>
  <span>打印 / 搜索 / 详情与地图均使用同一份版本数据</span>
</footer>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
        onerror="window.__leafletFailed=1"></script>
<script>window.__PUBLIC__={releaseId:${JSON.stringify(meta.releaseId)},hash:${JSON.stringify(meta.hash)},dataFile:${JSON.stringify(meta.dataFile)}};</script>
<script src="${escAttr(meta.dataFile)}"></script>
<script src="assets/public.js"></script>
</body>
</html>`;
}

function timelineHtml(card, cards) {
  const events = deriveEvents(card, cards);
  if (!events.length) return '<p class="muted">暂无年表事件。</p>';
  return `<ol class="timeline">
${events.map((e) => {
  const d = e.date || {};
  const dateText = d.precision === 'unknown' || !d ? '<span class="date-unknown">年代待考</span>'
    : d.precision === 'era' ? `<span>${esc(d.raw)}</span><small>约 ${d.candidateRange ? d.candidateRange.join('–') : '？'}</small>`
    : d.precision === 'year' ? `${d.year}<small>${esc(d.raw)}</small>`
    : `${d.year}-${String(d.month || 1).padStart(2, '0')}${d.day ? '-' + String(d.day).padStart(2, '0') : ''}<small>${esc(d.raw)}</small>`;
  const certainty = { inferred: '推', confirmed: '证', disputed: '异' }[e.certainty] || '';
  return `<li class="tl-${e.kind} certainty-${e.certainty}" data-statement="${escAttr(e.statementId)}"
      ${e.placeId ? `data-place="${escAttr(e.placeId)}"` : ''}>
    <div class="tl-date">${dateText}<em class="badge" title="确定性">${certainty}</em></div>
    <div class="tl-body">${e.title}${e.note ? ` <small>${esc(e.note)}</small>` : ''}</div>
  </li>`;
}).join('\n')}
</ol>`;
}

function statementsHtml(card, cards, sources) {
  const groups = {};
  for (const st of card.statements) {
    (groups[st.predicate] = groups[st.predicate] || []).push(st);
  }
  const label = { foundedOn: '创立', dissolvedOn: '歇业', relocatedTo: '迁址', locatedAt: '所在',
    usesSign: '招牌', operatedInPeriod: '经营时期', ownedBy: '东家', aka: '别称', sells: '经营',
    bornOn: '生年', diedOn: '卒年', createdOn: '制成', inscribedText: '匾文', note: '备注',
    streetNumber: '门牌' };
  return Object.entries(groups).map(([pred, list]) => `<section class="stmt-group">
  <h3>${esc(label[pred] || pred)}</h3>
  ${list.map((st) => statementHtml(st, cards, sources)).join('')}
</section>`).join('');
}

function statementHtml(st, cards, sources) {
  // 并列来源：冲突的创立日期绝不合并成唯一事实
  const date = st.date;
  let valueHtml = '';
  if (date && st.value.raw != null) {
    const dtxt = date.precision === 'unknown' ? '年代待考' :
      date.precision === 'era' ? `${esc(date.raw)}（候选 ${date.candidateRange ? date.candidateRange.join('–') : '?'}）` :
      date.precision === 'year' ? `${date.year} 年` : `${date.year}-${date.month}${date.day ? '-' + date.day : ''}`;
    valueHtml = `<strong>${esc(st.value.raw)}</strong> <small>≈ ${dtxt} · 精度 ${date.precision}</small>`;
  } else if (st.predicate === 'inscribedText') {
    valueHtml = `「${esc(st.value.text || st.value.raw || '')}」`;
  } else if (st.value.placeId) {
    const p = cards[st.value.placeId];
    valueHtml = `地点：${p ? esc(p.name) : esc(st.value.placeId)}${st.value.note ? `（${esc(st.value.note)}）` : ''}`;
  } else if (st.value.personId) {
    const p = cards[st.value.personId];
    valueHtml = `人物：${p ? esc(p.name) : esc(st.value.personId)}`;
  } else if (st.value.signId) {
    const p = cards[st.value.signId];
    valueHtml = `招牌：${p ? esc(p.name) : esc(st.value.signId)}`;
  } else {
    valueHtml = esc(JSON.stringify(st.value));
  }
  const certLabel = { inferred: '推测', confirmed: '确证', disputed: '争议' }[st.certainty] || st.certainty;
  const srcs = st.sourceIds.map((sid) => {
    const s = sources[sid];
    if (!s) return `<span class="src src-missing">出处 ${esc(sid)} 缺失</span>`;
    if (s.rightsWithdrawn) return `<span class="src src-withdrawn" title="${escAttr(s.rightsNote)}">${esc(s.title)}（图片已撤权）</span>`;
    return `<span class="src" title="${escAttr(s.citation || '')}">${esc(s.title)}</span>`;
  }).join(' ');
  const refTags = (st.refs || []).map((r) => {
    const t = cards[r.cardId];
    return `<a class="reftag" href="card-${escAttr(r.cardId)}.html">${t ? esc(t.name) : esc(r.cardId)}</a>`;
  }).join(' ');
  return `<article class="stmt certainty-${st.certainty}" id="st-${escAttr(st.id)}">
  <div class="stmt-value">${valueHtml}</div>
  <div class="stmt-meta"><em class="cert cert-${st.certainty}">${certLabel}</em>
    ${refTags ? `<span class="refs">引用：${refTags}</span>` : ''}
    <span class="sources">出处：${srcs}</span></div>
</article>`;
}

function placesPanelHtml(card, cards) {
  const placeIds = new Set();
  for (const st of card.statements) {
    if ((st.predicate === 'relocatedTo' || st.predicate === 'locatedAt') && st.value.placeId) placeIds.add(st.value.placeId);
  }
  const places = [...placeIds].map((id) => ({ id, place: cards[id] })).filter((x) => x.place);
  if (!places.length) return '';
  return `<section class="places-panel">
  <h3>相关历史地点</h3>
  <ul>${places.map(({ id, place }) => {
    const r = place.statements.find((s) => s.predicate === 'note');
    const reso = place.resolution || null;
    const coord = reso && reso.candidates && reso.candidates.find((c) => c.coord);
    return `<li id="place-${escAttr(id)}" class="${coord ? '' : 'no-coord'}">
      <a href="card-${escAttr(id)}.html"><strong>${esc(place.name)}</strong></a>
      ${reso ? `<small>原称：${esc(reso.rawName || place.name)} · 精度：${esc(reso.precision || 'unknown')}</small>` : ''}
      ${coord ? '' : '<small class="muted">（缺坐标：时间轴可读，地图不标点）</small>'}
    </li>`;
  }).join('')}</ul>
</section>`;
}

function placeResolutionHtml(card) {
  if (card.type !== 'place') return '';
  const r = card.resolution;
  if (!r) return '<section class="places-panel"><h3>地点解析</h3><p class="muted">尚未做历史地点解析。</p></section>';
  const cands = (r.candidates || []).map((c) => {
    const hasCoord = c.coord && c.coord.lat != null;
    return `<li class="${hasCoord ? '' : 'no-coord'}">
      <strong>${esc(c.name)}</strong>
      <small>坐标精度：${esc(c.precision || 'unknown')} ·
        ${hasCoord ? `${c.coord.lat.toFixed(5)}, ${c.coord.lng.toFixed(5)}` : '缺坐标（地图不标点，正文可读）'}</small>
      ${c.note ? `<br><small class="muted">${esc(c.note)}</small>` : ''}
    </li>`;
  }).join('');
  return `<section class="places-panel">
  <h3>历史地点解析</h3>
  <p>原称：<strong>${esc(r.rawName || card.name)}</strong>
     · 今释：${esc(r.modernName || '—')}
     · 解析精度：<em>${esc(r.precision || 'unknown')}</em></p>
  <ul>${cands}</ul>
</section>`;
}

function cardPage(card, cards, sources, meta, forPrint) {
  const events = deriveEvents(card, cards);
  const body = `${card.promo ? '<div class="promo-banner">推广 · 该标识由独立商业推广权限维护</div>' : ''}
<article class="card-detail type-${card.type}">
  <div class="card-head">
    <h1>${esc(card.name)}</h1>
    ${card.aliases && card.aliases.length ? `<p class="aliases">又名：${card.aliases.map(esc).join('、')}</p>` : ''}
    <p class="summary">${esc(card.summary || '')}</p>
  </div>
  ${placeResolutionHtml(card)}
  <div class="card-grid">
    <section class="col-timeline">
      <h2>时间轴</h2>
      ${timelineHtml(card, cards)}
    </section>
    <section class="col-map">
      ${card.type === 'shop' ? `
      <h2>迁址地图</h2>
      <div id="map" data-card="${escAttr(card.id)}"
           data-events="${escAttr(JSON.stringify(events.map((e) => ({
             kind: e.kind, placeId: e.placeId || null, fromPlaceId: e.fromPlaceId || null,
             title: e.title, raw: e.raw, certainty: e.certainty
           }))))}"></div>
      <p class="map-hint muted">仅标注已解析坐标的地点；无坐标的旧址在时间轴与正文保留。</p>
      ` : card.type === 'place' ? `
      <h2>候选位置</h2>
      <div id="map" data-card="${escAttr(card.id)}" data-events="[]"></div>
      <p class="map-hint muted">地点卡直接展示自身候选坐标；缺坐标时此区域降级为文字说明。</p>
      ` : ''}
    </section>
  </div>
  <section><h2>史料陈述（按出处并列，冲突不取最后编辑值）</h2>${statementsHtml(card, cards, sources)}</section>
  ${card.type === 'shop' ? placesPanelHtml(card, cards) : ''}
</article>`;
  return pageShell({ title: card.name, body, meta, pageId: forPrint ? 'print' : 'card', cardId: card.id });
}

function indexPage(cards, sources, meta) {
  const shops = Object.values(cards).filter((c) => c.type === 'shop' && !c.mergedInto);
  const body = `<section class="hero">
  <h1>商号故事卡 · 史料关系库</h1>
  <p class="muted">创立者、旧址、招牌与迁址事件；同名未必同主体，陈述按出处并列，年代保留不确定性。</p>
</section>
<div class="card-grid-list">
${shops.map((c) => `<a class="card-tile ${c.promo ? 'is-promo' : ''}" href="card-${escAttr(c.id)}.html">
  <h2>${esc(c.name)} ${c.promo ? '<em class="promo-tag">推广</em>' : ''}</h2>
  <p>${esc(c.summary || '')}</p>
  <small>${(c.aliases || []).map(esc).join(' · ')}</small>
</a>`).join('')}
</div>`;
  return pageShell({ title: '首页', body, meta, pageId: 'index' });
}

export function runBuild(store, opts = {}) {
  const release = store.currentRelease();
  if (!release) {
    const e = new Error('尚无已发布版本，拒绝构建公开站点（打印/搜索/详情必须来自同一公开数据版本）');
    e.code = 'BUILD_NO_RELEASE'; throw e;
  }
  const snapshot = release.snapshot;
  const meta = { releaseId: release.id, hash: snapshot.hash, dataFile: `assets/data-${snapshot.hash.slice(0, 12)}.js` };
  const stage = path.join(path.dirname(DIST), '.dist-stage');

  // 清理/建暂存目录；成功后原子替换
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'assets'), { recursive: true });
  try {
    const cards = snapshot.cards;
    const sources = snapshot.sources;

    // 构建前再跑一次完整校验（防止发布后数据被手工改坏）
    const probe = store.buildSnapshot();
    if (probe.hash !== snapshot.hash) {
      throw Object.assign(new Error('当前数据与已发布版本不一致，请重新发布后再构建'), { code: 'BUILD_DRIFT' });
    }

    const searchIndex = buildSearchIndex(snapshot);
    const dataJs = `window.__DATA__=${JSON.stringify({
      releaseId: release.id, hash: snapshot.hash, generatedAt: snapshot.generatedAt,
      cards, sources, searchIndex
    })};\n`;
    fs.writeFileSync(path.join(stage, meta.dataFile), dataJs);
    fs.copyFileSync(path.join(ROOT, 'public-site', 'style.css'), path.join(stage, 'assets', 'style.css'));
    fs.copyFileSync(path.join(ROOT, 'public-site', 'public.js'), path.join(stage, 'assets', 'public.js'));

    fs.writeFileSync(path.join(stage, 'index.html'), indexPage(cards, sources, meta));
    for (const c of Object.values(cards)) {
      if (c.mergedInto) continue;
      fs.writeFileSync(path.join(stage, `card-${c.id}.html`), cardPage(c, cards, sources, meta, false));
      fs.writeFileSync(path.join(stage, `print-${c.id}.html`), cardPage(c, cards, sources, meta, true));
    }
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({
      releaseId: release.id, hash: snapshot.hash, generatedAt: new Date().toISOString(),
      cards: Object.keys(cards).filter((id) => !cards[id].mergedInto)
    }, null, 2));
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(DIST), '.dist-new'), { recursive: true, force: true });
    // 关键：构建失败不影响现存 dist
    throw Object.assign(e, { buildFailed: true });
  }

  // 原子切换：先把新构建改名到 final 候选，再与旧 dist 交换；任一步失败保留旧站
  fs.rmSync(path.join(path.dirname(DIST), '.dist-new'), { recursive: true, force: true });
  fs.renameSync(stage, path.join(path.dirname(DIST), '.dist-new'));
  const finalNew = path.join(path.dirname(DIST), '.dist-new');
  const backup = path.join(path.dirname(DIST), '.dist-prev');
  if (fs.existsSync(path.join(DIST, 'index.html'))) {
    fs.rmSync(backup, { recursive: true, force: true });
    fs.renameSync(DIST, backup);
    try {
      fs.renameSync(finalNew, DIST);
    } catch (e) {
      // 回滚：恢复旧站
      fs.renameSync(backup, DIST);
      throw e;
    }
    fs.rmSync(backup, { recursive: true, force: true });
  } else {
    fs.mkdirSync(path.dirname(DIST), { recursive: true });
    fs.renameSync(finalNew, DIST);
  }

  return { ok: true, releaseId: release.id, hash: snapshot.hash,
    out: DIST, cards: Object.values(snapshot.cards).filter((c) => !c.mergedInto).length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { store } = await import('./store.js');
  const result = runBuild(store);
  console.log('构建成功:', JSON.stringify(result, null, 2));
}
