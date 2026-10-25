/**
 * GUIDE.JS — 퀘스트 목표 가이드 (캐릭터 위 화살표 + 몬스터 표시)
 * 전역: window.Guide
 *
 * 사용:
 *  - Guide.refresh()  : me.qa / QD 기준으로 목표 몬스터 타입 갱신
 *  - Guide.tick(dt)   : 매 프레임 호출
 *  - Guide.clear()    : 가이드 제거
 */
(function (global) {
  'use strict';

  const state = {
    types: new Set(),       // 잡아야 하는 몬스터 type 집합
    arrows: [],             // 캐릭터 위 방향 화살표 DOM
    rings: new Map(),       // serverId/type key → THREE ring mesh
    lastRefresh: 0,
    maxArrows: 3,
  };

  function getMe() { return global.me; }
  function getE() { return global.E || []; }
  function getQD() { return global.QD || []; }
  function getTHREE() { return global.THREE; }
  function getS() { return global.S; }
  function getC() { return global.C; }
  function getP() { return global.P; }

  function parseQuestTargets() {
    const me = getMe();
    const QD = getQD();
    const types = new Set();
    if (!me || !me.qa) return types;
    for (const id of Object.keys(me.qa)) {
      const x = QD.find(v => v[0] === id);
      if (!x) continue;
      const need = x[3];
      if (typeof need !== 'string') continue;
      // item:xxx 수집 퀘스트는 스킵
      if (need.startsWith('item:') || need === 'any' || /^z\d+$/.test(need)) continue;
      types.add(need);
    }
    return types;
  }

  function ensureArrowEls() {
    while (state.arrows.length < state.maxArrows) {
      const el = document.createElement('div');
      el.className = 'quest-guide-arrow';
      el.style.cssText = [
        'position:fixed',
        'left:0',
        'top:0',
        'width:0',
        'height:0',
        'pointer-events:none',
        'z-index:40',
        'display:none',
        'transform-origin:50% 100%',
        'filter:drop-shadow(0 0 4px #000)',
      ].join(';');
      // CSS 삼각형 (위쪽 화살표 느낌 → 회전으로 방향)
      el.innerHTML = '<div style="width:0;height:0;border-left:10px solid transparent;border-right:10px solid transparent;border-bottom:18px solid #ffe14d;margin:0 auto"></div>'
        + '<div style="width:4px;height:14px;background:#ffe14d;margin:0 auto;border-radius:2px"></div>';
      document.body.appendChild(el);
      state.arrows.push(el);
    }
  }

  function nearestTargets(limit) {
    const me = getMe();
    const E = getE();
    if (!me || !state.types.size) return [];
    const list = [];
    for (const e of E) {
      if (!e || e.dead || !state.types.has(e.type)) continue;
      const d = Math.hypot((e.x || 0) - me.x, (e.z || 0) - me.z);
      list.push({ e, d });
    }
    list.sort((a, b) => a.d - b.d);
    return list.slice(0, limit || state.maxArrows);
  }

  function project(el, x, y, z) {
    const THREE = getTHREE();
    const C = getC();
    if (!THREE || !C || !el) return false;
    const v = new THREE.Vector3(x, y, z).project(C);
    if (v.z > 1) { el.style.display = 'none'; return false; }
    el.style.display = 'block';
    el.style.left = ((v.x * 0.5 + 0.5) * innerWidth) + 'px';
    el.style.top = ((-v.y * 0.5 + 0.5) * innerHeight) + 'px';
    return true;
  }

  function updateArrows() {
    ensureArrowEls();
    const me = getMe();
    const targets = nearestTargets(state.maxArrows);
    for (let i = 0; i < state.arrows.length; i++) {
      const el = state.arrows[i];
      const t = targets[i];
      if (!t || !me) { el.style.display = 'none'; continue; }
      const dx = t.e.x - me.x;
      const dz = t.e.z - me.z;
      // 화면 각도: 카메라 yaw 보정 없이 월드 기준 atan2 → CSS rotate
      // 캐릭터 머리 위에 표시하고, 화살표가 목표 방향으로 기울어지게
      const ang = Math.atan2(dx, dz); // 0 = +Z
      const deg = (ang * 180 / Math.PI);
      // 플레이어 머리 위
      const ok = project(el, me.x, (me.y || 0) + 4.8 + i * 0.35, me.z);
      if (!ok) continue;
      el.style.transform = 'translate(-50%,-100%) rotate(' + deg + 'deg)';
      el.title = (t.e.d && t.e.d.nm) ? t.e.d.nm : t.e.type;
      // 거리에 따라 투명도
      el.style.opacity = String(Math.max(0.45, Math.min(1, 1 - t.d / 200)));
    }
  }

  function updateRings() {
    const THREE = getTHREE();
    const S = getS();
    if (!THREE || !S) return;
    const targets = nearestTargets(8);
    const keep = new Set();
    for (const { e } of targets) {
      const key = e.serverId != null ? 's' + e.serverId : 'l' + e.type + '_' + Math.round(e.x) + '_' + Math.round(e.z);
      keep.add(key);
      let ring = state.rings.get(key);
      if (!ring) {
        const geo = new THREE.RingGeometry(1.1, 1.55, 24);
        const mat = new THREE.MeshBasicMaterial({
          color: 0xffe14d,
          transparent: true,
          opacity: 0.75,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        ring = new THREE.Mesh(geo, mat);
        ring.rotation.x = -Math.PI / 2;
        S.add(ring);
        state.rings.set(key, ring);
      }
      const sc = (e.sc || 1) * 1.2;
      ring.scale.setScalar(sc);
      ring.position.set(e.x, 0.08, e.z);
      ring.material.opacity = 0.55 + Math.sin((global.T || 0) * 6) * 0.2;
      ring.visible = !e.dead;
    }
    for (const [key, ring] of state.rings) {
      if (!keep.has(key)) {
        try { S.remove(ring); ring.geometry.dispose(); ring.material.dispose(); } catch (_) {}
        state.rings.delete(key);
      }
    }
  }

  function refresh() {
    state.types = parseQuestTargets();
    state.lastRefresh = Date.now();
    if (!state.types.size) {
      clearVisuals();
    }
  }

  function clearVisuals() {
    for (const el of state.arrows) el.style.display = 'none';
    const S = getS();
    for (const [, ring] of state.rings) {
      try { if (S) S.remove(ring); ring.geometry.dispose(); ring.material.dispose(); } catch (_) {}
    }
    state.rings.clear();
  }

  function clear() {
    state.types.clear();
    clearVisuals();
  }

  function tick(dt) {
    // 주기적으로 퀘스트 목록 동기화
    if (Date.now() - state.lastRefresh > 1500) refresh();
    if (!state.types.size) {
      clearVisuals();
      return;
    }
    updateArrows();
    updateRings();
  }

  // 스타일
  try {
    const st = document.createElement('style');
    st.textContent = '.quest-guide-arrow{will-change:transform,opacity}';
    document.head.appendChild(st);
  } catch (_) {}

  global.Guide = {
    refresh,
    tick,
    clear,
    getTargets: () => [...state.types],
  };

  // 자동 초기화
  if (document.readyState === 'complete') setTimeout(refresh, 800);
  else global.addEventListener('load', () => setTimeout(refresh, 800));
})(typeof window !== 'undefined' ? window : globalThis);
