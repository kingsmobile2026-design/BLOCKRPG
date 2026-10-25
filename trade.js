'use strict';
// =====================================================================
//  trade.js — 플레이어 간 거래 (서버 권한)
//  server.js 에서:  const trade = require('./trade')({ ...ctx });
//    trade.handle(m, ws, p, now)  → trade_* 메시지면 처리하고 true 반환
//    trade.onClose(p)             → 접속 종료 시 진행 중인 거래 정리
// =====================================================================

const OPEN_TTL_MS = 45000;       // 요청 후 수락 대기 시간
const ACTIVE_TTL_MS = 180000;    // 거래창 유지 시간

function tradeKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

function cleanOffer(o) {
  if (!o || typeof o !== 'object') return { coin: 0, items: {}, w: [], a: [], runes: [] };
  const coin = Math.max(0, Math.min(1e12, Math.floor(Number(o.coin) || 0)));
  const items = {};
  if (o.items && typeof o.items === 'object') {
    for (const [k, v] of Object.entries(o.items)) {
      if (typeof k !== 'string' || k.length > 24) continue;
      const n = Math.floor(Number(v) || 0);
      if (n > 0 && n <= 9999) items[k] = n;
    }
  }
  const w = Array.isArray(o.w) ? o.w.filter(x => Number.isInteger(x) && x > 0 && x < 80).slice(0, 10) : [];
  const a = Array.isArray(o.a) ? o.a.filter(x => Number.isInteger(x) && x > 0 && x < 80).slice(0, 10) : [];
  const runes = Array.isArray(o.runes) ? o.runes.filter(x => typeof x === 'string' && /^R[a-f0-9]{8}$/.test(x)).slice(0, 10) : [];
  return { coin, items, w, a, runes };
}

// 제안 내용을 실제로 가지고 있는지 검사 (문제가 있으면 에러 문장, 없으면 null)
function hasOffer(p, offer) {
  if ((p.coin | 0) < (offer.coin | 0)) return '코인이 부족합니다.';
  for (const [k, n] of Object.entries(offer.items || {})) {
    if (((p.items || {})[k] | 0) < n) return '재료가 부족합니다: ' + k;
  }
  const ow = Array.isArray(p.ow) ? p.ow : [];
  for (const wi of offer.w || []) {
    if (wi === (p.w | 0)) return '장착 중인 무기는 거래할 수 없습니다.';
    if (!ow.includes(wi)) return '보유하지 않은 무기입니다.';
  }
  const oa = Array.isArray(p.oa) ? p.oa : [];
  for (const ai of offer.a || []) {
    if (ai === (p.a | 0)) return '장착 중인 방어구는 거래할 수 없습니다.';
    if (!oa.includes(ai)) return '보유하지 않은 방어구입니다.';
  }
  const runes = Array.isArray(p.runes) ? p.runes : [];
  const eq = p.runeEq || {};
  for (const rid of offer.runes || []) {
    if (!runes.some(r => r && r.id === rid)) return '보유하지 않은 룬입니다.';
    if (eq.w === rid || eq.a === rid || eq.u === rid) return '장착 중인 룬은 거래할 수 없습니다.';
  }
  return null;
}

// fromP 에서 offer 를 빼서 toP 에게 준다
function applyOffer(fromP, toP, offer) {
  fromP.coin = (fromP.coin | 0) - (offer.coin | 0);
  toP.coin = (toP.coin | 0) + (offer.coin | 0);
  if (!fromP.items) fromP.items = {};
  if (!toP.items) toP.items = {};
  for (const [k, n] of Object.entries(offer.items || {})) {
    fromP.items[k] = (fromP.items[k] | 0) - n;
    if (fromP.items[k] <= 0) delete fromP.items[k];
    toP.items[k] = (toP.items[k] | 0) + n;
  }
  if (!Array.isArray(fromP.ow)) fromP.ow = [0];
  if (!Array.isArray(toP.ow)) toP.ow = [0];
  for (const wi of offer.w || []) {
    fromP.ow = fromP.ow.filter(x => x !== wi);
    if (!toP.ow.includes(wi)) toP.ow.push(wi);
  }
  if (!Array.isArray(fromP.oa)) fromP.oa = [0];
  if (!Array.isArray(toP.oa)) toP.oa = [0];
  for (const ai of offer.a || []) {
    fromP.oa = fromP.oa.filter(x => x !== ai);
    if (!toP.oa.includes(ai)) toP.oa.push(ai);
  }
  if (!Array.isArray(fromP.runes)) fromP.runes = [];
  if (!Array.isArray(toP.runes)) toP.runes = [];
  for (const rid of offer.runes || []) {
    const idx = fromP.runes.findIndex(r => r && r.id === rid);
    if (idx >= 0) {
      const [rn] = fromP.runes.splice(idx, 1);
      if (toP.runes.length < 40) toP.runes.push(rn);
    }
  }
}

