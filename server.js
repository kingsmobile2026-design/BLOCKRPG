'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 10000;
const HOST = '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'accounts.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const MAX_PLAYERS = 80;
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean));
fs.mkdirSync(DATA_DIR, {recursive:true});
let db={users:{},states:{}};
try { const parsed=JSON.parse(fs.readFileSync(DB_FILE,'utf8')); if(parsed&&parsed.users&&parsed.states)db=parsed; } catch(e) { if(e.code!=='ENOENT') console.error('Account store could not be read:',e.message); }
function persist(){const tmp=DB_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(db));fs.renameSync(tmp,DB_FILE);}
const appLimiter=rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-7',legacyHeaders:false});
const authLimiter=rateLimit({windowMs:15*60*1000,limit:12,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'로그인/가입 시도가 너무 많습니다. 잠시 후 다시 시도하세요.'}});

const SHOP_W = [null,{name:'철검',cost:80},{name:'강철검',cost:300},{name:'미스릴검',cost:900},{name:'용사검',cost:2500},{name:'마검',cost:7000},{name:'드래곤 슬레이어',cost:18000},{name:'신검',cost:45000},null,null,{name:'도적의 단검',cost:60000},{name:'번개검',cost:150000},{name:'서리 대검',cost:350000},{name:'지옥불 대검',cost:700000},{name:'공허의 낫검',cost:1500000}];
const SHOP_A = [null,{name:'가죽갑옷',cost:80},{name:'사슬갑옷',cost:250},{name:'철갑옷',cost:700},{name:'강철갑옷',cost:1800},{name:'미스릴 갑옷',cost:4500},{name:'용비늘 갑옷',cost:11000},{name:'성기사 갑옷',cost:28000},{name:'암흑왕 갑옷',cost:65000},null,{name:'그림자 갑옷',cost:80000},{name:'독사 가죽 갑옷',cost:200000},{name:'서리 갑옷',cost:450000},{name:'지옥불 갑옷',cost:900000},{name:'공허의 갑옷',cost:1800000}];
const SHOP_P = [{name:'체력 물약',cost:15},{name:'고급 물약',cost:45},{name:'대형 물약',cost:120},{name:'엘릭서',cost:500}];
const QUESTS = {
  s1:{name:'슬라임 사냥',need:5,coin:80,xp:40}, m1:{name:'버섯 소탕',need:6,coin:150,xp:90},
  w1:{name:'늑대 퇴치',need:8,coin:300,xp:180}, b1:{name:'불곰 사냥',need:5,coin:550,xp:350},
  g1:{name:'고블린 소탕',need:10,coin:900,xp:700}, o1:{name:'오크 전사 토벌',need:6,coin:1500,xp:1100},
  k1:{name:'해골 군단',need:10,coin:2400,xp:1800}, h1:{name:'유령 퇴치',need:8,coin:3800,xp:3000},
  l1:{name:'골렘 파괴',need:3,coin:6500,xp:5500}, d1:{name:'용 사냥',need:1,coin:14000,xp:13000}
};

