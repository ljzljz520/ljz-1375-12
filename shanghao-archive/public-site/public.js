// 公开页：搜索 / 时间轴-地图联动。数据来自同版 assets/data-<hash>.js（打印页亦同）。
(function () {
  const D = window.__DATA__;
  if (!D) { console.error('缺少公开数据'); return; }

  // ---------- 搜索（客户端，索引即公开同版数据） ----------
  const input = document.getElementById('search');
  const box = document.getElementById('search-results');
  if (input && box) {
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { box.hidden = true; box.innerHTML = ''; return; }
      const hits = D.searchIndex.filter((x) => x.text.toLowerCase().includes(q)).slice(0, 30);
      box.hidden = false;
      box.innerHTML = hits.length
        ? hits.map((x) => `<a href="card-${x.id}.html">${x.name}
            <small>[${ {shop:'商号',person:'人物',place:'地点',sign:'招牌'}[x.type] }] ${x.places.join(' / ')}</small>
            ${x.promo ? '<em class="promo-tag">推广</em>' : ''}</a>`).join('')
        : '<a>无匹配（搜索基于当前公开版本）</a>';
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.site-header')) { box.hidden = true; }
    });
  }

  // ---------- 地图 + 时间轴联动（仅卡片页/打印页） ----------
  const mapEl = document.getElementById('map');
  if (mapEl) {
    const cardId = mapEl.dataset.card;
    const card = D.cards[cardId];
    const placeCoord = (placeId) => {
      const p = D.cards[placeId];
      if (!p || !p.resolution || !p.resolution.candidates) return null;
      const c = p.resolution.candidates.find((x) => x.coord && x.coord.lat != null);
      return c ? { coord: c.coord, precision: c.precision, place: p } : null;
    };
    const events = JSON.parse(mapEl.dataset.events || '[]');
    const located = events
      .filter((e) => e.placeId && placeCoord(e.placeId))
      .map((e) => ({ ...e, ...placeCoord(e.placeId) }));

    // 地点卡：把自身候选坐标作为标记（无候选坐标则地图区自然为空/降级）
    if (card.type === 'place' && card.resolution) {
      (card.resolution.candidates || []).forEach((c) => {
        if (c.coord && c.coord.lat != null) {
          located.push({ placeId: card.id, coord: c.coord, precision: c.precision,
            place: card, kind: 'self', certainty: 'confirmed', title: card.name });
        }
      });
    }

    const initMap = () => {
      if (!window.L) {
        mapEl.innerHTML = '<p style="padding:1rem" class="muted">地图组件未加载（离线环境）；时间轴与正文仍可完整阅读。</p>';
        return;
      }
      const map = L.map(mapEl);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        { maxZoom: 18, attribution: '&copy; OpenStreetMap' }).addTo(map);
      const markers = {};
      located.forEach((e, i) => {
        const m = L.circleMarker([e.coord.lat, e.coord.lng], {
          radius: 8, color: e.certainty === 'inferred' ? '#a05a00' : e.certainty === 'disputed' ? '#8a2f2f' : '#3f6b47',
          weight: 2, fillColor: '#fff', fillOpacity: .8
        }).addTo(map);
        m.bindPopup(`<b>${e.place.name}</b><br>${e.title}<br><small>坐标精度：${e.precision || 'unknown'} · ${
          e.certainty === 'inferred' ? '推测' : e.certainty === 'disputed' ? '争议' : '确证'}</small>`);
        markers[e.placeId] = m;
      });
      // 迁址连线
      const seq = located.filter((e) => e.kind === 'move' || e.kind === 'locate');
      for (let i = 1; i < seq.length; i++) {
        L.polyline([[seq[i - 1].coord.lat, seq[i - 1].coord.lng], [seq[i].coord.lat, seq[i].coord.lng]],
          { color: '#8a3b2e', dashArray: '5,5' }).addTo(map);
      }
      if (located.length) map.fitBounds(located.map((e) => [e.coord.lat, e.coord.lng]), { padding: [30, 30] });
      else map.setView([34.26, 108.94], 12);

      // 时间轴点击 -> 地图聚焦
      document.querySelectorAll('.timeline li[data-place]').forEach((li) => {
        li.addEventListener('click', () => {
          const pid = li.dataset.place;
          document.querySelectorAll('.timeline li').forEach((x) => x.classList.remove('tl-active'));
          li.classList.add('tl-active');
          const m = markers[pid];
          if (m) { m.openPopup(); map.setView(m.getLatLng(), Math.max(map.getZoom(), 15)); }
        });
      });
      // 反向：地图标记点击 -> 高亮时间轴
      Object.entries(markers).forEach(([pid, m]) => {
        m.on('click', () => {
          const li = document.querySelector(`.timeline li[data-place="${pid}"]`);
          if (li) {
            document.querySelectorAll('.timeline li').forEach((x) => x.classList.remove('tl-active'));
            li.classList.add('tl-active'); li.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        });
      });
    };
    if (window.L) initMap();
    else {
      const tries = [0];
      const t = setInterval(() => {
        if (window.L) { clearInterval(t); initMap(); }
        else if (++tries[0] > 20) { clearInterval(t); mapEl.innerHTML = '<p style="padding:1rem" class="muted">地图组件未加载（离线环境）；时间轴与正文仍可完整阅读。</p>'; }
      }, 120);
    }
  }
})();