function tradeSnapshot(p) {
  return {
    coin: p.coin | 0,
    items: Object.assign({}, p.items || {}),
    ow: (p.ow || []).slice(),
    oa: (p.oa || []).slice(),
    runes: (p.runes || []).map(r => ({ id: r.id, name: r.name, opt: r.opt, val: r.val, slot: r.slot, tier: r.tier })),
    w: p.w | 0, a: p.a | 0
  };
}

/**
 * ctx: {
 *   players,        // Map<id, player>   (실시간 접속자)
 *   wsById,         // Map<id, ws>
 *   getDb,          // () => db          (MongoDB 에서 불러온 메모리 DB)
 *   ensurePlayer,   // (userKey) => 저장 데이터의 player 객체
 *   sendTo,         // (id, obj) => void
 *   msgTo,          // (id, text) => void
 *   persistSoon,    // () => void        (MongoDB 에 저장 예약)
 *   inSafe          // (x, z) => boolean (안전지대 여부)
 * }
 */
module.exports = function createTrade(ctx) {
  const { players, wsById, getDb, ensurePlayer, sendTo, msgTo, persistSoon, inSafe } = ctx;
  const trades = new Map(); // "idA|idB" -> { a, b, offerA, offerB, readyA, readyB, t, stage }


  // ---- 안전지대 검사: 거래는 양쪽 모두 안전지대에 있어야 가능 (거리 제한 없음) ----
  const isSafe = q => !!q && inSafe(Number(q.x) || 0, Number(q.z) || 0);
  // me 입장에서의 안내 문구 (통과하면 null)
  function safeMsg(me, other) {
    const a = isSafe(me), b = isSafe(other);
    if (a && b) return null;
    if (!a && !b) return '안전지대에 본인과 ' + other.name + ' 님이 있어야 합니다.';
    if (!a) return '안전지대에 본인이 있어야 합니다.';
    return '안전지대에 ' + other.name + ' 님이 있어야 합니다.';
  }

  function findTradeOf(id) {
    for (const tr of trades.values()) {
      if (tr.a === id) return { tr, side: 'A' };
      if (tr.b === id) return { tr, side: 'B' };
    }
    return null;
  }
  function endTrade(tr, reason) {
    trades.delete(tradeKey(tr.a, tr.b));
    sendTo(tr.a, { type: 'trade_end', reason });
    sendTo(tr.b, { type: 'trade_end', reason });
  }
  function isExpired(tr, now) {
    return now - tr.t > (tr.stage === 'open' ? OPEN_TTL_MS : ACTIVE_TTL_MS);
  }
  function pushUpdate(tr) {
    const msg = { type: 'trade_update', offerA: tr.offerA, offerB: tr.offerB, readyA: tr.readyA, readyB: tr.readyB };
    sendTo(tr.a, msg);
    sendTo(tr.b, msg);
  }

  // ---- 거래 요청 ----
  function onReq(m, ws, p, now) {
    if (typeof m.to !== 'string') return;
    if (now - (ws._trT || 0) < 1500) return; ws._trT = now;
    const tp = players.get(m.to);
    if (!tp || tp.id === p.id) return msgTo(p.id, '거래할 수 없는 대상이에요.');
    const sm = safeMsg(p, tp);
    if (sm) return msgTo(p.id, sm);
    const k = tradeKey(p.id, tp.id);
    if (trades.has(k)) return msgTo(p.id, '이미 진행 중인 거래가 있어요.');
    trades.set(k, { a: p.id, b: tp.id, offerA: cleanOffer(null), offerB: cleanOffer(null), readyA: 0, readyB: 0, t: now, stage: 'open' });
    sendTo(tp.id, { type: 'trade_invited', from: { id: p.id, name: p.name, lv: p.lv || 1 }, ttl: OPEN_TTL_MS / 1000 });
    msgTo(p.id, tp.name + ' 님에게 거래를 요청했어요.');
  }

  // ---- 요청 수락/거절 (요청을 받은 사람만 가능) ----
  function onReply(m, ws, p, now) {
    const fromId = typeof m.from === 'string' ? m.from : '';
    const k = tradeKey(p.id, fromId);
    const tr = trades.get(k);
    if (!tr || tr.stage !== 'open' || tr.b !== p.id || tr.a !== fromId) return;
    if (!m.ok) {
      trades.delete(k);
      sendTo(fromId, { type: 'trade_end', reason: '거절됨' });
      msgTo(fromId, p.name + ' 님이 거래를 거절했어요.');
      return;
    }
    const pa = players.get(tr.a), pb = players.get(tr.b);
    if (!pa || !pb) { trades.delete(k); return; }
    const sm = safeMsg(p, p.id === pa.id ? pb : pa);
    if (sm) { trades.delete(k); sendTo(fromId, { type: 'trade_end', reason: '안전지대가 아님' }); return msgTo(p.id, sm); }
    tr.stage = 'active'; tr.t = now;
    sendTo(tr.a, { type: 'trade_open', with: { id: pb.id, name: pb.name, lv: pb.lv || 1 }, you: 'A' });
    sendTo(tr.b, { type: 'trade_open', with: { id: pa.id, name: pa.name, lv: pa.lv || 1 }, you: 'B' });
  }

  // ---- 내 제안 수정 ----
  function onOffer(m, ws, p, now) {
    const f = findTradeOf(p.id);
    if (!f || f.tr.stage !== 'active') return;
    const { tr, side } = f;
    if (isExpired(tr, now)) return endTrade(tr, '시간 초과');
    if (!ws._userKey) return;
    const offer = cleanOffer(m.offer);
    const err = hasOffer(ensurePlayer(ws._userKey), offer);
    if (err) { try { ws.send(JSON.stringify({ type: 'trade_err', error: err })); } catch {} return; }
    if (side === 'A') tr.offerA = offer; else tr.offerB = offer;
    tr.readyA = 0; tr.readyB = 0;
    pushUpdate(tr);
  }

  // ---- 준비 완료 / 거래 실행 ----
  function onReady(m, ws, p, now) {
    const f = findTradeOf(p.id);
    if (!f || f.tr.stage !== 'active') return;
    const { tr, side } = f;
    if (isExpired(tr, now)) return endTrade(tr, '시간 초과');
    if (side === 'A') tr.readyA = m.ok ? 1 : 0; else tr.readyB = m.ok ? 1 : 0;
    pushUpdate(tr);
    if (!(tr.readyA && tr.readyB)) return;

    const userA = (wsById.get(tr.a) || {})._userKey;
    const userB = (wsById.get(tr.b) || {})._userKey;
    if (!userA || !userB) return endTrade(tr, '오류');

    const pa = players.get(tr.a), pb = players.get(tr.b);
    const smA = safeMsg(pa, pb), smB = safeMsg(pb, pa);
    if (smA || smB) {
      sendTo(tr.a, { type: 'trade_err', error: smA || smB });
      sendTo(tr.b, { type: 'trade_err', error: smB || smA });
      tr.readyA = 0; tr.readyB = 0;
      pushUpdate(tr);
      return;
    }
    const A = ensurePlayer(userA), B = ensurePlayer(userB);
    const err = hasOffer(A, tr.offerA) || hasOffer(B, tr.offerB);
    if (err) {
      sendTo(tr.a, { type: 'trade_err', error: err });
      sendTo(tr.b, { type: 'trade_err', error: err });
      tr.readyA = 0; tr.readyB = 0;
      pushUpdate(tr);
      return;
    }
    applyOffer(A, B, tr.offerA);
    applyOffer(B, A, tr.offerB);
    const db = getDb();
    db.states[userA].savedAt = Date.now();
    db.states[userB].savedAt = Date.now();
    persistSoon();   // MongoDB 저장 예약
    trades.delete(tradeKey(tr.a, tr.b));
    sendTo(tr.a, { type: 'trade_done', you: tradeSnapshot(A) });
    sendTo(tr.b, { type: 'trade_done', you: tradeSnapshot(B) });
    msgTo(tr.a, '거래가 완료되었습니다!');
    msgTo(tr.b, '거래가 완료되었습니다!');
  }

  function onCancel(m, ws, p) {
    const f = findTradeOf(p.id);
    if (f) endTrade(f.tr, '취소됨');
  }

  // ---- server.js 의 ws.on('message') 에서 호출 ----
  function handle(m, ws, p, now) {
    switch (m.type) {
      case 'trade_req':    onReq(m, ws, p, now); return true;
      case 'trade_reply':  onReply(m, ws, p, now); return true;
      case 'trade_offer':  onOffer(m, ws, p, now); return true;
      case 'trade_ready':  onReady(m, ws, p, now); return true;
      case 'trade_cancel': onCancel(m, ws, p); return true;
      default: return false;
    }
  }

  // ---- 접속 종료 시 정리 ----
  function onClose(p) {
    for (const tr of [...trades.values()]) {
      if (tr.a !== p.id && tr.b !== p.id) continue;
      trades.delete(tradeKey(tr.a, tr.b));
      sendTo(tr.a === p.id ? tr.b : tr.a, { type: 'trade_end', reason: '상대가 접속을 종료했어요' });
    }
  }

  // ---- 만료된 거래 정리 (수락 안 한 요청이 계속 남아 재요청이 막히는 것 방지) ----
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const tr of [...trades.values()]) if (isExpired(tr, now)) endTrade(tr, '시간 초과');
  }, 10000);
  if (sweeper.unref) sweeper.unref();

  return { handle, onClose, trades };
};