// ===== 서버 권한 몬스터 엔진 (위치 / 체력 / AI / 공격 / 리스폰 / 보상 전부 서버가 결정) =====
// WORLD 는 index.html 의 최종 몬스터 정의(MT), 구역(ZD), 절벽(BK), 보스 위치를 추출한 값입니다.
const WORLD = {"MT":{"slime":{"hp":30,"dmg":6,"xp":12,"g":3,"sp":3.6,"reach":1.8,"rt":8,"sc":1,"n":22,"nm":"슬라임"},"wolf":{"hp":55,"dmg":10,"xp":20,"g":6,"sp":8,"reach":2.2,"rt":8,"sc":1,"n":18,"nm":"늑대"},"goblin":{"hp":135,"dmg":18,"xp":51,"g":16,"sp":5,"reach":2.3,"rt":10,"sc":1.1,"n":14,"nm":"고블린"},"skeleton":{"hp":252,"dmg":30,"xp":88,"g":28,"sp":5.5,"reach":2.4,"rt":12,"sc":1.15,"n":12,"nm":"해골 병사"},"golem":{"hp":1250,"dmg":76,"xp":352,"g":144,"sp":3,"reach":4.4,"rt":30,"sc":2.4,"n":6,"ag":20,"cd":1.8,"nm":"골렘"},"mushroom":{"hp":40,"dmg":8,"xp":16,"g":4,"sp":4,"reach":1.7,"rt":8,"sc":1,"n":14,"nm":"독버섯"},"bear":{"hp":130,"dmg":17,"xp":38,"g":12,"sp":5,"reach":3,"rt":12,"sc":1.5,"n":10,"nm":"불곰"},"orc":{"hp":304,"dmg":33,"xp":104,"g":35,"sp":4.8,"reach":3,"rt":14,"sc":1.4,"n":9,"nm":"오크 전사"},"ghost":{"hp":216,"dmg":39,"xp":128,"g":41,"sp":6,"reach":2.2,"rt":14,"sc":1,"n":9,"nm":"유령"},"dragon":{"hp":100000,"dmg":1000,"xp":40000,"g":30000,"sp":5,"reach":8,"rt":300,"sc":2.8,"n":1,"ag":29.4,"cd":2,"boss":1,"fix":[-150,-2000],"nm":"에인션트 드래곤"},"frostwolf":{"hp":900,"dmg":100,"xp":192,"g":64,"sp":9,"reach":2.4,"rt":10,"sc":1.1,"n":14,"nm":"서리 늑대"},"yeti":{"hp":1950,"dmg":155,"xp":352,"g":128,"sp":5,"reach":3.4,"rt":14,"sc":1.7,"n":9,"nm":"예티"},"scorpion":{"hp":1560,"dmg":180,"xp":416,"g":144,"sp":6,"reach":2.6,"rt":10,"sc":1.2,"n":14,"nm":"거대 전갈"},"mummy":{"hp":3040,"dmg":228,"xp":608,"g":208,"sp":4.5,"reach":2.6,"rt":14,"sc":1.2,"n":10,"nm":"미라"},"toad":{"hp":4760,"dmg":283,"xp":896,"g":304,"sp":5,"reach":2.8,"rt":12,"sc":1.3,"n":14,"nm":"독두꺼비"},"witch":{"hp":3400,"dmg":350,"xp":1120,"g":384,"sp":5,"reach":2.6,"rt":15,"sc":1.15,"n":9,"nm":"늪지 마녀"},"imp":{"hp":7600,"dmg":435,"xp":1440,"g":480,"sp":8.5,"reach":2.4,"rt":10,"sc":0.95,"n":14,"nm":"임프"},"hellhound":{"hp":12800,"dmg":528,"xp":2080,"g":720,"sp":10,"reach":3,"rt":14,"sc":1.3,"n":10,"nm":"지옥견"},"darkknight":{"hp":23400,"dmg":735,"xp":3200,"g":1120,"sp":5.5,"reach":3.2,"rt":18,"sc":1.5,"n":8,"nm":"암흑 기사"},"demonlord":{"hp":500000,"dmg":2000,"xp":200000,"g":120000,"sp":5,"reach":7,"rt":600,"sc":3.2,"n":1,"ag":32.2,"cd":2,"boss":1,"fix":[365,-820],"nm":"마왕"},"kingslime":{"hp":3000,"dmg":35,"xp":500,"g":400,"sp":3.5,"reach":3.8,"rt":60,"sc":3,"n":1,"ag":19.6,"cd":1.6,"boss":1,"fix":[0,-225],"nm":"킹 슬라임"},"wolfalpha":{"hp":9000,"dmg":110,"xp":1800,"g":1200,"sp":9,"reach":4,"rt":90,"sc":2.2,"n":1,"ag":23.8,"cd":1.4,"boss":1,"fix":[-185,-240],"nm":"늑대 대장"},"goblinking":{"hp":25000,"dmg":220,"xp":6000,"g":4000,"sp":5.5,"reach":4.5,"rt":120,"sc":2.4,"n":1,"ag":25.2,"cd":1.6,"boss":1,"fix":[185,-240],"nm":"고블린 왕"},"lich":{"hp":60000,"dmg":450,"xp":15000,"g":12000,"sp":5.5,"reach":5,"rt":180,"sc":2.6,"n":1,"ag":26.6,"cd":1.8,"boss":1,"fix":[495,-770],"nm":"해골 군주"},"boar":{"hp":70,"dmg":12,"xp":24,"g":7,"sp":6.5,"reach":2.3,"rt":8,"sc":1.1,"n":10,"nm":"멧돼지"},"spider":{"hp":150,"dmg":22,"xp":45,"g":14,"sp":7,"reach":2.4,"rt":9,"sc":1.2,"n":10,"nm":"거대 거미"},"goblinshaman":{"hp":330,"dmg":36,"xp":70,"g":24,"sp":4.5,"reach":2.6,"rt":10,"sc":1.1,"n":8,"nm":"고블린 주술사"},"zombie":{"hp":420,"dmg":44,"xp":90,"g":30,"sp":3.5,"reach":2.5,"rt":10,"sc":1.15,"n":9,"nm":"좀비"},"gargoyle":{"hp":1500,"dmg":90,"xp":300,"g":100,"sp":6,"reach":2.8,"rt":14,"sc":1.3,"n":4,"nm":"가고일"},"icegolem":{"hp":3000,"dmg":190,"xp":450,"g":150,"sp":4,"reach":3.6,"rt":14,"sc":2,"n":8,"nm":"얼음 골렘"},"cactus":{"hp":3600,"dmg":230,"xp":600,"g":200,"sp":4,"reach":2.8,"rt":12,"sc":1.3,"n":10,"nm":"선인장 몬스터"},"lizardman":{"hp":6500,"dmg":330,"xp":1000,"g":330,"sp":6,"reach":2.9,"rt":12,"sc":1.3,"n":10,"nm":"리자드맨"},"flamegolem":{"hp":16000,"dmg":560,"xp":1800,"g":600,"sp":4.5,"reach":3.8,"rt":16,"sc":2.1,"n":8,"nm":"화염 골렘"},"wraith":{"hp":30000,"dmg":800,"xp":3000,"g":1000,"sp":7,"reach":2.6,"rt":16,"sc":1.1,"n":8,"nm":"망령"},"bee":{"hp":60,"dmg":14,"xp":22,"g":6,"sp":8.5,"reach":2,"rt":8,"sc":1.2,"n":10,"nm":"거대 벌"},"treant":{"hp":220,"dmg":28,"xp":55,"g":18,"sp":3.5,"reach":3,"rt":10,"sc":1.6,"n":8,"nm":"나무 정령"},"hobgoblin":{"hp":380,"dmg":48,"xp":85,"g":28,"sp":5,"reach":2.7,"rt":10,"sc":1.3,"n":8,"nm":"홍고블린"},"necromancer":{"hp":500,"dmg":55,"xp":120,"g":40,"sp":4.5,"reach":2.6,"rt":12,"sc":1.15,"n":7,"nm":"네크로맨서"},"minotaur":{"hp":1800,"dmg":110,"xp":380,"g":130,"sp":5.5,"reach":3.4,"rt":14,"sc":1.8,"n":4,"nm":"미노타우르스"},"frostmage":{"hp":3300,"dmg":210,"xp":520,"g":170,"sp":4.5,"reach":2.8,"rt":12,"sc":1.2,"n":8,"nm":"얼음 마법사"},"anubis":{"hp":4200,"dmg":260,"xp":700,"g":230,"sp":5.5,"reach":3,"rt":12,"sc":1.3,"n":8,"nm":"아누비스 전사"},"snake":{"hp":7500,"dmg":360,"xp":1150,"g":380,"sp":7,"reach":3.2,"rt":12,"sc":1.4,"n":10,"nm":"거대 뱀"},"pyromancer":{"hp":14000,"dmg":520,"xp":1700,"g":560,"sp":5,"reach":2.8,"rt":14,"sc":1.2,"n":8,"nm":"화염술사"},"vampire":{"hp":33000,"dmg":900,"xp":3400,"g":1100,"sp":7.5,"reach":2.8,"rt":14,"sc":1.2,"n":8,"nm":"흡혈귀"},"frostgiant":{"hp":70000,"dmg":600,"xp":30000,"g":25000,"sp":5,"reach":6,"rt":240,"sc":3,"n":1,"ag":28,"cd":1.8,"boss":1,"fix":[365,-660],"nm":"서리 거인"},"pharaoh":{"hp":90000,"dmg":800,"xp":45000,"g":35000,"sp":5.5,"reach":5.5,"rt":270,"sc":2.6,"n":1,"ag":29,"cd":1.7,"boss":1,"fix":[365,-700],"nm":"파라오"},"hydra":{"hp":130000,"dmg":1100,"xp":70000,"g":55000,"sp":5,"reach":7,"rt":300,"sc":3,"n":1,"ag":30,"cd":2,"boss":1,"fix":[365,-740],"nm":"히드라"},"balrog":{"hp":220000,"dmg":1600,"xp":120000,"g":90000,"sp":5.5,"reach":7,"rt":420,"sc":3.4,"n":1,"ag":31,"cd":2,"boss":1,"fix":[365,-780],"nm":"발록"},"mgoat":{"hp":170,"dmg":21,"xp":44,"g":14,"sp":6.5,"reach":2.4,"rt":9,"sc":1.15,"n":8,"nm":"산양"},"bandit":{"hp":280,"dmg":32,"xp":68,"g":24,"sp":5.2,"reach":2.6,"rt":11,"sc":1.1,"n":8,"nm":"산적"},"worldboss":{"hp":3000000,"dmg":5000,"xp":3000000,"g":1500000,"sp":6.5,"reach":8,"rt":600,"sc":4.5,"n":1,"ag":70,"cd":2.2,"boss":1,"fix":[760,-740],"nm":"월드 보스"}},"ZD":{"village":[[-24,24,-24,24]],"corridor":[[-8,8,-150,-24]],"plains":[[-110,110,-300,-150]],"forest":[[-260,-110,-300,-170]],"camp":[[110,260,-300,-170]],"hill":[[-160,80,-440,-300]],"cavearea":[[-260,-160,-440,-300]],"bentry":[[380,480,-640,-560]],"grave":[[430,560,-840,-640]],"snow":[[300,430,-680,-640]],"desert":[[300,430,-720,-680]],"swamp":[[300,430,-760,-720]],"hell":[[300,430,-800,-760]],"dark":[[300,430,-840,-800]],"centry":[[-220,-80,-1900,-1800]],"golem":[[-300,0,-2060,-1900]],"arena":[[700,820,-780,-660]]},"ZT":{"slime":"plains","mushroom":"plains","boar":"plains","bee":"plains","wolf":"forest","bear":"forest","spider":"forest","treant":"forest","goblin":"camp","orc":"camp","hobgoblin":"camp","goblinshaman":"camp","skeleton":"grave","ghost":"grave","zombie":"grave","necromancer":"grave","wraith":"grave","vampire":"grave","frostwolf":"snow","yeti":"snow","frostmage":"snow","scorpion":"desert","mummy":"desert","cactus":"desert","lizardman":"desert","anubis":"desert","toad":"swamp","witch":"swamp","snake":"swamp","imp":"hell","hellhound":"hell","pyromancer":"hell","darkknight":"dark","golem":"golem","gargoyle":"golem","icegolem":"golem","flamegolem":"golem","minotaur":"golem","mgoat":"hill","bandit":"hill"},"BK":[[-60,-30,-390,-340],[10,40,-420,-380],[428,432,-840,-800],[428,432,-770,-720],[428,432,-690,-640]],"BOSS":{"kingslime":[0,-225],"wolfalpha":[-185,-240],"goblinking":[185,-240],"lich":[495,-770],"frostgiant":[365,-660],"pharaoh":[365,-700],"hydra":[365,-740],"balrog":[365,-780],"demonlord":[365,-820],"dragon":[-150,-2000],"worldboss":[760,-740]}};
const MT = WORLD.MT;
const ZONE_RECTS = WORLD.ZD;
const ZT = WORLD.ZT;
const BK = WORLD.BK;
const BOSS_POS = Object.values(WORLD.BOSS);
const ALLR = Object.values(ZONE_RECTS).flat();
const AOI_RADIUS = 260;          // 이 거리 안의 몬스터 변화만 각 플레이어에게 전송
const VILLAGE_R = 18;            // 마을 반경 (몬스터 진입/공격 불가)

// players / wsById 는 아래 WebSocket 섹션에서 채워집니다 (함수 안에서만 참조하므로 선언 순서 문제 없음)
const monsters = new Map();      // id(number) -> monster
let monsterSeq = 0;

function rnd(a, b) { return a + Math.random() * (b - a); }
function inRect(list, x, z) { for (const r of list) if (x >= r[0] && x <= r[1] && z >= r[2] && z <= r[3]) return true; return false; }
function inW(x, z) { return inRect(ALLR, x, z) && !inRect(BK, x, z); }

function pickPos(type) {
  const d = MT[type];
  if (d.fix) return [d.fix[0], d.fix[1]];
  const rs = ZONE_RECTS[ZT[type]] || ZONE_RECTS.plains;
  let tot = 0; for (const r of rs) tot += (r[1] - r[0]) * (r[3] - r[2]);
  for (let k = 0; k < 30; k++) {
    let a = Math.random() * tot, r = rs[0];
    for (const q of rs) { a -= (q[1] - q[0]) * (q[3] - q[2]); if (a <= 0) { r = q; break; } }
    const x = rnd(r[0] + 5, r[1] - 5), z = rnd(r[2] + 5, r[3] - 5);
    if (!inW(x, z)) continue;
    if (BOSS_POS.some(b => Math.hypot(x - b[0], z - b[1]) < 22)) continue;
    return [x, z];
  }
  const r = rs[0]; return [(r[0] + r[1]) / 2, (r[2] + r[3]) / 2];
}
function spawnMonster(type) {
  const d = MT[type]; if (!d) return null;
  const [x, z] = pickPos(type);
  const id = ++monsterSeq;
  const m = { id, type, x, z, hp: d.hp, mhp: d.hp, dead: false, rt: 0, face: 0, cd: 0, kx: 0, kz: 0,
              home: [x, z], px: x, pz: z, t: Math.random() * 6, ver: 1, atk: 0, dmg: new Map() };
  monsters.set(id, m);
  return m;
}
function respawnMonster(m) {
  const d = MT[m.type];
  const [x, z] = pickPos(m.type);
  m.x = x; m.z = z; m.px = x; m.pz = z; m.home = [x, z];
  m.hp = d.hp; m.mhp = d.hp; m.dead = false; m.rt = 0; m.cd = 0; m.kx = m.kz = 0; m.face = 0;
  m.dmg.clear(); m.ver++;
}
function initMonsters() {
  for (const [type, d] of Object.entries(MT)) for (let i = 0; i < d.n; i++) spawnMonster(type);
  console.log('Server monsters spawned:', monsters.size);
}
initMonsters();

const q2 = v => Math.round(v * 100) / 100;
function monsterFull(m) {
  return { id: m.id, type: m.type, x: q2(m.x), z: q2(m.z), hp: Math.ceil(m.hp), mhp: m.mhp, dead: m.dead ? 1 : 0, face: q2(m.face), hx: q2(m.home[0]), hz: q2(m.home[1]) };
}
function monsterSnapshot() { return [...monsters.values()].map(monsterFull); }

// 플레이어가 몬스터를 타격 (클라이언트가 보고한 피해량 — 거리/빈도/상한을 서버가 검증)
function applyPlayerHit(p, ws, id, dmg, kb) {
  const m = monsters.get(id);
  if (!m || m.dead) return;
  if (!(dmg >= 1)) return;
  if (p.hp <= 0) return;
  const d = MT[m.type];
  const dx = m.x - p.x, dz = m.z - p.z, dist = Math.hypot(dx, dz);
  if (dist > d.reach + d.sc * 1.5 + 30) return;            // 너무 먼 몬스터는 타격 불가
  dmg = Math.max(1, Math.min(MAX_HIT_DMG, Math.floor(dmg)));
  kb = Math.max(0, Math.min(14, Number(kb) || 0));
  m.hp -= dmg;
  m.dmg.set(p.id, (m.dmg.get(p.id) || 0) + dmg);
  if (kb > 0) { const dd = dist || 1; m.kx = dx / dd * kb; m.kz = dz / dd * kb; }
  m.ver++;
  if (m.hp <= 0) {
    m.hp = 0; m.dead = true; m.rt = d.rt; m.kx = m.kz = 0;
    // 보상: 마지막 일격을 가한 사람 + 몬스터 체력의 2% 이상 피해를 준 접속자
    for (const [pid, dm] of m.dmg) {
      if (pid !== p.id && dm < m.mhp * 0.02) continue;
      const w = wsById.get(pid);
      if (w && w.readyState === WebSocket.OPEN) { try { w.send(JSON.stringify({ type: 'kill', id: m.id, mt: m.type })); } catch {} }
    }
    m.dmg.clear();
  }
}
const MAX_HIT_DMG = 500000;

// 몬스터 AI 1틱 (client index.html 의 기존 로직과 동일한 규칙)
function tickMonsters(dt, now) {
  const alive = [];
  for (const p of players.values()) if (p.hp > 0 && Math.hypot(p.x, p.z) > VILLAGE_R) alive.push(p);
  for (const m of monsters.values()) {
    const d = MT[m.type]; if (!d) continue;
    if (m.dead) { m.rt -= dt; if (m.rt <= 0) respawnMonster(m); continue; }
    const ox = m.x, oz = m.z, ohp = m.hp, oface = m.face;
    m.cd -= dt; m.t += dt * 4;
    if (m.kx || m.kz) {
      m.x += m.kx * dt * 5; m.z += m.kz * dt * 5;
      const f = Math.pow(0.86, dt * 60); m.kx *= f; m.kz *= f;
      if (Math.abs(m.kx) + Math.abs(m.kz) < 0.2) m.kx = m.kz = 0;
    }
    const ag = d.ag || (d.boss ? 40 : 15), reach = d.reach * 1.3;
    let tgt = null, td = 1e9, nearAny = 1e9;
    for (const p of alive) {
      const dd = Math.hypot(p.x - m.x, p.z - m.z);
      if (dd < nearAny) nearAny = dd;
      if (dd < ag && dd < td && Math.hypot(m.x, m.z) > 17) { td = dd; tgt = p; }
    }
    if (tgt) {
      const ex = tgt.x - m.x, ez = tgt.z - m.z;
      m.face = Math.atan2(ex, ez);
      if (td > reach) {
        const f = m.type === 'slime' ? 0.5 + Math.abs(Math.sin(m.t)) * 0.9 : 1;
        m.x += ex / td * d.sp * dt * f; m.z += ez / td * d.sp * dt * f;
      } else if (m.cd <= 0 && (tgt.invTill || 0) <= now) {
        m.cd = d.cd || 1.2;
        tgt.invTill = now + 500;
        m.atk = 1;
        const w = wsById.get(tgt.id);
        if (w && w.readyState === WebSocket.OPEN) { try { w.send(JSON.stringify({ type: 'mdmg', id: m.id, dmg: d.dmg, mt: m.type })); } catch {} }
      }
    } else if (!m.kx && !m.kz) {
      // 추적 대상이 없으면 제자리(home)로 복귀하며 회복
      const hx = m.home[0] - m.x, hz = m.home[1] - m.z, hd = Math.hypot(hx, hz);
      if (d.boss) {
        if (nearAny > ag * 1.4) {
          if (hd > 1) { m.x += hx / hd * 12 * dt; m.z += hz / hd * 12 * dt; m.face = Math.atan2(hx, hz); }
          m.hp = Math.min(m.mhp, m.hp + m.mhp * 0.05 * dt);
        }
      } else if (hd > 1.2) {
        const s = Math.min(hd, 13 * dt);
        m.x += hx / hd * s; m.z += hz / hd * s; m.face = Math.atan2(hx, hz);
        m.hp = Math.min(m.mhp, m.hp + m.mhp * 0.2 * dt);
      }
    }
    // 이동 가능 영역(절벽 등) / 마을 진입 방지
    if (!inW(m.x, m.z)) { m.x = m.px; m.z = m.pz; } else { m.px = m.x; m.pz = m.z; }
    const er = Math.hypot(m.x, m.z);
    if (er < VILLAGE_R && er > 0) { m.x *= VILLAGE_R / er; m.z *= VILLAGE_R / er; }
    if (Math.abs(m.x - ox) > 0.005 || Math.abs(m.z - oz) > 0.005 || m.hp !== ohp || m.atk || Math.abs(m.face - oface) > 0.01) m.ver++;
  }
}

// 각 접속자에게 "자기 주변(AOI)에서 바뀐 몬스터"만 전송 (대역폭 절약)
function broadcastMonsters() {
  for (const ws of wss.clients) {
    const p = ws.player;
    if (!p || ws.readyState !== WebSocket.OPEN || !ws._seen || ws.bufferedAmount > 1e6) continue;
    const out = [];
    for (const m of monsters.values()) {
      if (ws._seen.get(m.id) === m.ver) continue;
      if (Math.hypot(m.x - p.x, m.z - p.z) > AOI_RADIUS) continue;
      ws._seen.set(m.id, m.ver);
      out.push([m.id, q2(m.x), q2(m.z), Math.ceil(m.hp), q2(m.face), (m.dead ? 1 : 0) | (m.atk ? 2 : 0)]);
    }
    if (out.length) { try { ws.send(JSON.stringify({ type: 'mon', m: out })); } catch {} }
  }
  for (const m of monsters.values()) m.atk = 0;
}
// ===== /서버 권한 몬스터 엔진 =====

app.use(helmet({
  contentSecurityPolicy:{
    directives:{
      defaultSrc:["'self'"],
      scriptSrc:["'self'","'unsafe-inline'","https://cdnjs.cloudflare.com"],
      // ★ onclick / 인라인 이벤트 핸들러 허용 (이게 없으면 버튼 클릭이 전부 막힘)
      scriptSrcAttr:["'unsafe-inline'"],
      styleSrc:["'self'","'unsafe-inline'"],
      connectSrc:["'self'","ws:","wss:"],
      imgSrc:["'self'","data:"],
      fontSrc:["'self'","data:"],
      objectSrc:["'none'"],
      baseUri:["'self'"],
      frameAncestors:["'none'"],
      upgradeInsecureRequests:null
    }
  },
  crossOriginEmbedderPolicy:false,
  referrerPolicy:{policy:'no-referrer'}
}));
app.use(appLimiter);
app.use(express.json({limit:'32kb',strict:true}));
app.use(express.text({type:'text/plain',limit:'32kb'}));
function safeEqual(a,b){const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);}
function hashPassword(password,salt){return crypto.scryptSync(password,salt,64).toString('hex');}
function validUsername(s){return typeof s==='string'&&/^[A-Za-z0-9_가-힣.-]{3,24}$/.test(s);}
function usernameKey(s){return s.toLocaleLowerCase('en-US');}
function validPassword(s){return typeof s==='string'&&s.length>=8&&s.length<=128;}
function sign(payload){const body=Buffer.from(JSON.stringify(payload)).toString('base64url');const sig=crypto.createHmac('sha256',SESSION_SECRET).update(body).digest('base64url');return body+'.'+sig;}
function unsign(token){if(typeof token!=='string')return null;const [body,sig]=token.split('.');if(!body||!sig)return null;const expected=crypto.createHmac('sha256',SESSION_SECRET).update(body).digest('base64url');if(!safeEqual(sig,expected))return null;try{const p=JSON.parse(Buffer.from(body,'base64url').toString());if(!p.u||!p.exp||p.exp<Date.now())return null;return p;}catch{return null;}}
function cookie(res,token){res.setHeader('Set-Cookie',`rpg_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS/1000)}`);}
function clearCookie(res){res.setHeader('Set-Cookie','rpg_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');}
function userFromReq(req){const cookies=String(req.headers.cookie||'').split(';').map(x=>x.trim());const item=cookies.find(x=>x.startsWith('rpg_session='));if(!item)return null;const payload=unsign(decodeURIComponent(item.slice('rpg_session='.length)));return payload&&db.users[payload.u]?payload.u:null;}
function requireUser(req,res,next){const u=userFromReq(req);if(!u)return res.status(401).json({error:'로그인이 필요합니다.'});req.userKey=u;next();}
function publicName(key){return db.users[key].username;}

// ===== 관리자 계정 시드 (ADMIN) =====
(function seedAdmin(){
  const key = usernameKey('ADMIN');
  if(!db.users[key]){
    const salt = crypto.randomBytes(16).toString('hex');
    const password = 'a20140205';
    db.users[key] = {
      username: 'ADMIN',
      passwordHash: hashPassword(password, salt),
      salt,
      createdAt: Date.now(),
      isAdmin: true,
      banned: false
    };
    db.states[key] = null;
    try { persist(); console.log('Admin account seeded: ADMIN'); } catch(e) {}
  } else {
    db.users[key].isAdmin = true;
    db.users[key].banned = !!db.users[key].banned;
  }
  if(!db.bans) db.bans = {};
})();

function ensurePlayer(key){
  if(!db.states[key] || !db.states[key].player){
    db.states[key]={version:1,player:{x:0,z:8,y:0,hp:100,mhp:100,lv:1,xp:0,nx:30,coin:0,at:0,face:0,inv:0,w:0,a:0,pot:[2,0,0,0],rg:0,ow:[0],oa:[0],qa:{},qd:[],questProgress:{}},camera:{},savedAt:Date.now()};
  }
  const p=db.states[key].player;
  if(!Array.isArray(p.pot)) p.pot=[2,0,0,0];
  while(p.pot.length<4) p.pot.push(0);
  if(!Array.isArray(p.ow)) p.ow=[0];
  if(!Array.isArray(p.oa)) p.oa=[0];
  if(!p.qa || typeof p.qa!=='object') p.qa={};
  if(!Array.isArray(p.qd)) p.qd=[];
  if(!p.questProgress || typeof p.questProgress!=='object') p.questProgress={};
  return p;
}
function cleanState(input){
 if(!input||typeof input!=='object'||Array.isArray(input))return null;
 const p=input.player,c=input.camera;if(!p||typeof p!=='object'||Array.isArray(p))return null;
 const fields=['x','z','y','hp','mhp','lv','xp','nx','coin','at','face','inv','w','a','rg'],player={};
 for(const k of fields){const v=p[k];if(typeof v==='number'&&Number.isFinite(v))player[k]=Math.max(-1000000,Math.min(1000000,v));}
 player.x=Math.max(-1000,Math.min(1000,Number(player.x)||0));player.z=Math.max(-2400,Math.min(400,Number(player.z)||0));
 player.lv=Math.max(1,Math.min(999,Math.floor(Number(player.lv)||1)));player.mhp=Math.max(1,Math.min(100000,Number(player.mhp)||100));player.hp=Math.max(0,Math.min(player.mhp,Number(player.hp)||0));
 player.coin=Math.max(0,Math.min(1e9,Math.floor(Number(player.coin)||0)));player.xp=Math.max(0,Math.min(1e9,Math.floor(Number(player.xp)||0)));
 player.pot=Array.isArray(p.pot)?p.pot.slice(0,8).map(v=>Math.max(0,Math.min(999,Math.floor(Number(v)||0)))):[2,0,0,0];
 if(Array.isArray(p.ow)) player.ow=p.ow.filter(v=>Number.isInteger(v)&&v>=0&&v<40).slice(0,40);
 if(Array.isArray(p.oa)) player.oa=p.oa.filter(v=>Number.isInteger(v)&&v>=0&&v<40).slice(0,40);
 if(p.items && typeof p.items==='object' && !Array.isArray(p.items)){
  const it={};let n=0;
  for(const [k,v] of Object.entries(p.items)){
   if(n>=120) break;
   if(/^[A-Za-z0-9_]{1,24}$/.test(k) && Number.isFinite(Number(v))){it[k]=Math.max(0,Math.min(999999,Math.floor(Number(v))));n++;}
  }
  player.items=it;
 }
 if(p.qa && typeof p.qa==='object') player.qa=p.qa;
 if(Array.isArray(p.qd)) player.qd=p.qd.filter(v=>typeof v==='string').slice(0,100);
 if(p.questProgress && typeof p.questProgress==='object') player.questProgress=p.questProgress;
 const camera={};if(c&&typeof c==='object'){for(const k of ['yaw','pit','dist'])if(Number.isFinite(c[k]))camera[k]=Math.max(-1000,Math.min(1000,c[k]));}
 return {version:1,player,camera,savedAt:Date.now()};
}
app.post('/api/register',authLimiter,(req,res)=>{
 const {username,password}=req.body||{};
 if(!validUsername(username))return res.status(400).json({error:'아이디는 한글/영문/숫자/._- 조합으로 3~24자 입력하세요.'});
 if(!validPassword(password))return res.status(400).json({error:'비밀번호는 8~128자로 입력하세요.'});
 const key=usernameKey(username);
 if(db.users[key])return res.status(409).json({error:'이미 사용 중인 아이디입니다.'});
 const salt=crypto.randomBytes(16).toString('hex');
 db.users[key]={username,passwordHash:hashPassword(password,salt),salt,createdAt:Date.now()};
 db.states[key]=null;persist();
 const token=sign({u:key,exp:Date.now()+SESSION_TTL_MS});cookie(res,token);
 res.status(201).json({user:username,state:null});
});
app.post('/api/login',authLimiter,(req,res)=>{
 const {username,password}=req.body||{};if(typeof username!=='string'||typeof password!=='string')return res.status(400).json({error:'아이디와 비밀번호를 입력하세요.'});
 const key=usernameKey(username),u=db.users[key];
 const salt=u?u.salt:'00000000000000000000000000000000';
 const actual=hashPassword(password,salt),expected=u?u.passwordHash:'0'.repeat(128);
 if(!u||!safeEqual(actual,expected))return res.status(401).json({error:'아이디 또는 비밀번호가 올바르지 않습니다.'});
 if(u.banned||(db.bans&&db.bans[key]))return res.status(403).json({error:'차단된 계정입니다.'});
 cookie(res,sign({u:key,exp:Date.now()+SESSION_TTL_MS}));
 res.json({user:u.username,state:db.states[key]||null,isAdmin:!!u.isAdmin});
});
app.get('/api/me',(req,res)=>{const key=userFromReq(req);if(!key)return res.status(401).json({error:'로그인이 필요합니다.'});const u=db.users[key];if(u.banned||(db.bans&&db.bans[key]))return res.status(403).json({error:'차단된 계정입니다.'});res.json({user:publicName(key),state:db.states[key]||null,isAdmin:!!u.isAdmin});});
app.post('/api/save',requireUser,(req,res)=>{const state=cleanState(req.body&&req.body.state);if(!state)return res.status(400).json({error:'저장 데이터 형식이 올바르지 않습니다.'});db.states[req.userKey]=state;try{persist();res.json({ok:true,savedAt:state.savedAt});}catch(e){console.error('Persist failed',e);res.status(500).json({error:'서버 저장에 실패했습니다.'});}});
app.post('/api/save-beacon',(req,res)=>{const key=userFromReq(req);if(!key)return res.status(401).end();let body=req.body;if(typeof body==='string'){try{body=JSON.parse(body);}catch{return res.status(400).end();}}const state=cleanState(body&&body.state);if(!state)return res.status(400).end();db.states[key]=state;try{persist();res.status(204).end();}catch(e){res.status(500).end();}});
app.post('/api/logout',(req,res)=>{clearCookie(res);res.json({ok:true});});

app.post('/api/buy', requireUser, (req, res) => {
  const body = req.body || {};
  const type = body.type;
  let index = body.index;
  let amount = body.amount == null ? 1 : body.amount;
  if (type !== 'w' && type !== 'a' && type !== 'p') return res.status(400).json({ error: '상품 종류가 올바르지 않습니다.' });
  if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: '상품 번호가 올바르지 않습니다.' });
  if (!Number.isInteger(amount) || amount < 1 || amount > 99) return res.status(400).json({ error: '수량이 올바르지 않습니다.' });
  const player = ensurePlayer(req.userKey);
  let cost = 0, name = '';
  if (type === 'p') {
    if (!SHOP_P[index]) return res.status(400).json({ error: '존재하지 않는 물약입니다.' });
    cost = SHOP_P[index].cost * amount; name = SHOP_P[index].name;
  } else if (type === 'w') {
    if (!SHOP_W[index]) return res.status(400).json({ error: '존재하지 않는 무기입니다.' });
    if (player.ow.includes(index)) return res.status(400).json({ error: '이미 보유한 무기입니다.' });
    cost = SHOP_W[index].cost; name = SHOP_W[index].name; amount = 1;
  } else {
    if (!SHOP_A[index]) return res.status(400).json({ error: '존재하지 않는 방어구입니다.' });
    if (player.oa.includes(index)) return res.status(400).json({ error: '이미 보유한 방어구입니다.' });
    cost = SHOP_A[index].cost; name = SHOP_A[index].name; amount = 1;
  }
  if ((player.coin || 0) < cost) return res.status(400).json({ error: '코인이 부족합니다.', need: cost, have: player.coin || 0 });
  player.coin -= cost;
  if (type === 'p') player.pot[index] = (player.pot[index] || 0) + amount;
  else if (type === 'w') { if (!player.ow.includes(index)) player.ow.push(index); player.w = index; }
  else { if (!player.oa.includes(index)) player.oa.push(index); player.a = index; }
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); res.json({ ok:true, type, index, amount, name, coin:player.coin, pot:player.pot, w:player.w, a:player.a, ow:player.ow, oa:player.oa }); }
  catch(e){ res.status(500).json({ error:'저장 실패' }); }
});

app.post('/api/quest/accept', requireUser, (req, res) => {
  const { questId } = req.body || {};
  if (typeof questId !== 'string' || !/^[A-Za-z0-9_-]{1,24}$/.test(questId)) return res.status(400).json({ error: '존재하지 않는 퀘스트입니다.' });
  const player = ensurePlayer(req.userKey);
  if (player.qd.includes(questId)) return res.status(400).json({ error: '이미 완료한 퀘스트입니다.' });
  if (player.qa[questId] !== undefined) return res.status(400).json({ error: '이미 수락한 퀘스트입니다.' });
  if (Object.keys(player.qa).length >= 5) return res.status(400).json({ error: '퀘스트는 동시에 5개까지 받을 수 있습니다.' });
  player.qa[questId] = 0; player.questProgress[questId] = 0;
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); res.json({ ok:true, questId, qa:player.qa }); } catch(e){ res.status(500).json({ error:'저장 실패' }); }
});
app.post('/api/quest/progress', requireUser, (req, res) => {
  const { questId, progress } = req.body || {};
  if (typeof questId !== 'string' || !/^[A-Za-z0-9_-]{1,24}$/.test(questId)) return res.status(400).json({ error: '존재하지 않는 퀘스트입니다.' });
  if (!Number.isInteger(progress) || progress < 0 || progress > 100000) return res.status(400).json({ error: '진행도가 올바르지 않습니다.' });
  const player = ensurePlayer(req.userKey);
  if (player.qa[questId] === undefined) return res.status(400).json({ error: '수락하지 않은 퀘스트입니다.' });
  const need = (QUESTS[questId] && QUESTS[questId].need) || 100000;
  const cur = player.questProgress[questId] || 0;
  const next = Math.max(cur, Math.min(progress, need));
  player.questProgress[questId] = next; player.qa[questId] = next;
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); res.json({ ok:true, questId, progress:next }); } catch(e){ res.status(500).json({ error:'저장 실패' }); }
});
app.post('/api/quest/complete', requireUser, (req, res) => {
  const { questId, rewardCoin, rewardXp, need } = req.body || {};
  if (typeof questId !== 'string' || !/^[A-Za-z0-9_-]{1,24}$/.test(questId)) return res.status(400).json({ error: '존재하지 않는 퀘스트입니다.' });
  const player = ensurePlayer(req.userKey);
  if (player.qa[questId] === undefined) return res.status(400).json({ error: '수락하지 않은 퀘스트입니다.' });
  if (player.qd.includes(questId)) return res.status(400).json({ error: '이미 완료한 퀘스트입니다.' });
  const def = QUESTS[questId];
  const needN = def ? def.need : (Number.isInteger(need) ? Math.min(100000, Math.max(1, need)) : 1);
  const coinR = def ? def.coin : Math.max(0, Math.min(1e7, Math.floor(Number(rewardCoin) || 0)));
  const xpR = def ? def.xp : Math.max(0, Math.min(1e7, Math.floor(Number(rewardXp) || 0)));
  const prog = player.questProgress[questId] || player.qa[questId] || 0;
  if (prog < needN) return res.status(400).json({ error: '아직 퀘스트 조건을 충족하지 않았습니다.', progress: prog, need: needN });
  player.coin = (player.coin || 0) + coinR;
  player.xp = (player.xp || 0) + xpR;
  delete player.qa[questId];
  if (!player.qd.includes(questId)) player.qd.push(questId);
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); res.json({ ok:true, questId, reward:{coin:coinR,xp:xpR}, coin:player.coin, xp:player.xp, qa:player.qa, qd:player.qd }); }
  catch(e){ res.status(500).json({ error:'저장 실패' }); }
});

function requireAdmin(req,res,next){
  const key=userFromReq(req);
  if(!key) return res.status(401).json({error:'로그인이 필요합니다.'});
  if(!db.users[key]||!db.users[key].isAdmin) return res.status(403).json({error:'관리자 권한이 없습니다.'});
  req.userKey=key; next();
}
app.get('/api/admin/users', requireAdmin, (req,res)=>{
  const list=[];
  for(const [key,u] of Object.entries(db.users)){
    const st=db.states[key]&&db.states[key].player;
    list.push({
      key, username:u.username, isAdmin:!!u.isAdmin,
      banned:!!(u.banned||(db.bans&&db.bans[key])),
      createdAt:u.createdAt||0,
      lv: st?st.lv:1, coin: st?st.coin:0, xp: st?st.xp:0
    });
  }
  list.sort((a,b)=> (b.createdAt||0)-(a.createdAt||0));
  res.json({users:list});
});
app.post('/api/admin/ban', requireAdmin, (req,res)=>{
  const {username, banned=true} = req.body||{};
  if(typeof username!=='string') return res.status(400).json({error:'아이디가 필요합니다.'});
  const key=usernameKey(username);
  const u=db.users[key];
  if(!u) return res.status(404).json({error:'사용자를 찾을 수 없습니다.'});
  if(u.isAdmin) return res.status(400).json({error:'관리자는 차단할 수 없습니다.'});
  u.banned=!!banned;
  if(!db.bans) db.bans={};
  if(banned) db.bans[key]=Date.now(); else delete db.bans[key];
  try{persist(); res.json({ok:true, username:u.username, banned:!!u.banned});}
  catch(e){res.status(500).json({error:'저장 실패'});}
});
app.post('/api/admin/set-level', requireAdmin, (req,res)=>{
  const {username, level} = req.body||{};
  if(typeof username!=='string') return res.status(400).json({error:'아이디가 필요합니다.'});
  const lv=Math.floor(Number(level));
  if(!Number.isFinite(lv)||lv<1||lv>999) return res.status(400).json({error:'레벨은 1~999입니다.'});
  const key=usernameKey(username);
  if(!db.users[key]) return res.status(404).json({error:'사용자를 찾을 수 없습니다.'});
  const p=ensurePlayer(key);
  p.lv=lv;
  // rough xp curve reset
  p.nx = Math.max(30, lv*30);
  db.states[key].savedAt=Date.now();
  try{persist(); res.json({ok:true, username:db.users[key].username, lv:p.lv});}
  catch(e){res.status(500).json({error:'저장 실패'});}
});
app.post('/api/admin/give-coin', requireAdmin, (req,res)=>{
  const {username, amount} = req.body||{};
  if(typeof username!=='string') return res.status(400).json({error:'아이디가 필요합니다.'});
  const amt=Math.floor(Number(amount));
  if(!Number.isFinite(amt)||amt===0||Math.abs(amt)>1e9) return res.status(400).json({error:'코인 수량이 올바르지 않습니다.'});
  const key=usernameKey(username);
  if(!db.users[key]) return res.status(404).json({error:'사용자를 찾을 수 없습니다.'});
  const p=ensurePlayer(key);
  p.coin=Math.max(0, Math.min(1e9, (p.coin||0)+amt));
  db.states[key].savedAt=Date.now();
  try{persist(); res.json({ok:true, username:db.users[key].username, coin:p.coin});}
  catch(e){res.status(500).json({error:'저장 실패'});}
});

app.get('/healthz',(_req,res)=>res.json({ok:true, monsters:monsters.size}));
app.use(express.static(path.join(__dirname,'public'),{index:'index.html',dotfiles:'deny',maxAge:'1h',setHeaders(res,p){if(p.endsWith('.html'))res.setHeader('Cache-Control','no-cache');res.setHeader('X-Content-Type-Options','nosniff');}}));
app.use((err,_req,res,_next)=>{if(res.headersSent)return;res.status(400).json({error:'요청을 처리할 수 없습니다.'});});

const server=app.listen(PORT,HOST,()=>console.log(`RPG server listening on ${HOST}:${PORT}; data=${DB_FILE}`));
const wss=new WebSocketServer({noServer:true,maxPayload:8192,perMessageDeflate:false});
const players=new Map(), socketsByIp=new Map(), wsById=new Map();

function allowedOrigin(origin,req){if(!origin)return false;if(ALLOWED_ORIGINS.has(origin))return true;try{const u=new URL(origin),secure=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https';return u.host===req.headers.host&&u.protocol===(secure?'https:':'http:');}catch{return false;}}
function broadcast(data,except){const raw=JSON.stringify(data);for(const c of wss.clients)if(c!==except&&c.readyState===WebSocket.OPEN)try{c.send(raw);}catch{}}
function broadcastAll(data){const raw=JSON.stringify(data);for(const c of wss.clients)if(c.readyState===WebSocket.OPEN)try{c.send(raw);}catch{}}

function userFromWsReq(req){
  const cookies=String(req.headers.cookie||'').split(';').map(x=>x.trim());
  const item=cookies.find(x=>x.startsWith('rpg_session='));
  if(!item) return null;
  const payload=unsign(decodeURIComponent(item.slice('rpg_session='.length)));
  if(!payload||!db.users[payload.u]) return null;
  return { key: payload.u, username: db.users[payload.u].username };
}

server.on('upgrade',(req,socket,head)=>{
  let pathname; try{pathname=new URL(req.url,'http://localhost').pathname;}catch{socket.destroy();return;}
  if(pathname!=='/ws'||!allowedOrigin(req.headers.origin,req)){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
  const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
  if((socketsByIp.get(ip)||0)>=4||players.size>=MAX_PLAYERS){socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,ws=>{
    ws._ip=ip;
    socketsByIp.set(ip,(socketsByIp.get(ip)||0)+1);
    // 로그인 닉네임을 멀티플레이 이름으로 사용
    const auth=userFromWsReq(req);
    if(auth && db.users[auth.key] && (db.users[auth.key].banned || (db.bans&&db.bans[auth.key]))){
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    ws._userKey=auth?auth.key:null;
    ws._username=auth?auth.username:null;
    wss.emit('connection',ws,req);
  });
});

wss.on('connection',ws=>{
  ws.isAlive=true; ws.last=0;
  const id=crypto.randomUUID();
  // 회원가입/로그인 닉네임이 있으면 그 이름, 없으면 익명
  const displayName = ws._username || ('플레이어-'+id.slice(0,4));
  const p={id, name:displayName, x:0, z:8, y:0, face:0, pvp:false, hp:100, mhp:100};
  Object.defineProperty(p,'invTill',{value:0,writable:true,enumerable:false});   // 서버 전용(브로드캐스트 제외)
  players.set(id,p); ws.player=p; wsById.set(id,ws);
  ws._tokens=40; ws._tokT=Date.now();

  // 접속 시: 다른 플레이어 + 서버 몬스터 전체 상태 전송
  ws._seen=new Map();
  for(const m of monsters.values()) ws._seen.set(m.id,m.ver);
  ws.send(JSON.stringify({
    type:'welcome',
    id,
    name: displayName,
    players:[...players.values()].filter(x=>x.id!==id),
    monsters: monsterSnapshot()
  }));
  broadcast({type:'join', player:p}, ws);

  ws.on('pong',()=>ws.isAlive=true);
  ws.on('message',(data,binary)=>{
    const now=Date.now();
    // 토큰 버킷: 초당 40개, 순간 40개까지 허용 (이동 + 타격 배치가 겹쳐도 끊기지 않게)
    ws._tokens=Math.min(40,ws._tokens+(now-ws._tokT)/1000*40); ws._tokT=now;
    if(binary||data.length>8192||ws._tokens<1){ws.strikes=(ws.strikes||0)+1;if(ws.strikes>30)ws.close(1008,'rate limit');return;}
    ws._tokens-=1;
    let m; try{m=JSON.parse(data.toString());}catch{ws.close(1007,'json');return;}
    if(!m||typeof m.type!=='string') return;

    if(m.type==='move'){
      if(!Number.isFinite(m.x)||!Number.isFinite(m.z)||!Number.isFinite(m.y)||!Number.isFinite(m.face)||Math.abs(m.x)>1000||m.z>400||m.z<-2400||m.y<0||m.y>40){
        ws.strikes=(ws.strikes||0)+1; if(ws.strikes>=5)ws.close(1008,'state'); return;
      }
      Object.assign(p,{x:m.x,z:m.z,y:m.y,face:m.face});
      if(typeof m.pvp==='boolean') p.pvp=m.pvp;
      if(Number.isFinite(m.hp)) p.hp=Math.max(0,Math.min(1e6,m.hp));
      if(Number.isFinite(m.mhp)) p.mhp=Math.max(1,Math.min(1e6,m.mhp));
      if(m.inv) p.invTill=Math.max(p.invTill||0,now+150);   // 대쉬/스킬 무적 중에는 몬스터 공격 무효
      broadcast({type:'state',player:p},ws);
      return;
    }
    // PvP 공격: 양쪽 모두 pvp ON 일 때만
    if(m.type==='pvp_hit'){
      if(typeof m.targetId!=='string'||!Number.isFinite(m.dmg)) return;
      if(!p.pvp) return;
      const targetPlayer=[...players.values()].find(x=>x.id===m.targetId);
      if(!targetPlayer||!targetPlayer.pvp) return;
      const dist=Math.hypot(targetPlayer.x-p.x, targetPlayer.z-p.z);
      if(dist>8) return;
      const dmg=Math.max(1,Math.min(500,Math.floor(m.dmg)));
      targetPlayer.hp=Math.max(0,(targetPlayer.hp||100)-dmg);
      broadcastAll({type:'pvp_damage', from:p.id, to:targetPlayer.id, dmg, hp:targetPlayer.hp, name:p.name});
      return;
    }

    // 몬스터 타격: {type:'hit', list:[[몬스터id, 피해, 넉백], ...]} — 체력/사망/보상은 서버가 결정
    if(m.type==='hit'){
      if(!Array.isArray(m.list)||m.list.length>60) return;
      // 초당 타격 수 제한 (매크로/조작 완화)
      if(now-(ws._hitT||0)>=1000){ws._hitT=now;ws._hitN=0;}
      for(const h of m.list){
        if(!Array.isArray(h)||++ws._hitN>240) break;
        applyPlayerHit(p,ws,h[0],Number(h[1]),h[2]);
      }
      return;
    }
  });

  ws.on('close',()=>{
    players.delete(p.id); wsById.delete(p.id);
    broadcast({type:'leave',id:p.id});
    const n=(socketsByIp.get(ws._ip)||1)-1;
    if(n>0)socketsByIp.set(ws._ip,n); else socketsByIp.delete(ws._ip);
  });
  ws.on('error',()=>{});
  ws._heartbeat=setInterval(()=>{
    if(!ws.isAlive){ws.terminate();clearInterval(ws._heartbeat);return;}
    ws.isAlive=false; ws.ping();
  },30000);
});

// ===== 서버 몬스터 틱 (100ms): AI → 변경분 전송 =====
let lastTick=Date.now();
setInterval(()=>{
  const now=Date.now(), dt=Math.min(0.25,(now-lastTick)/1000); lastTick=now;
  try{ tickMonsters(dt,now); broadcastMonsters(); }catch(e){ console.error('monster tick error:',e); }
},100);

server.on('close',()=>{for(const ws of wss.clients)ws.terminate();});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
