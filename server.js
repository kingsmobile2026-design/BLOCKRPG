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
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const MAX_PLAYERS = 80;
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean));
try { fs.mkdirSync(DATA_DIR, {recursive:true}); } catch {}

// ===== MongoDB 저장소 (MongoClient) =====
const { MongoClient } = require('mongodb');
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kingsmobile2026_db_user:a20140205g@cluster0.ux498h7.mongodb.net/';
const MONGO_DB_NAME = process.env.MONGO_DB || 'blockrpg';
const MONGO_DOC_ID = 'main';
const mongoClient = new MongoClient(MONGO_URI, {
  family: 4, // Render IPv6/SSL 이슈 완화
  serverSelectionTimeoutMS: 20000
});
let mongoCol = null;
let db = { users: {}, states: {}, guilds: {}, bans: {} };
let _mongoReady = false;

async function connectToMongoDB() {
  await mongoClient.connect();
  console.log('You successfully connected to MongoDB!');
  return mongoClient;
}

async function disconnectFromMongoDB() {
  try { await mongoClient.close(); } catch {}
}

async function connectMongo() {
  try {
    await connectToMongoDB();
  } catch (err) {
    console.dir(err);
    throw err;
  }
  const mdb = mongoClient.db(MONGO_DB_NAME);
  mongoCol = mdb.collection('accounts');
  const doc = await mongoCol.findOne({ _id: MONGO_DOC_ID });
  if (doc) {
    db.users = doc.users && typeof doc.users === 'object' ? doc.users : {};
    db.states = doc.states && typeof doc.states === 'object' ? doc.states : {};
    db.guilds = doc.guilds && typeof doc.guilds === 'object' ? doc.guilds : {};
    db.bans = doc.bans && typeof doc.bans === 'object' ? doc.bans : {};
    console.log('MongoDB loaded: users=%d states=%d guilds=%d', Object.keys(db.users).length, Object.keys(db.states).length, Object.keys(db.guilds).length);
  } else {
    try {
      const legacy = path.join(DATA_DIR, 'accounts.json');
      const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      if (parsed && parsed.users) {
        db.users = parsed.users || {};
        db.states = parsed.states || {};
        db.guilds = parsed.guilds || {};
        db.bans = parsed.bans || {};
        console.log('Migrated local accounts.json -> MongoDB');
      }
    } catch {}
    await persist();
    console.log('MongoDB: created empty accounts document');
  }
  if (!db.guilds || typeof db.guilds !== 'object') db.guilds = {};
  if (!db.bans || typeof db.bans !== 'object') db.bans = {};
  _mongoReady = true;
}

function persist() {
  if (!mongoCol) return Promise.reject(new Error('MongoDB not connected'));
  return mongoCol.updateOne(
    { _id: MONGO_DOC_ID },
    { $set: { users: db.users, states: db.states, guilds: db.guilds, bans: db.bans, updatedAt: new Date() } },
    { upsert: true }
  ).catch(e => {
    console.error('persist failed:', e.message);
    throw e;
  });
}

// 저장 요청이 몰려도 1.5초에 한 번만 MongoDB 에 쓴다
let _persistT = null;
function persistSoon() {
  if (_persistT) return;
  _persistT = setTimeout(() => {
    _persistT = null;
    persist().catch(e => console.error('persist failed:', e.message));
  }, 1500);
}

// ★ 세션 서명 키: 환경변수 우선, 없으면 DATA_DIR/session.key
const SECRET_FILE = path.join(DATA_DIR, 'session.key');
let SESSION_SECRET = process.env.SESSION_SECRET || '';
if (!SESSION_SECRET) {
  try { SESSION_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch {}
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    SESSION_SECRET = crypto.randomBytes(48).toString('hex');
    try { fs.writeFileSync(SECRET_FILE, SESSION_SECRET, { mode: 0o600 }); }
    catch (e) { console.error('세션 키를 저장하지 못했습니다. SESSION_SECRET 환경변수를 설정하세요:', e.message); }
  }
}
const appLimiter=rateLimit({windowMs:60000,limit:300,standardHeaders:'draft-7',legacyHeaders:false});
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
const WORLD = {"MT":{"slime":{"hp":30,"dmg":6,"xp":12,"g":3,"sp":3.6,"reach":1.8,"rt":8,"sc":1,"n":22,"nm":"슬라임"},"wolf":{"hp":55,"dmg":10,"xp":20,"g":6,"sp":8,"reach":2.2,"rt":8,"sc":1,"n":18,"nm":"늑대"},"goblin":{"hp":135,"dmg":18,"xp":51,"g":16,"sp":5,"reach":2.3,"rt":10,"sc":1.1,"n":14,"nm":"고블린"},"skeleton":{"hp":252,"dmg":30,"xp":88,"g":28,"sp":5.5,"reach":2.4,"rt":12,"sc":1.15,"n":12,"nm":"해골 병사"},"golem":{"hp":3750,"dmg":76,"xp":528,"g":216,"sp":3,"reach":4.4,"rt":30,"sc":2.4,"n":6,"ag":20,"cd":1.8,"nm":"골렘"},"mushroom":{"hp":40,"dmg":8,"xp":16,"g":4,"sp":4,"reach":1.7,"rt":8,"sc":1,"n":14,"nm":"독버섯"},"bear":{"hp":130,"dmg":17,"xp":38,"g":12,"sp":5,"reach":3,"rt":12,"sc":1.5,"n":10,"nm":"불곰"},"orc":{"hp":304,"dmg":33,"xp":104,"g":35,"sp":4.8,"reach":3,"rt":14,"sc":1.4,"n":9,"nm":"오크 전사"},"ghost":{"hp":216,"dmg":39,"xp":128,"g":41,"sp":6,"reach":2.2,"rt":14,"sc":1,"n":9,"nm":"유령"},"dragon":{"hp":600000,"dmg":1000,"xp":40000,"g":30000,"sp":5,"reach":8,"rt":300,"sc":2.8,"n":1,"ag":29.4,"cd":2,"boss":1,"fix":[-150,-2000],"nm":"에인션트 드래곤"},"frostwolf":{"hp":2700,"dmg":100,"xp":288,"g":96,"sp":9,"reach":2.4,"rt":10,"sc":1.1,"n":14,"nm":"서리 늑대"},"yeti":{"hp":5850,"dmg":155,"xp":528,"g":192,"sp":5,"reach":3.4,"rt":14,"sc":1.7,"n":9,"nm":"예티"},"scorpion":{"hp":4680,"dmg":180,"xp":624,"g":216,"sp":6,"reach":2.6,"rt":10,"sc":1.2,"n":14,"nm":"거대 전갈"},"mummy":{"hp":9120,"dmg":228,"xp":912,"g":312,"sp":4.5,"reach":2.6,"rt":14,"sc":1.2,"n":10,"nm":"미라"},"toad":{"hp":14280,"dmg":283,"xp":1344,"g":456,"sp":5,"reach":2.8,"rt":12,"sc":1.3,"n":14,"nm":"독두꺼비"},"witch":{"hp":10200,"dmg":350,"xp":1680,"g":576,"sp":5,"reach":2.6,"rt":15,"sc":1.15,"n":9,"nm":"늪지 마녀"},"imp":{"hp":22800,"dmg":435,"xp":2160,"g":720,"sp":8.5,"reach":2.4,"rt":10,"sc":0.95,"n":14,"nm":"임프"},"hellhound":{"hp":38400,"dmg":528,"xp":3120,"g":1080,"sp":10,"reach":3,"rt":14,"sc":1.3,"n":10,"nm":"지옥견"},"darkknight":{"hp":46800,"dmg":735,"xp":4800,"g":1680,"sp":5.5,"reach":3.2,"rt":18,"sc":1.5,"n":8,"nm":"암흑 기사"},"demonlord":{"hp":2000000,"dmg":2000,"xp":200000,"g":120000,"sp":5,"reach":7,"rt":600,"sc":3.2,"n":1,"ag":32.2,"cd":2,"boss":1,"fix":[365,-820],"nm":"마왕"},"kingslime":{"hp":3000,"dmg":35,"xp":500,"g":400,"sp":3.5,"reach":3.8,"rt":60,"sc":3,"n":1,"ag":19.6,"cd":1.6,"boss":1,"fix":[0,-225],"nm":"킹 슬라임"},"wolfalpha":{"hp":9000,"dmg":110,"xp":1800,"g":1200,"sp":9,"reach":4,"rt":90,"sc":2.2,"n":1,"ag":23.8,"cd":1.4,"boss":1,"fix":[-185,-240],"nm":"늑대 대장"},"goblinking":{"hp":25000,"dmg":220,"xp":6000,"g":4000,"sp":5.5,"reach":4.5,"rt":120,"sc":2.4,"n":1,"ag":25.2,"cd":1.6,"boss":1,"fix":[185,-240],"nm":"고블린 왕"},"lich":{"hp":150000,"dmg":450,"xp":15000,"g":12000,"sp":5.5,"reach":5,"rt":180,"sc":2.6,"n":1,"ag":26.6,"cd":1.8,"boss":1,"fix":[495,-770],"nm":"해골 군주"},"boar":{"hp":70,"dmg":12,"xp":24,"g":7,"sp":6.5,"reach":2.3,"rt":8,"sc":1.1,"n":10,"nm":"멧돼지"},"spider":{"hp":150,"dmg":22,"xp":45,"g":14,"sp":7,"reach":2.4,"rt":9,"sc":1.2,"n":10,"nm":"거대 거미"},"goblinshaman":{"hp":330,"dmg":36,"xp":70,"g":24,"sp":4.5,"reach":2.6,"rt":10,"sc":1.1,"n":8,"nm":"고블린 주술사"},"zombie":{"hp":420,"dmg":44,"xp":90,"g":30,"sp":3.5,"reach":2.5,"rt":10,"sc":1.15,"n":9,"nm":"좀비"},"gargoyle":{"hp":4500,"dmg":90,"xp":450,"g":150,"sp":6,"reach":2.8,"rt":14,"sc":1.3,"n":4,"nm":"가고일"},"icegolem":{"hp":9000,"dmg":190,"xp":675,"g":225,"sp":4,"reach":3.6,"rt":14,"sc":2,"n":8,"nm":"얼음 골렘"},"cactus":{"hp":10800,"dmg":230,"xp":900,"g":300,"sp":4,"reach":2.8,"rt":12,"sc":1.3,"n":10,"nm":"선인장 몬스터"},"lizardman":{"hp":19500,"dmg":330,"xp":1500,"g":495,"sp":6,"reach":2.9,"rt":12,"sc":1.3,"n":10,"nm":"리자드맨"},"flamegolem":{"hp":32000,"dmg":560,"xp":2700,"g":900,"sp":4.5,"reach":3.8,"rt":16,"sc":2.1,"n":8,"nm":"화염 골렘"},"wraith":{"hp":30000,"dmg":800,"xp":3000,"g":1000,"sp":7,"reach":2.6,"rt":16,"sc":1.1,"n":8,"nm":"망령"},"bee":{"hp":60,"dmg":14,"xp":22,"g":6,"sp":8.5,"reach":2,"rt":8,"sc":1.2,"n":10,"nm":"거대 벌"},"treant":{"hp":220,"dmg":28,"xp":55,"g":18,"sp":3.5,"reach":3,"rt":10,"sc":1.6,"n":8,"nm":"나무 정령"},"hobgoblin":{"hp":380,"dmg":48,"xp":85,"g":28,"sp":5,"reach":2.7,"rt":10,"sc":1.3,"n":8,"nm":"홍고블린"},"necromancer":{"hp":500,"dmg":55,"xp":120,"g":40,"sp":4.5,"reach":2.6,"rt":12,"sc":1.15,"n":7,"nm":"네크로맨서"},"minotaur":{"hp":5400,"dmg":110,"xp":570,"g":195,"sp":5.5,"reach":3.4,"rt":14,"sc":1.8,"n":4,"nm":"미노타우르스"},"frostmage":{"hp":9900,"dmg":210,"xp":780,"g":255,"sp":4.5,"reach":2.8,"rt":12,"sc":1.2,"n":8,"nm":"얼음 마법사"},"anubis":{"hp":12600,"dmg":260,"xp":1050,"g":345,"sp":5.5,"reach":3,"rt":12,"sc":1.3,"n":8,"nm":"아누비스 전사"},"snake":{"hp":22500,"dmg":360,"xp":1725,"g":570,"sp":7,"reach":3.2,"rt":12,"sc":1.4,"n":10,"nm":"거대 뱀"},"pyromancer":{"hp":42000,"dmg":520,"xp":2550,"g":840,"sp":5,"reach":2.8,"rt":14,"sc":1.2,"n":8,"nm":"화염술사"},"vampire":{"hp":33000,"dmg":900,"xp":3400,"g":1100,"sp":7.5,"reach":2.8,"rt":14,"sc":1.2,"n":8,"nm":"흡혈귀"},"frostgiant":{"hp":200000,"dmg":600,"xp":30000,"g":25000,"sp":5,"reach":6,"rt":240,"sc":3,"n":1,"ag":28,"cd":1.8,"boss":1,"fix":[365,-660],"nm":"서리 거인"},"pharaoh":{"hp":300000,"dmg":800,"xp":45000,"g":35000,"sp":5.5,"reach":5.5,"rt":270,"sc":2.6,"n":1,"ag":29,"cd":1.7,"boss":1,"fix":[365,-700],"nm":"파라오"},"hydra":{"hp":450000,"dmg":1100,"xp":70000,"g":55000,"sp":5,"reach":7,"rt":300,"sc":3,"n":1,"ag":30,"cd":2,"boss":1,"fix":[365,-740],"nm":"히드라"},"balrog":{"hp":800000,"dmg":1600,"xp":120000,"g":90000,"sp":5.5,"reach":7,"rt":420,"sc":3.4,"n":1,"ag":31,"cd":2,"boss":1,"fix":[365,-780],"nm":"발록"},"mgoat":{"hp":170,"dmg":21,"xp":44,"g":14,"sp":6.5,"reach":2.4,"rt":9,"sc":1.15,"n":8,"nm":"산양"},"bandit":{"hp":280,"dmg":32,"xp":68,"g":24,"sp":5.2,"reach":2.6,"rt":11,"sc":1.1,"n":8,"nm":"산적"},"worldboss":{"hp":8000000,"dmg":5000,"xp":3000000,"g":1500000,"sp":6.5,"reach":8,"rt":600,"sc":4.5,"n":1,"ag":70,"cd":2.2,"boss":1,"fix":[760,-740],"nm":"월드 보스"},"crystalbeetle":{"hp":650,"dmg":70,"xp":150,"g":50,"sp":5,"reach":2.6,"rt":10,"sc":1.25,"n":12,"nm":"수정 딱정벌레"},"crystalbat":{"hp":520,"dmg":80,"xp":170,"g":56,"sp":9.5,"reach":2.2,"rt":9,"sc":1.0,"n":12,"nm":"수정 박쥐"},"prismwisp":{"hp":900,"dmg":110,"xp":240,"g":80,"sp":6.5,"reach":2.4,"rt":11,"sc":1.0,"n":8,"nm":"프리즘 정령"},"amethystgolem":{"hp":1700,"dmg":125,"xp":340,"g":120,"sp":3.6,"reach":4.0,"rt":16,"sc":2.0,"n":6,"ag":20,"cd":1.8,"nm":"자수정 골렘"},"statueguard":{"hp":1500,"dmg":115,"xp":300,"g":100,"sp":4.2,"reach":3.2,"rt":14,"sc":1.7,"n":8,"nm":"석상 수호병"},"harpy":{"hp":800,"dmg":105,"xp":230,"g":78,"sp":9,"reach":2.4,"rt":10,"sc":1.1,"n":10,"nm":"하피"},"cursedarmor":{"hp":1200,"dmg":140,"xp":280,"g":96,"sp":5.5,"reach":3.0,"rt":12,"sc":1.4,"n":8,"nm":"저주받은 갑옷"},"mimic":{"hp":1000,"dmg":150,"xp":260,"g":200,"sp":6,"reach":2.4,"rt":12,"sc":1.2,"n":6,"nm":"미믹"}},"ZD":{"village":[[-24,24,-24,24]],"corridor":[[-8,8,-150,-24]],"plains":[[-110,110,-300,-150]],"forest":[[-260,-110,-300,-170]],"camp":[[110,260,-300,-170]],"hill":[[-160,80,-440,-300]],"cavearea":[[-260,-160,-440,-300]],"bentry":[[380,480,-640,-560]],"grave":[[430,560,-840,-640]],"snow":[[300,430,-680,-640]],"desert":[[300,430,-720,-680]],"swamp":[[300,430,-760,-720]],"hell":[[300,430,-800,-760]],"dark":[[300,430,-840,-800]],"centry":[[-220,-80,-1900,-1800]],"golem":[[-300,0,-2060,-1900]],"arena":[[700,820,-780,-660]],"crystal":[[80,260,-440,-300]],"ruins":[[-400,-260,-300,-170]]},"ZT":{"slime":"plains","mushroom":"plains","boar":"plains","bee":"plains","wolf":"forest","bear":"forest","spider":"forest","treant":"forest","goblin":"camp","orc":"camp","hobgoblin":"camp","goblinshaman":"camp","skeleton":"grave","ghost":"grave","zombie":"grave","necromancer":"grave","wraith":"grave","vampire":"grave","frostwolf":"snow","yeti":"snow","frostmage":"snow","scorpion":"desert","mummy":"desert","cactus":"desert","lizardman":"desert","anubis":"desert","toad":"swamp","witch":"swamp","snake":"swamp","imp":"hell","hellhound":"hell","pyromancer":"hell","darkknight":"dark","golem":"golem","gargoyle":"golem","icegolem":"golem","flamegolem":"golem","minotaur":"golem","mgoat":"hill","bandit":"hill","crystalbeetle":"crystal","crystalbat":"crystal","prismwisp":"crystal","amethystgolem":"crystal","statueguard":"ruins","harpy":"ruins","cursedarmor":"ruins","mimic":"ruins"},"BK":[[-60,-30,-390,-340],[10,40,-420,-380],[428,432,-840,-800],[428,432,-770,-720],[428,432,-690,-640]],"BOSS":{"kingslime":[0,-225],"wolfalpha":[-185,-240],"goblinking":[185,-240],"lich":[495,-770],"frostgiant":[365,-660],"pharaoh":[365,-700],"hydra":[365,-740],"balrog":[365,-780],"demonlord":[365,-820],"dragon":[-150,-2000],"worldboss":[760,-740]}};
const MT = WORLD.MT;

// 신규 몬스터 스탯
Object.assign(WORLD.MT, {
  shadowwolf:{hp:800,dmg:95,xp:200,g:70,sp:9.5,reach:2.5,rt:10,sc:1.15,n:6,nm:'그림자 늑대'},
  stonegolem:{hp:2500,dmg:140,xp:400,g:140,sp:3.2,reach:4.2,rt:16,sc:2.2,n:6,ag:22,cd:1.9,nm:'석상 골렘'},
  fireimp:{hp:1100,dmg:160,xp:280,g:90,sp:8.5,reach:2.3,rt:11,sc:1.0,n:10,nm:'화염 임프'},
  icewraith:{hp:1400,dmg:130,xp:320,g:110,sp:7,reach:2.5,rt:12,sc:1.1,n:8,nm:'얼음 망령'},
  swampbeast:{hp:1800,dmg:150,xp:360,g:120,sp:4.5,reach:3.2,rt:14,sc:1.6,n:8,nm:'늪 야수'},
  voidcultist:{hp:1600,dmg:180,xp:380,g:130,sp:5.5,reach:2.6,rt:13,sc:1.2,n:8,nm:'공허 신도'}
});

Object.assign(WORLD.ZT, {
  // 그림자 늑대는 초보 평원이 아니라 암흑 지대 (검은색·고스펙)
  shadowwolf:'dark', stonegolem:'golem', fireimp:'hell',
  icewraith:'snow', swampbeast:'swamp', voidcultist:'dark'
});

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
              home: [x, z], px: x, pz: z, t: Math.random() * 6, ver: 1, atk: 0, dmg: new Map(), cast: null, skT: rnd(4, 8) };
  monsters.set(id, m);
  return m;
}
function respawnMonster(m) {
  const d = MT[m.type];
  const [x, z] = pickPos(m.type);
  m.x = x; m.z = z; m.px = x; m.pz = z; m.home = [x, z];
  m.hp = d.hp; m.mhp = d.hp; m.dead = false; m.rt = 0; m.cd = 0; m.kx = m.kz = 0; m.face = 0; m.cast = null; m.skT = rnd(4, 8);
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
// ★ 보스 밸런스: 무기가 아무리 강해도 보스는 "한 번에 / 1초에" 받는 피해에 상한이 있다.
//   BOSS_CAP[type] = 한 명이 최대 딜로 때려도 최소 이만큼(초)은 걸려야 잡히는 시간.
const BOSS_CAP = { kingslime:15, wolfalpha:20, goblinking:30, lich:40, frostgiant:50, pharaoh:60, hydra:70, balrog:80, dragon:75, demonlord:100, worldboss:400 };
const WB_TEAM_CAP = 0.015;   // 월드 보스: 전체 플레이어 합산 초당 최대 1.5% (최소 약 67초)
function bossLimit(m, d, ws, dmg) {
  const now = Date.now();
  const secs = BOSS_CAP[m.type] || 40, perSec = m.mhp / secs;
  dmg = Math.min(dmg, Math.max(1, Math.floor(perSec * 0.4)));           // 1회 타격 상한
  if (!ws._bk) ws._bk = new Map();
  let b = ws._bk.get(m.id);
  if (!b) { b = { tk: perSec, t: now }; ws._bk.set(m.id, b); if (ws._bk.size > 20) ws._bk.delete(ws._bk.keys().next().value); }
  b.tk = Math.min(perSec, b.tk + (now - b.t) / 1000 * perSec); b.t = now;
  if (dmg > b.tk) dmg = Math.floor(b.tk);                                // 초당 상한(토큰 버킷)
  if (m.type === 'worldboss') {
    const g = m.gb || (m.gb = { tk: m.mhp * WB_TEAM_CAP, t: now }), gs = m.mhp * WB_TEAM_CAP;
    g.tk = Math.min(gs, g.tk + (now - g.t) / 1000 * gs); g.t = now;
    if (dmg > g.tk) dmg = Math.floor(g.tk);
    if (dmg >= 1) g.tk -= dmg;
  }
  if (dmg >= 1) b.tk -= dmg;
  if (dmg < 1 && now - (ws._capT || 0) > 1000) { ws._capT = now; try { ws.send(JSON.stringify({ type: 'bcap', id: m.id })); } catch {} }
  return dmg;
}
function applyPlayerHit(p, ws, id, dmg, kb, elem) {
  // 크리스탈 타격 (부위 파괴)
  if (typeof id === 'string' && id.startsWith('cr_')) {
    const mid = Number(id.slice(3));
    const m = monsters.get(mid);
    if (!m || m.dead || !m.crystals) return;
    const ci = m.crystals.findIndex(c => !c.dead && Math.hypot(c.x - p.x, c.z - p.z) < 4.5);
    if (ci < 0) return;
    const c = m.crystals[ci];
    c.hp -= Math.max(1, Math.min(50000, Math.floor(dmg)));
    if (c.hp <= 0) {
      c.dead = true;
      sendNear(m.x, m.z, { type: 'cr_break', id: mid, i: ci });
      if (m.crystals.every(x => x.dead)) {
        m.groggy = 4.5;
        m.cast = null;
        m.ver++;
        sendNear(m.x, m.z, { type: 'groggy', id: mid, t: 4.5 });
      }
    }
    return;
  }
  const m = monsters.get(id);
  if (!m || m.dead) return;
  if (!(dmg >= 1)) return;
  if (p.hp <= 0) return;
  const d = MT[m.type];
  const dx = m.x - p.x, dz = m.z - p.z, dist = Math.hypot(dx, dz);
  if (dist > d.reach + d.sc * 1.5 + 30) return;            // 너무 먼 몬스터는 타격 불가
  dmg = Math.max(1, Math.min(MAX_HIT_DMG, Math.floor(dmg)));
  // 원소 쉴드: 맞는 속성만 쉴드 파괴, 아니면 본체 피해 0
  if (d.boss && m.shield && m.shield.hp > 0) {
    const ok = elem && (elem === m.shield.elem || elem === 'all');
    if (!ok) {
      if (Date.now() - (ws._shT || 0) > 800) {
        ws._shT = Date.now();
        try { ws.send(JSON.stringify({ type: 'shield_block', id: m.id, elem: m.shield.elem })); } catch {}
      }
      return;
    }
    m.shield.hp -= dmg;
    m.ver++;
    sendNear(m.x, m.z, { type: 'shield_hit', id: m.id, hp: Math.max(0, Math.ceil(m.shield.hp)), mhp: m.shield.mhp });
    if (m.shield.hp <= 0) {
      m.shield = null;
      sendNear(m.x, m.z, { type: 'shield_break', id: m.id });
    }
    return; // 쉴드 중에는 본체 피해 없음
  }
  if (d.boss) { dmg = bossLimit(m, d, ws, dmg); if (dmg < 1) return; }
  // 그로기: 크리티컬 200%
  if (m.groggy && m.groggy > 0) dmg = Math.floor(dmg * 2);
  // 넉백 약화: 일반 몬스터 35%, 보스 20%만 적용
  kb = Math.max(0, Math.min(14, Number(kb) || 0)) * (d.boss ? 0.2 : 0.35);
  m.hp -= dmg;
  m.dmg.set(p.id, (m.dmg.get(p.id) || 0) + dmg);
  if (m.type === 'worldboss' && ws._userKey) bumpStat(ws._userKey, 'wb', dmg);
  if (kb > 0) { const dd = dist || 1; m.kx = dx / dd * kb; m.kz = dz / dd * kb; }
  m.ver++;
  if (m.hp <= 0) {
    m.hp = 0; m.dead = true; m.rt = d.rt; m.kx = m.kz = 0; m.cast = null; m.shield = null; m.groggy = 0; m.crystals = null; m.floor = null;
    // 보상: 마지막 일격을 가한 사람 + 몬스터 체력의 2% 이상 피해를 준 접속자
    const got = new Set();
    for (const [pid, dm] of m.dmg) {
      if (pid !== p.id && dm < m.mhp * 0.02) continue;
      const w = wsById.get(pid);
      if (w && w.readyState === WebSocket.OPEN) {
        got.add(pid);
        try { w.send(JSON.stringify({ type: 'kill', id: m.id, mt: m.type })); } catch {}
        if (w._userKey) {
          bumpStat(w._userKey, 'kills', 1); if (d.boss) bumpStat(w._userKey, 'boss', 1);
          const g = guildOfKey(w._userKey);
          if (g) addGuildExp(g, w._userKey, Math.min(2000, Math.max(1, Math.floor(d.xp / 25))));
          if (d.boss) tryDropRune(w, m, d);
        }
      }
    }
    // ★ 파티 보상 공유: 직접 보상을 받은 사람의 파티원(근처)에게 코인/경험치의 50% (퀘스트 진행·보상은 공유 안 됨)
    const shared = new Set(got);
    for (const pid of got) {
      const rp = players.get(pid), pt = rp && partyOf(rp);
      if (!pt) continue;
      for (const mid of pt.members) {
        if (shared.has(mid)) continue;
        const q = players.get(mid);
        if (!q || q.hp <= 0 || Math.hypot(q.x - m.x, q.z - m.z) > PARTY_SHARE_RANGE) continue;
        shared.add(mid);
        sendTo(mid, { type: 'pshare', coin: Math.floor(d.g * 0.5), xp: Math.floor(d.xp * 0.5), from: rp.name, nm: d.nm });
      }
    }
    if (d.boss) broadcastAll({ type: 'announce', text: '★ ' + p.name + ' 님이 ' + d.nm + ' 을(를) 처치했습니다!' });
    m.dmg.clear(); delete m.gb;
  }
}
const MAX_HIT_DMG = 500000;

// ===== 보스 특수 패턴 (예고 → 지연 후 판정, 피해는 'mdmg' 로 피격자에게 전달) =====
const BOSS_SK = {
  kingslime: ['leap', 'slam'],
  wolfalpha: ['charge', 'slam', 'leap'],
  goblinking: ['slam', 'charge', 'nova'],
  lich: ['meteor', 'nova', 'breath'],
  frostgiant: ['slam', 'breath', 'nova'],
  pharaoh: ['nova', 'breath', 'charge'],
  hydra: ['breath', 'slam', 'meteor'],
  balrog: ['slam', 'breath', 'meteor', 'charge'],
  demonlord: ['slam', 'breath', 'meteor', 'charge', 'nova'],
  dragon: ['breath', 'slam', 'meteor', 'leap'],
  worldboss: ['slam', 'breath', 'meteor', 'charge', 'nova', 'leap']
};
function sendNear(x, z, obj, range = AOI_RADIUS + 60) {
  const raw = JSON.stringify(obj);
  for (const ws of wss.clients) {
    const p = ws.player;
    if (!p || ws.readyState !== WebSocket.OPEN) continue;
    if (Math.hypot(p.x - x, p.z - z) > range) continue;
    try { ws.send(raw); } catch {}
  }
}
function bossHit(m, p, dmg, now) {
  if ((p.invTill || 0) > now) return;          // 대쉬/무적 중이면 회피 성공
  p.invTill = now + 400;
  const w = wsById.get(p.id);
  if (w && w.readyState === WebSocket.OPEN) { try { w.send(JSON.stringify({ type: 'mdmg', id: m.id, dmg, mt: m.type })); } catch {} }
}
const inCircle = (p, x, z, r) => Math.hypot(p.x - x, p.z - z) <= r + 0.6;
function inCone(p, ox, oz, dir, len, half) {
  const dx = p.x - ox, dz = p.z - oz, dist = Math.hypot(dx, dz);
  if (dist > len + 0.6) return false;
  if (dist < 1.5) return true;
  let a = Math.atan2(dx, dz) - dir; a = Math.atan2(Math.sin(a), Math.cos(a));
  return Math.abs(a) <= half;
}

function nextSkillTime(m) { m.skT = (m.hp < m.mhp * 0.3) ? rnd(3.5, 6) : rnd(6, 10); }

// ===== 보스 쉴드 / 그로기 / 장판 기믹 =====
const BOSS_SHIELD_ELEMS = { dragon:'fire', frostgiant:'ice', balrog:'fire', demonlord:'dark', worldboss:'all', lich:'dark', hydra:'poison', pharaoh:'fire' };
const SHIELD_NAMES = { fire:'화염 쉴드', ice:'서리 쉴드', dark:'암흑 쉴드', poison:'독 쉴드', all:'만능 쉴드' };
function maybeStartShield(m, d) {
  if (!d.boss || m.shield || (m.groggy && m.groggy > 0)) return;
  const elem = BOSS_SHIELD_ELEMS[m.type];
  if (!elem) return;
  if (m.hp > m.mhp * 0.85) return; // 초반엔 안 켬
  const now = Date.now();
  if ((m._shNext || 0) > now) return;
  m._shNext = now + (m.type === 'worldboss' ? 28000 : 22000);
  const mhp = Math.max(80, Math.floor(m.mhp * (m.type === 'worldboss' ? 0.04 : 0.06)));
  m.shield = { elem, hp: mhp, mhp };
  m.ver++;
  sendNear(m.x, m.z, { type: 'shield_on', id: m.id, elem, hp: mhp, mhp, name: SHIELD_NAMES[elem] || '쉴드' });
}
function spawnCrystals(m, d) {
  if (!d.boss) return;
  if (m.crystals && m.crystals.some(c => !c.dead)) return;
  const n = m.type === 'worldboss' ? 4 : 3;
  const sc = d.sc || 2;
  const list = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 6.283 + rnd(-0.2, 0.2);
    const r = 5 + sc * 1.8 + rnd(0, 2);
    list.push({ x: m.x + Math.sin(a) * r, z: m.z + Math.cos(a) * r, hp: Math.max(200, Math.floor(m.mhp * 0.008)), dead: false });
  }
  m.crystals = list;
  sendNear(m.x, m.z, { type: 'crystals', id: m.id, list: list.map(c => ({ x: q2(c.x), z: q2(c.z), hp: c.hp })) });
}
function startFloorPattern(m, d) {
  if (m.type !== 'worldboss' && m.type !== 'demonlord' && m.type !== 'balrog') return;
  if (m.floor && m.floor.length) return;
  const waves = [];
  const base = m.type === 'worldboss' ? 7 : 5;
  for (let w = 0; w < 4; w++) {
    const pts = [];
    for (let i = 0; i < base; i++) {
      const a = rnd(0, 6.283), r = rnd(4, 18 + (d.sc || 2) * 2);
      pts.push({ x: q2(m.x + Math.sin(a) * r), z: q2(m.z + Math.cos(a) * r), r: 3.2 + rnd(0, 1.2) });
    }
    waves.push({ t: 0.85 + w * 0.55, pts, fired: false });
  }
  m.floor = waves;
  sendNear(m.x, m.z, { type: 'floor_pat', id: m.id, waves: waves.map(w => ({ t: w.t, pts: w.pts })) });
}
function tickBossGimmick(m, d, dt, now, alive) {
  if (!d.boss) return;
  if (m.groggy && m.groggy > 0) {
    m.groggy -= dt;
    if (m.groggy <= 0) { m.groggy = 0; m.crystals = null; sendNear(m.x, m.z, { type: 'groggy_end', id: m.id }); }
  }
  maybeStartShield(m, d);
  // 브레스 등 강력한 시전 시작 시 크리스탈 스폰
  if (m.cast && m.cast.stage === 'tele' && (m.cast.kind === 'breath' || m.cast.kind === 'meteor') && !m._crSpawned) {
    m._crSpawned = true;
    spawnCrystals(m, d);
  }
  if (!m.cast) m._crSpawned = false;
  // 장판: 주기적으로 월드보스/마왕
  if ((m.type === 'worldboss' || m.type === 'demonlord' || m.type === 'balrog') && !m.floor) {
    m._flT = (m._flT || rnd(8, 14)) - dt;
    if (m._flT <= 0) { m._flT = rnd(12, 20); startFloorPattern(m, d); }
  }
  if (m.floor && m.floor.length) {
    let any = false;
    for (const w of m.floor) {
      if (w.fired) continue;
      any = true;
      w.t -= dt;
      if (w.t <= 0) {
        w.fired = true;
        const dmg = Math.round(d.dmg * (m.type === 'worldboss' ? 2.2 : 1.8));
        for (const pt of w.pts) {
          for (const p of alive) {
            if (Math.hypot(p.x - pt.x, p.z - pt.z) <= pt.r + 0.6) bossHit(m, p, dmg, now);
          }
        }
        sendNear(m.x, m.z, { type: 'floor_boom', id: m.id, pts: w.pts });
      }
    }
    if (!any) m.floor = null;
  }
}

function startBossCast(m, d, tgt, td) {
  const list = BOSS_SK[m.type];
  let pool = list.filter(k => td < 14 || (k !== 'slam' && k !== 'nova'));
  if (!pool.length) pool = list;
  const kind = pool[(Math.random() * pool.length) | 0];
  const sc = d.sc || 1;
  const dir = Math.atan2(tgt.x - m.x, tgt.z - m.z);
  const c = { kind, stage: 'tele', t: 1, dir, mult: 1.5 };
  const fx = { type: 'bfx', id: m.id, t: m.type, k: kind, bx: q2(m.x), bz: q2(m.z), a: q2(dir) };
  if (kind === 'slam') { c.t = 1.0; c.r = 6 + sc * 2.2; c.mult = 1.5; fx.r = q2(c.r); }
  else if (kind === 'nova') { c.t = 1.5; c.r = 12 + sc * 3; c.mult = 1.2; fx.r = q2(c.r); }
  else if (kind === 'breath') { c.t = 1.2; c.len = 16 + sc * 5; c.half = 0.55; c.mult = 1.7; fx.len = q2(c.len); fx.hw = c.half; }
  else if (kind === 'charge') { c.t = 0.9; c.len = 26 + sc * 2; c.hw = 2.5 + sc * 0.6; c.mult = 1.5; fx.len = q2(c.len); fx.hw = q2(c.hw); }
  else if (kind === 'leap') { c.t = 0.9; c.r = 6 + sc * 1.6; c.mult = 1.6; c.tx = tgt.x; c.tz = tgt.z; fx.r = q2(c.r); fx.tx = q2(tgt.x); fx.tz = q2(tgt.z); }
  else { // meteor: 플레이어 위치 + 무작위 낙하 지점
    c.t = 1.6; c.r = 5; c.mult = 1.3;
    const ag = d.ag || 40;
    const pts = [];
    for (const p of players.values()) { if (p.hp > 0 && pts.length < 5 && Math.hypot(p.x - m.x, p.z - m.z) < ag * 1.5) pts.push([q2(p.x), q2(p.z)]); }
    for (let i = 0; i < 3; i++) { const a = rnd(0, 6.283), r = rnd(4, 22); pts.push([q2(m.x + Math.sin(a) * r), q2(m.z + Math.cos(a) * r)]); }
    c.pts = pts; fx.r = c.r; fx.pts = pts;
  }
  fx.d = c.t;
  m.cast = c; m.face = dir; m.ver++;
  sendNear(m.x, m.z, fx);
}
// 반환값 true = 시전 중이라 일반 AI(이동/기본공격)를 건너뜀
function bossSkillTick(m, d, dt, now, alive, tgt, td) {
  if (!BOSS_SK[m.type]) return false;
  const c = m.cast;
  if (c) {
    c.t -= dt;
    if (c.stage === 'tele') {
      if (c.t > 0) return true;
      const dmg = Math.round(d.dmg * c.mult);
      if (c.kind === 'charge') { c.stage = 'go'; c.t = 0.45; c.hit = new Set(); return true; }
      m.atk = 1;
      if (c.kind === 'slam' || c.kind === 'nova') {
        for (const p of alive) if (inCircle(p, m.x, m.z, c.r)) bossHit(m, p, dmg, now);
      } else if (c.kind === 'breath') {
        for (const p of alive) if (inCone(p, m.x, m.z, c.dir, c.len, c.half)) bossHit(m, p, dmg, now);
      } else if (c.kind === 'leap') {
        if (inW(c.tx, c.tz) && Math.hypot(c.tx, c.tz) > VILLAGE_R + 2) { m.x = c.tx; m.z = c.tz; m.px = m.x; m.pz = m.z; }
        for (const p of alive) if (inCircle(p, m.x, m.z, c.r)) bossHit(m, p, dmg, now);
      } else if (c.kind === 'meteor') {
        for (const pt of c.pts) for (const p of alive) if (inCircle(p, pt[0], pt[1], c.r)) bossHit(m, p, dmg, now);
      }
      m.cast = null; nextSkillTime(m); m.cd = Math.max(m.cd, 1.0); m.ver++;
      return true;
    }
    // charge: 돌진 이동 중 경로상의 플레이어에게 1회씩 피해
    const step = c.len / 0.45 * dt;
    const nx = m.x + Math.sin(c.dir) * step, nz = m.z + Math.cos(c.dir) * step;
    if (inW(nx, nz) && Math.hypot(nx, nz) > VILLAGE_R + 2) { m.x = nx; m.z = nz; } else c.t = 0;
    const dmg = Math.round(d.dmg * c.mult);
    for (const p of alive) {
      if (c.hit.has(p.id)) continue;
      if (Math.hypot(p.x - m.x, p.z - m.z) <= c.hw + 1.2 + (d.sc || 1) * 0.5) { c.hit.add(p.id); bossHit(m, p, dmg, now); }
    }
    if (c.t <= 0) { m.cast = null; nextSkillTime(m); m.cd = Math.max(m.cd, 1.0); }
    m.ver++;
    return true;
  }
  if (tgt) {
    m.skT -= dt;
    if (m.skT <= 0) { startBossCast(m, d, tgt, td); return true; }
  }
  return false;
}

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
    // 보스: 어그로 범위 확대 + 스티키 어그로 (범위 안인데 풀리는 버그 방지)
    const agR = d.boss ? ag * 2.0 : ag;
    const stickR = d.boss ? ag * 3.0 : ag * 1.4;
    for (const p of alive) {
      const dd = Math.hypot(p.x - m.x, p.z - m.z);
      if (dd < nearAny) nearAny = dd;
      // 마을 한가운데(반경 17) 안의 몬스터만 타겟 금지 — 보스는 제외
      const inVillageCore = !d.boss && Math.hypot(m.x, m.z) <= 17;
      if (!inVillageCore && dd < agR && dd < td) { td = dd; tgt = p; }
    }
    if (!tgt && m._lastTgtId) {
      const lp = alive.find(p => p.id === m._lastTgtId);
      if (lp) {
        const dd = Math.hypot(lp.x - m.x, lp.z - m.z);
        if (dd < stickR) { tgt = lp; td = dd; }
      }
    }
    if (tgt) m._lastTgtId = tgt.id;
    else if (nearAny > stickR) m._lastTgtId = null;
    if (d.boss) tickBossGimmick(m, d, dt, now, alive);
    const casting = d.boss ? bossSkillTick(m, d, dt, now, alive, tgt, td) : false;
    if (casting) { /* 보스 특수 패턴 시전 중 */ }
    else if (tgt) {
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
      const hx = m.home[0] - m.x, hz = m.home[1] - m.z, hd = Math.hypot(hx, hz);
      if (d.boss) {
        // 보스는 어그로 밖일 때만 홈 복귀, HP 회복 없음
        if (nearAny > ag * 2.5 && hd > 1) {
          m.x += hx / hd * 12 * dt; m.z += hz / hd * 12 * dt; m.face = Math.atan2(hx, hz);
        }
      } else if (hd > 1.2) {
        const s = Math.min(hd, 13 * dt);
        m.x += hx / hd * s; m.z += hz / hd * s; m.face = Math.atan2(hx, hz);
        if (nearAny > ag * 1.2) m.hp = Math.min(m.mhp, m.hp + m.mhp * 0.15 * dt);
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
function isHttps(req){return String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https'||!!(req.socket&&req.socket.encrypted);}
function cookie(req,res,token){res.setHeader('Set-Cookie',`rpg_session=${token}; Path=/; HttpOnly; ${isHttps(req)?'Secure; ':''}SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS/1000)}`);}
function newToken(key){return sign({u:key,exp:Date.now()+SESSION_TTL_MS});}
function clearCookie(req,res){res.setHeader('Set-Cookie',`rpg_session=; Path=/; HttpOnly; ${isHttps(req)?'Secure; ':''}SameSite=Lax; Max-Age=0`);}
function userFromToken(t){const p=unsign(t);return p&&db.users[p.u]?p.u:null;}
function userFromReq(req){
  try{const item=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('rpg_session='));
    if(item){const k=userFromToken(decodeURIComponent(item.slice('rpg_session='.length)));if(k)return k;}}catch{}
  const h=req.headers['x-rpg-token'];return typeof h==='string'&&h?userFromToken(h):null;
}
function requireUser(req,res,next){const u=userFromReq(req);if(!u)return res.status(401).json({error:'로그인이 필요합니다.'});req.userKey=u;next();}
function publicName(key){return db.users[key].username;}

// ===== 관리자 계정 시드 (ADMIN) — Mongo 연결 후 seedAdmin() 호출 =====
function seedAdmin(){
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
    console.log('Admin account seeded: ADMIN');
    return persist().catch(e => console.error('seed persist', e.message));
  } else {
    db.users[key].isAdmin = true;
    db.users[key].banned = !!db.users[key].banned;
  }
  if(!db.bans) db.bans = {};
  return Promise.resolve();
}

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
  if(typeof p.we!=='number'||!Number.isFinite(p.we)) p.we=0;
  if(typeof p.ae!=='number'||!Number.isFinite(p.ae)) p.ae=0;
  p.we=Math.max(0,Math.min(15,Math.floor(p.we)));
  p.ae=Math.max(0,Math.min(15,Math.floor(p.ae)));
  if(!p.items||typeof p.items!=='object') p.items={};
  if(typeof p.rebirth!=='number'||!Number.isFinite(p.rebirth)) p.rebirth=0;
  p.rebirth=Math.max(0,Math.min(99,Math.floor(p.rebirth)));
  if(typeof p.rcoin!=='number'||!Number.isFinite(p.rcoin)) p.rcoin=0;
  p.rcoin=Math.max(0,Math.min(1e9,Math.floor(p.rcoin)));
  if(typeof p.title!=='string') p.title='';
  if(!p.talents||typeof p.talents!=='object') p.talents={};
  if(typeof p.talentPts!=='number'||!Number.isFinite(p.talentPts)) p.talentPts=0;
  p.talentPts=Math.max(0,Math.min(500,Math.floor(p.talentPts)));
  if(!Array.isArray(p.runes)) p.runes=[];
  if(!p.runeEq||typeof p.runeEq!=='object') p.runeEq={w:null,a:null,u:null};
  if(typeof p.towerBest!=='number'||!Number.isFinite(p.towerBest)) p.towerBest=0;
  p.towerBest=Math.max(0,Math.min(9999,Math.floor(p.towerBest)));
  if(typeof p.towerDaily!=='number') p.towerDaily=0;
  if(typeof p.towerDailyAt!=='number') p.towerDailyAt=0;
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
 if(typeof p.job==='string'&&/^[a-z_]{1,24}$/.test(p.job)) player.job=p.job;
 if(Number.isFinite(Number(p.we))) player.we=Math.max(0,Math.min(15,Math.floor(Number(p.we))));
 if(Number.isFinite(Number(p.ae))) player.ae=Math.max(0,Math.min(15,Math.floor(Number(p.ae))));
 if(Number.isFinite(Number(p.rebirth))) player.rebirth=Math.max(0,Math.min(99,Math.floor(Number(p.rebirth))));
 if(Number.isFinite(Number(p.rcoin))) player.rcoin=Math.max(0,Math.min(1e9,Math.floor(Number(p.rcoin))));
 if(typeof p.title==='string') player.title=String(p.title).slice(0,24);
 if(p.talents&&typeof p.talents==='object'&&!Array.isArray(p.talents)){
  const t={}; for(const [k,v] of Object.entries(p.talents)){ if(/^[a-z0-9_]{1,16}$/.test(k)&&Number.isInteger(v)&&v>=0&&v<=10) t[k]=v; }
  player.talents=t;
 }
 if(Number.isFinite(Number(p.talentPts))) player.talentPts=Math.max(0,Math.min(500,Math.floor(Number(p.talentPts))));
 if(Array.isArray(p.runes)) player.runes=p.runes.filter(r=>r&&typeof r==='object'&&typeof r.id==='string').slice(0,40);
 if(p.runeEq&&typeof p.runeEq==='object'){ const re={}; for(const k of['w','a','u']){ const v=p.runeEq[k]; re[k]=(typeof v==='string'&&v.length<=32)?v:null; } player.runeEq=re; }
 if(Number.isFinite(Number(p.towerBest))) player.towerBest=Math.max(0,Math.min(9999,Math.floor(Number(p.towerBest))));
 if(Number.isFinite(Number(p.towerDaily))) player.towerDaily=Math.max(0,Math.floor(Number(p.towerDaily)));
 if(Number.isFinite(Number(p.towerDailyAt))) player.towerDailyAt=Math.floor(Number(p.towerDailyAt));
 if(Array.isArray(p.sbk)) player.sbk=p.sbk.filter(v=>typeof v==='string'&&/^[A-Za-z0-9_]{1,32}$/.test(v)).slice(0,60);
 if(Array.isArray(p.sks)) player.sks=p.sks.filter(v=>typeof v==='string'&&v.length>0&&v.length<=24).slice(0,8);
 if(p.look&&typeof p.look==='object'&&!Array.isArray(p.look)){const lk={};for(const k of['skin','hair','hs','hat','cape']){const v=Number(p.look[k]);if(Number.isFinite(v)&&v>=0&&v<=0xffffff)lk[k]=Math.floor(v);}player.look=lk;}
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
 const token=newToken(key);cookie(req,res,token);
 res.status(201).json({user:username,state:null,token});
});
app.post('/api/login',authLimiter,(req,res)=>{
 const {username,password}=req.body||{};if(typeof username!=='string'||typeof password!=='string')return res.status(400).json({error:'아이디와 비밀번호를 입력하세요.'});
 const key=usernameKey(username),u=db.users[key];
 const salt=u?u.salt:'00000000000000000000000000000000';
 const actual=hashPassword(password,salt),expected=u?u.passwordHash:'0'.repeat(128);
 if(!u||!safeEqual(actual,expected))return res.status(401).json({error:'아이디 또는 비밀번호가 올바르지 않습니다.'});
 if(u.banned||(db.bans&&db.bans[key]))return res.status(403).json({error:'차단된 계정입니다.'});
 const token=newToken(key);cookie(req,res,token);
 res.json({user:u.username,state:db.states[key]||null,isAdmin:!!u.isAdmin,token});
});
app.get('/api/me',(req,res)=>{const key=userFromReq(req);if(!key)return res.status(401).json({error:'로그인이 필요합니다.'});const u=db.users[key];if(u.banned||(db.bans&&db.bans[key]))return res.status(403).json({error:'차단된 계정입니다.'});const token=newToken(key);cookie(req,res,token);res.json({user:publicName(key),state:db.states[key]||null,isAdmin:!!u.isAdmin,token});});
function mergeAdminProtected(key, state){
  const prev = db.states[key] && db.states[key].player;
  if(!prev || !state || !state.player) return state;
  const lockAt = prev._adminLockAt || 0;
  if(Date.now() - lockAt < 120000){
    const pl = state.player;
    if(Number.isFinite(prev._adminLockLv) && (pl.lv|0) < (prev._adminLockLv|0)){
      pl.lv = prev.lv; pl.xp = prev.xp; pl.nx = prev.nx;
      pl.mhp = Math.max(pl.mhp||0, prev.mhp||0);
      pl.hp = Math.min(pl.mhp, Math.max(pl.hp||0, prev.hp||0));
    }
    pl._adminLockAt = prev._adminLockAt;
    pl._adminLockLv = prev._adminLockLv;
    if(prev._adminLockCoinAt && Date.now() - prev._adminLockCoinAt < 120000){
      if((pl.coin|0) < (prev.coin|0)) pl.coin = prev.coin;
      pl._adminLockCoinAt = prev._adminLockCoinAt;
    }
  }
  return state;
}
app.post('/api/save',requireUser,(req,res)=>{
  const state=cleanState(req.body&&req.body.state);
  if(!state)return res.status(400).json({error:'저장 데이터 형식이 올바르지 않습니다.'});
  const merged=mergeAdminProtected(req.userKey, state);
  db.states[req.userKey]=merged; persistSoon();
  res.json({ok:true,savedAt:merged.savedAt, lv:merged.player&&merged.player.lv, coin:merged.player&&merged.player.coin});
});
app.post('/api/save-beacon',(req,res)=>{
  const key=userFromReq(req);if(!key)return res.status(401).end();
  let body=req.body;
  if(typeof body==='string'){try{body=JSON.parse(body);}catch{return res.status(400).end();}}
  const state=cleanState(body&&body.state);if(!state)return res.status(400).end();
  db.states[key]=mergeAdminProtected(key, state); persistSoon();
  res.status(204).end();
});
app.post('/api/logout',(req,res)=>{clearCookie(req,res);res.json({ok:true});});

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


function pushAdminStat(key, patch){
  try{
    for(const ws of wss.clients){
      if(ws._userKey===key && ws.readyState===WebSocket.OPEN){
        try{ ws.send(JSON.stringify(Object.assign({type:'admin_stat'}, patch))); }catch(e){}
      }
    }
  }catch(e){}
}
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
  p.xp=0;
  p.nx=Math.max(30, Math.floor(30*Math.pow(1.15, Math.max(0, lv-1))));
  const base=100;
  p.mhp=Math.max(p.mhp||base, base + (lv-1)*15);
  p.hp=p.mhp;
  p._adminLockAt = Date.now();
  p._adminLockLv = lv;
  db.states[key].savedAt=Date.now();
  try{persist();}catch(e){}
  pushAdminStat(key, {lv:p.lv, xp:p.xp, nx:p.nx, hp:p.hp, mhp:p.mhp, coin:p.coin});
  res.json({ok:true, username:db.users[key].username, lv:p.lv, xp:p.xp, nx:p.nx, coin:p.coin, mhp:p.mhp, hp:p.hp});
});
app.post('/api/admin/give-coin', requireAdmin, (req,res)=>{
  const {username, amount} = req.body||{};
  if(typeof username!=='string') return res.status(400).json({error:'아이디가 필요합니다.'});
  const amt=Math.floor(Number(amount));
  if(!Number.isFinite(amt)||amt===0||Math.abs(amt)>1e9) return res.status(400).json({error:'코인 수량이 올바르지 않습니다.'});
  const key=usernameKey(username);
  if(!db.users[key]) return res.status(404).json({error:'사용자를 찾을 수 없습니다.'});
  const p=ensurePlayer(key);
  p.coin=Math.max(0, Math.floor((p.coin||0)+amt));
  db.states[key].savedAt=Date.now();
  try{persist();}catch(e){}
  pushAdminStat(key, {coin:p.coin, lv:p.lv, xp:p.xp, nx:p.nx, hp:p.hp, mhp:p.mhp});
  res.json({ok:true, username:db.users[key].username, coin:p.coin});
});

// ===================================================================================
//  통계 / 파티 / 길드 / 리더보드  (모두 서버 권한 — 클라이언트는 요청만 보냄)
// ===================================================================================
const PARTY_MAX = 4, PARTY_SHARE_RANGE = 160;
const parties = new Map(), invites = new Map();
let partySeq = 0;
const jerr = (res, text, code) => res.status(code || 400).json({ error: text });

function bumpStat(key, field, n) {
  const u = db.users[key]; if (!u) return;
  const s = u.stats || (u.stats = {});
  s[field] = (s[field] || 0) + n; persistSoon();
}
function sendTo(id, obj) {
  const w = wsById.get(id);
  if (w && w.readyState === WebSocket.OPEN) { try { w.send(JSON.stringify(obj)); } catch {} }
}
const msgTo = (id, text) => sendTo(id, { type: 'p_msg', text });

// ---------------- 파티 ----------------
function partyOf(p) { return p && p.party ? (parties.get(p.party) || null) : null; }
function partyView(pt) {
  return {
    id: pt.id, leader: pt.leader,
    members: pt.members.map(id => { const q = players.get(id); return q ? { id, name: q.name, lv: q.lv || 1, job: q.job || '', hp: Math.ceil(q.hp), mhp: q.mhp } : null; }).filter(Boolean)
  };
}
function pushParty(pt) { const v = partyView(pt); for (const id of pt.members) sendTo(id, { type: 'party', party: v }); }
function partyLeave(p, reason) {
  const pt = partyOf(p);
  if (!pt) { p.party = null; return; }
  pt.members = pt.members.filter(i => i !== p.id); p.party = null;
  if (reason) sendTo(p.id, { type: 'party', party: null, msg: reason });
  if (pt.members.length <= 1) {
    for (const id of pt.members) { const q = players.get(id); if (q) q.party = null; sendTo(id, { type: 'party', party: null, msg: '파티가 해산되었습니다.' }); }
    parties.delete(pt.id);
  } else {
    if (pt.leader === p.id) pt.leader = pt.members[0];
    pushParty(pt);
  }
}

// ---------------- 길드 ----------------
const GUILD_FEE = 10000, GUILD_MIN_LV = 5, GUILD_MAX_LV = 10;
const GNAME = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣 _.\-]{0,10}[A-Za-z0-9가-힣]$/;
const guildChat = new Map();
const gNeed = L => 4000 * L;               // 다음 레벨까지 필요한 길드 경험치
const gMax = L => 15 + L * 3;              // 최대 인원
const gBonus = L => Math.min(GUILD_MAX_LV, L) / 100;   // 길드 레벨 1당 경험치/코인 +1%

function guildOfKey(key) {
  const u = db.users[key]; if (!u || !u.guild) return null;
  const g = db.guilds[u.guild];
  if (!g || !g.members[key]) { delete u.guild; return null; }
  return g;
}
function socketsOf(key) { const out = []; for (const c of wss.clients) if (c._userKey === key && c.readyState === WebSocket.OPEN) out.push(c); return out; }
function userLv(key) {
  for (const c of socketsOf(key)) if (c.player && c.player.lv) return c.player.lv;
  const pl = db.states[key] && db.states[key].player; return (pl && pl.lv | 0) || 1;
}
const uname = k => (db.users[k] ? db.users[k].username : '?');
function guildInfo(g, forKey) {
  const mine = g.members[forKey], mng = mine && (mine.role === 'leader' || mine.role === 'officer');
  const on = new Set(); for (const c of wss.clients) if (c._userKey && c.readyState === WebSocket.OPEN) on.add(c._userKey);
  const ord = { leader: 0, officer: 1, member: 2 };
  const members = Object.entries(g.members).map(([k, v]) => ({ name: uname(k), role: v.role, lv: userLv(k), on: on.has(k) ? 1 : 0, c: v.c | 0 }))
    .sort((a, b) => ord[a.role] - ord[b.role] || b.on - a.on || b.lv - a.lv);
  return {
    id: g.id, name: g.name, level: g.level, exp: g.exp, need: g.level >= GUILD_MAX_LV ? 0 : gNeed(g.level), max: gMax(g.level), bonus: gBonus(g.level),
    notice: g.notice || '', mode: g.mode, leader: uname(g.leader), role: mine ? mine.role : '',
    members, apps: mng ? Object.keys(g.apps || {}).map(k => ({ name: uname(k), lv: userLv(k) })) : [],
    chat: (guildChat.get(g.id) || []).slice(-30)
  };
}
function pushGuild(g) { for (const k of Object.keys(g.members)) for (const c of socketsOf(k)) { try { c.send(JSON.stringify({ type: 'guild', g: guildInfo(g, k) })); } catch {} } }
function setPlayerGuild(key, g) {
  for (const c of socketsOf(key)) {
    if (c.player) { c.player.gn = g ? g.name : ''; broadcast({ type: 'state', player: c.player }); }
    if (!g) { try { c.send(JSON.stringify({ type: 'guild', g: null })); } catch {} }
  }
}
function guildSay(g, text, name) {
  const line = { name: name || '시스템', text, t: Date.now(), sys: name ? 0 : 1 };
  const arr = guildChat.get(g.id) || []; arr.push(line); while (arr.length > 40) arr.shift(); guildChat.set(g.id, arr);
  const raw = JSON.stringify({ type: 'chat', ch: 'guild', name: line.name, text, sys: line.sys });
  for (const k of Object.keys(g.members)) for (const c of socketsOf(k)) { try { c.send(raw); } catch {} }
}
function addGuildExp(g, key, amt) {
  const m = g.members[key]; if (m) m.c = (m.c || 0) + amt;
  persistSoon();
  if (g.level >= GUILD_MAX_LV) { g.exp = 0; return; }
  g.exp += amt; let up = false;
  while (g.level < GUILD_MAX_LV && g.exp >= gNeed(g.level)) { g.exp -= gNeed(g.level); g.level++; up = true; }
  if (up) { guildSay(g, '★ 길드 레벨이 ' + g.level + '(으)로 올랐습니다! (경험치/코인 보너스 +' + Math.round(gBonus(g.level) * 100) + '%)'); pushGuild(g); }
}
function guildCount(g) { return Object.keys(g.members).length; }
function addMember(g, key) {
  for (const o of Object.values(db.guilds)) if (o.apps) delete o.apps[key];
  g.members[key] = { role: 'member', joined: Date.now(), c: 0 }; db.users[key].guild = g.id;
  guildSay(g, uname(key) + ' 님이 길드에 가입했습니다.');
  setPlayerGuild(key, g); pushGuild(g); persistSoon();
}
function removeMember(g, key, why) {
  delete g.members[key]; if (db.users[key]) delete db.users[key].guild;
  guildSay(g, uname(key) + ' 님이 ' + why);
  setPlayerGuild(key, null); pushGuild(g); persistSoon();
}
const cleanText = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0, n);

app.get('/api/guild/me', requireUser, (req, res) => {
  const g = guildOfKey(req.userKey);
  res.json({ guild: g ? guildInfo(g, req.userKey) : null, fee: GUILD_FEE, minLv: GUILD_MIN_LV });
});
app.get('/api/guild/list', requireUser, (req, res) => {
  const q = cleanText(req.query.q, 12).toLowerCase();
  const list = Object.values(db.guilds).filter(g => !q || g.nameKey.includes(q)).sort((a, b) => b.level - a.level || b.exp - a.exp).slice(0, 40)
    .map(g => ({ id: g.id, name: g.name, level: g.level, count: guildCount(g), max: gMax(g.level), mode: g.mode, leader: uname(g.leader), notice: (g.notice || '').slice(0, 40), applied: g.apps && g.apps[req.userKey] ? 1 : 0 }));
  res.json({ guilds: list });
});
app.post('/api/guild/create', requireUser, (req, res) => {
  const key = req.userKey; if (guildOfKey(key)) return jerr(res, '이미 길드에 가입되어 있어요.');
  const name = cleanText(req.body && req.body.name, 12).replace(/\s+/g, ' ');
  if (!GNAME.test(name)) return jerr(res, '길드 이름은 한글/영문/숫자 2~12자로 입력하세요.');
  const nk = name.toLowerCase(); if (Object.values(db.guilds).some(g => g.nameKey === nk)) return jerr(res, '이미 사용 중인 길드 이름이에요.');
  const st = db.states[key] && db.states[key].player;
  if (!st || (st.lv | 0) < GUILD_MIN_LV) return jerr(res, '레벨 ' + GUILD_MIN_LV + ' 이상부터 길드를 만들 수 있어요.');
  if ((st.coin | 0) < GUILD_FEE) return jerr(res, '길드 창설 비용 ' + GUILD_FEE.toLocaleString() + ' 코인이 필요해요.');
  st.coin -= GUILD_FEE; db.states[key].savedAt = Date.now();
  const id = 'G' + crypto.randomBytes(5).toString('hex');
  const g = { id, name, nameKey: nk, leader: key, members: { [key]: { role: 'leader', joined: Date.now(), c: 0 } }, apps: {}, exp: 0, level: 1, notice: '', mode: 'open', created: Date.now() };
  db.guilds[id] = g; db.users[key].guild = id; persistSoon();
  setPlayerGuild(key, g); pushGuild(g);
  res.json({ ok: true, fee: GUILD_FEE, guild: guildInfo(g, key) });
});
app.post('/api/guild/join', requireUser, (req, res) => {
  const key = req.userKey; if (guildOfKey(key)) return jerr(res, '이미 길드에 가입되어 있어요.');
  const g = db.guilds[String((req.body && req.body.id) || '')]; if (!g) return jerr(res, '존재하지 않는 길드예요.');
  if (guildCount(g) >= gMax(g.level)) return jerr(res, '길드 인원이 가득 찼어요.');
  if (g.mode === 'open') { addMember(g, key); return res.json({ ok: true, joined: true, guild: guildInfo(g, key) }); }
  g.apps = g.apps || {};
  if (Object.keys(g.apps).length >= 30 && !g.apps[key]) return jerr(res, '가입 신청이 너무 많아요. 나중에 다시 시도하세요.');
  g.apps[key] = Date.now(); persistSoon(); pushGuild(g);
  res.json({ ok: true, applied: true });
});
function myGuildMng(req, res, leaderOnly) {
  const g = guildOfKey(req.userKey); if (!g) { jerr(res, '길드에 가입되어 있지 않아요.'); return null; }
  const r = g.members[req.userKey].role;
  if (leaderOnly ? r !== 'leader' : r === 'member') { jerr(res, leaderOnly ? '길드장만 할 수 있어요.' : '길드장/부길드장만 할 수 있어요.', 403); return null; }
  return g;
}
const targetKey = (req) => usernameKey(cleanText(req.body && req.body.user, 24));
app.post('/api/guild/handle', requireUser, (req, res) => {
  const g = myGuildMng(req, res, false); if (!g) return;
  const tk = targetKey(req); if (!g.apps || !g.apps[tk]) return jerr(res, '신청 내역이 없어요.');
  delete g.apps[tk];
  if (req.body.ok) {
    if (!db.users[tk]) return jerr(res, '존재하지 않는 사용자예요.');
    if (guildOfKey(tk)) return jerr(res, '이미 다른 길드에 가입한 사용자예요.');
    if (guildCount(g) >= gMax(g.level)) return jerr(res, '길드 인원이 가득 찼어요.');
    addMember(g, tk);
  } else { persistSoon(); pushGuild(g); }
  res.json({ ok: true });
});
app.post('/api/guild/leave', requireUser, (req, res) => {
  const g = guildOfKey(req.userKey); if (!g) return jerr(res, '길드에 가입되어 있지 않아요.');
  if (g.leader === req.userKey) {
    if (guildCount(g) > 1) return jerr(res, '길드장은 다른 사람에게 위임한 뒤 탈퇴할 수 있어요. (혼자라면 길드 해산)');
    return jerr(res, '혼자 남은 길드장은 "길드 해산"을 사용하세요.');
  }
  removeMember(g, req.userKey, '길드를 떠났습니다.'); res.json({ ok: true });
});
app.post('/api/guild/kick', requireUser, (req, res) => {
  const g = myGuildMng(req, res, false); if (!g) return;
  const tk = targetKey(req), t = g.members[tk]; if (!t) return jerr(res, '길드원이 아니에요.');
  if (tk === req.userKey) return jerr(res, '자기 자신은 추방할 수 없어요.');
  const myRole = g.members[req.userKey].role;
  if (t.role === 'leader' || (t.role === 'officer' && myRole !== 'leader')) return jerr(res, '권한이 부족해요.', 403);
  removeMember(g, tk, '길드에서 추방되었습니다.'); res.json({ ok: true });
});
app.post('/api/guild/role', requireUser, (req, res) => {
  const g = myGuildMng(req, res, true); if (!g) return;
  const tk = targetKey(req), t = g.members[tk], role = req.body.role;
  if (!t || tk === req.userKey) return jerr(res, '대상이 올바르지 않아요.');
  if (role !== 'officer' && role !== 'member') return jerr(res, '직책이 올바르지 않아요.');
  if (role === 'officer' && Object.values(g.members).filter(m => m.role === 'officer').length >= 5) return jerr(res, '부길드장은 최대 5명이에요.');
  t.role = role; guildSay(g, uname(tk) + ' 님이 ' + (role === 'officer' ? '부길드장' : '길드원') + '이(가) 되었습니다.'); pushGuild(g); persistSoon(); res.json({ ok: true });
});
app.post('/api/guild/transfer', requireUser, (req, res) => {
  const g = myGuildMng(req, res, true); if (!g) return;
  const tk = targetKey(req), t = g.members[tk]; if (!t || tk === req.userKey) return jerr(res, '대상이 올바르지 않아요.');
  g.members[req.userKey].role = 'officer'; t.role = 'leader'; g.leader = tk;
  guildSay(g, uname(tk) + ' 님이 새 길드장이 되었습니다.'); pushGuild(g); persistSoon(); res.json({ ok: true });
});
app.post('/api/guild/notice', requireUser, (req, res) => {
  const g = myGuildMng(req, res, false); if (!g) return;
  g.notice = cleanText(req.body && req.body.text, 80); pushGuild(g); persistSoon(); res.json({ ok: true });
});
app.post('/api/guild/mode', requireUser, (req, res) => {
  const g = myGuildMng(req, res, true); if (!g) return;
  g.mode = req.body && req.body.mode === 'approval' ? 'approval' : 'open'; pushGuild(g); persistSoon(); res.json({ ok: true, mode: g.mode });
});
app.post('/api/guild/disband', requireUser, (req, res) => {
  const g = myGuildMng(req, res, true); if (!g) return;
  const keys = Object.keys(g.members);
  delete db.guilds[g.id]; guildChat.delete(g.id);
  for (const k of keys) { if (db.users[k]) delete db.users[k].guild; setPlayerGuild(k, null); }
  persistSoon(); res.json({ ok: true });
});

// ---------------- 리더보드 ----------------
let _lb = null, _lbT = 0;
function buildBoards() {
  const on = new Set(); for (const c of wss.clients) if (c._userKey) on.add(c._userKey);
  const people = [];
  for (const [key, u] of Object.entries(db.users)) {
    if (u.isAdmin || u.banned || (db.bans && db.bans[key])) continue;
    const pl = (db.states[key] && db.states[key].player) || {}, s = u.stats || {}, g = guildOfKey(key);
    people.push({ key, name: u.username, lv: (pl.lv | 0) || 1, xp: pl.xp | 0, coin: pl.coin | 0, kills: s.kills | 0, boss: s.boss | 0, wb: s.wb | 0, job: pl.job || '', gn: g ? g.name : '', on: on.has(key) ? 1 : 0, tower: pl.towerBest | 0, rebirth: pl.rebirth | 0 });
  }
  const by = f => people.slice().sort(f);
  const B = {
    lv: by((a, b) => b.lv - a.lv || b.xp - a.xp), coin: by((a, b) => b.coin - a.coin), kills: by((a, b) => b.kills - a.kills),
    boss: by((a, b) => b.boss - a.boss || b.kills - a.kills), wb: by((a, b) => b.wb - a.wb),
    tower: by((a, b) => b.tower - a.tower || b.lv - a.lv), rebirth: by((a, b) => b.rebirth - a.rebirth || b.lv - a.lv)
  };
  const guilds = Object.values(db.guilds).map(g => ({ id: g.id, name: g.name, level: g.level, exp: g.exp, count: guildCount(g), leader: uname(g.leader) }))
    .sort((a, b) => b.level - a.level || b.exp - a.exp || b.count - a.count);
  return { B, guilds };
}
const LB_FMT = { lv: p => 'Lv.' + p.lv, coin: p => p.coin.toLocaleString('ko-KR'), kills: p => p.kills.toLocaleString('ko-KR') + '마리', boss: p => p.boss + '회', wb: p => p.wb.toLocaleString('ko-KR'), tower: p => p.tower + '층', rebirth: p => p.rebirth + '회' };
app.get('/api/leaderboard', requireUser, (req, res) => {
  const now = Date.now(); if (!_lb || now - _lbT > 5000) { _lb = buildBoards(); _lbT = now; }
  const type = String(req.query.type || 'lv'), mk = req.userKey;
  if (type === 'guild') {
    const g = guildOfKey(mk), i = g ? _lb.guilds.findIndex(x => x.id === g.id) : -1;
    return res.json({ type, rows: _lb.guilds.slice(0, 50).map((x, n) => ({ rank: n + 1, name: x.name, value: 'Lv.' + x.level, sub: x.count + '명 · 길드장 ' + x.leader, mine: g && g.id === x.id ? 1 : 0 })), me: i >= 0 ? { rank: i + 1, value: 'Lv.' + g.level } : null });
  }
  const list = _lb.B[type]; if (!list) return jerr(res, '알 수 없는 순위예요.');
  const f = LB_FMT[type], i = list.findIndex(p => p.key === mk);
  res.json({ type, rows: list.slice(0, 50).map((p, n) => ({ rank: n + 1, name: p.name, value: f(p), job: p.job, lv: p.lv, gn: p.gn, on: p.on, mine: p.key === mk ? 1 : 0 })), me: i >= 0 ? { rank: i + 1, value: f(list[i]) } : null, total: list.length });
});


// ===== 장비 강화 (+1~+15) =====
const ENH_MAT = {
  // 단계별 필요 재료 id, 수량, 골드 배수 기준
  w: [
    null,
    { mat: 'gtooth', n: 2, gold: 50 },
    { mat: 'tusk', n: 2, gold: 120 },
    { mat: 'bone', n: 3, gold: 250 },
    { mat: 'essence', n: 2, gold: 500 },
    { mat: 'core', n: 1, gold: 900 },
    { mat: 'dshard', n: 1, gold: 1800 },
    { mat: 'hfang', n: 2, gold: 3500 },
    { mat: 'dscale', n: 1, gold: 7000 },
    { mat: 'dscale', n: 2, gold: 14000 },
    { mat: 'tkd', n: 1, gold: 28000 },
    { mat: 'tk5', n: 1, gold: 50000 },
    { mat: 'wscale', n: 1, gold: 90000 },
    { mat: 'wscale', n: 2, gold: 160000 },
    { mat: 'wscale', n: 3, gold: 280000 },
    { mat: 'wscale', n: 5, gold: 500000 }
  ],
  a: [
    null,
    { mat: 'hide', n: 2, gold: 50 },
    { mat: 'fur', n: 3, gold: 120 },
    { mat: 'bandage', n: 2, gold: 250 },
    { mat: 'ooze', n: 2, gold: 500 },
    { mat: 'core', n: 1, gold: 900 },
    { mat: 'dshard', n: 1, gold: 1800 },
    { mat: 'flamecore', n: 1, gold: 3500 },
    { mat: 'dscale', n: 1, gold: 7000 },
    { mat: 'dscale', n: 2, gold: 14000 },
    { mat: 'tk5', n: 1, gold: 28000 },
    { mat: 'tk9', n: 1, gold: 50000 },
    { mat: 'wscale', n: 1, gold: 90000 },
    { mat: 'wscale', n: 2, gold: 160000 },
    { mat: 'wscale', n: 3, gold: 280000 },
    { mat: 'wscale', n: 5, gold: 500000 }
  ]
};
// +1~+5: 100%, +6:90%, +7:80%, +8:70%, +9:55%, +10:40%, +11:30%, +12:22%, +13:15%, +14:10%, +15:6%
const ENH_RATE = [1,1,1,1,1,1,0.9,0.8,0.7,0.55,0.4,0.3,0.22,0.15,0.1,0.06];
function enhAtkBonus(lv) { return lv <= 0 ? 0 : Math.floor(lv * 3 + Math.pow(lv, 1.35)); }
function enhHpBonus(lv) { return lv <= 0 ? 0 : Math.floor(lv * 8 + Math.pow(lv, 1.4) * 2); }

app.post('/api/enhance', requireUser, (req, res) => {
  const body = req.body || {};
  const slot = body.slot; // 'w' | 'a'
  if (slot !== 'w' && slot !== 'a') return res.status(400).json({ error: '강화 대상이 올바르지 않습니다.' });
  const player = ensurePlayer(req.userKey);
  const cur = slot === 'w' ? (player.we || 0) : (player.ae || 0);
  if (cur >= 15) return res.status(400).json({ error: '이미 최대 강화(+15)입니다.' });
  const next = cur + 1;
  const need = ENH_MAT[slot][next];
  if (!need) return res.status(400).json({ error: '강화 정보가 없습니다.' });
  const items = player.items || (player.items = {});
  const have = items[need.mat] || 0;
  if (have < need.n) return res.status(400).json({ error: '재료가 부족합니다.', mat: need.mat, need: need.n, have });
  if ((player.coin || 0) < need.gold) return res.status(400).json({ error: '코인이 부족합니다.', need: need.gold, have: player.coin || 0 });
  items[need.mat] = have - need.n;
  player.coin -= need.gold;
  const rate = ENH_RATE[next] || 0.05;
  const ok = Math.random() < rate;
  let result = 'success', newLv = cur;
  if (ok) {
    newLv = next;
    if (slot === 'w') player.we = newLv; else player.ae = newLv;
  } else {
    // +6 이상 실패 시 1단계 하락 (단 +5 이하는 유지)
    if (cur >= 5) {
      newLv = Math.max(5, cur - 1);
      result = 'down';
    } else {
      newLv = cur;
      result = 'fail';
    }
    if (slot === 'w') player.we = newLv; else player.ae = newLv;
  }
  db.states[req.userKey].savedAt = Date.now();
  try {
    persist();
    res.json({
      ok: true, result, slot, level: newLv, prev: cur, rate,
      coin: player.coin, items: player.items, we: player.we || 0, ae: player.ae || 0,
      atkBonus: enhAtkBonus(player.we || 0), hpBonus: enhHpBonus(player.ae || 0)
    });
  } catch (e) { res.status(500).json({ error: '저장 실패' }); }
});
app.get('/api/enhance/info', requireUser, (req, res) => {
  const player = ensurePlayer(req.userKey);
  res.json({
    we: player.we || 0, ae: player.ae || 0,
    atkBonus: enhAtkBonus(player.we || 0), hpBonus: enhHpBonus(player.ae || 0),
    rates: ENH_RATE, mats: { w: ENH_MAT.w, a: ENH_MAT.a },
    items: player.items || {}
  });
});


// ===== 환생 / 특성 / 룬 / 무한의 탑 =====
const REBIRTH_MIN_LV = 100;
const REBIRTH_TITLES = ['','환생자','각성자','초월자','영겁','무한'];
const TALENT_DEFS = {
  // id: {tree, max, cost per level (points)}
  atk_crit:  {tree:'atk', max:5, cost:1, name:'치명타 강화'},
  atk_dash:  {tree:'atk', max:3, cost:2, name:'대쉬 크리'},
  atk_skill: {tree:'atk', max:5, cost:1, name:'스킬 위력'},
  def_hp:    {tree:'def', max:5, cost:1, name:'체력 강화'},
  def_shield:{tree:'def', max:3, cost:2, name:'위기 보호막'},
  def_dr:    {tree:'def', max:5, cost:1, name:'피해 감소'},
  util_cd:   {tree:'util',max:5, cost:1, name:'쿨타임 감소'},
  util_spd:  {tree:'util',max:3, cost:2, name:'이동 속도'},
  util_loot: {tree:'util',max:3, cost:2, name:'행운'}
};
const RUNE_POOL = [
  {id:'r_crit', name:'치명 룬', opt:'crit', val:5, slot:'w'},
  {id:'r_atk', name:'강타 룬', opt:'atk', val:8, slot:'w'},
  {id:'r_fire', name:'화염 룬', opt:'fire', val:12, slot:'w'},
  {id:'r_hp', name:'생명 룬', opt:'hp', val:40, slot:'a'},
  {id:'r_dr', name:'수호 룬', opt:'dr', val:4, slot:'a'},
  {id:'r_cd', name:'신속 룬', opt:'cd', val:6, slot:'u'},
  {id:'r_spd', name:'질주 룬', opt:'spd', val:8, slot:'u'},
  {id:'r_lifesteal', name:'흡혈 룬', opt:'ls', val:3, slot:'w'},
  {id:'r_shield', name:'보호 룬', opt:'shield', val:1, slot:'a'},
  {id:'r_exp', name:'경험 룬', opt:'exp', val:10, slot:'u'}
];
function genRuneId(){ return 'R'+crypto.randomBytes(4).toString('hex'); }
function rollRune(){
  const base = RUNE_POOL[(Math.random()*RUNE_POOL.length)|0];
  const mult = Math.random()<.12 ? 1.5 : Math.random()<.35 ? 1.25 : 1;
  return { id: genRuneId(), base: base.id, name: base.name, opt: base.opt, val: Math.round(base.val*mult), slot: base.slot, tier: mult>=1.5?3:mult>=1.25?2:1 };
}
function talentSpent(talents){
  let s=0; for(const [k,v] of Object.entries(talents||{})){ const d=TALENT_DEFS[k]; if(d) s+=(v|0)*d.cost; }
  return s;
}
function expectedTalentPts(p){
  // 레벨당 0.5 + 환생당 5
  return Math.floor(Math.max(0,(p.lv|0)-1)/2) + (p.rebirth|0)*5;
}

app.post('/api/rebirth', requireUser, (req, res) => {
  const p = ensurePlayer(req.userKey);
  if ((p.lv|0) < REBIRTH_MIN_LV) return res.status(400).json({ error: '환생은 Lv.'+REBIRTH_MIN_LV+' 이상부터 가능합니다.', need: REBIRTH_MIN_LV, lv: p.lv });
  p.rebirth = (p.rebirth|0) + 1;
  p.rcoin = (p.rcoin|0) + (10 + p.rebirth * 5);
  p.title = REBIRTH_TITLES[Math.min(REBIRTH_TITLES.length-1, p.rebirth)] || '환생자';
  p.lv = 1; p.xp = 0; p.nx = 30;
  p.mhp = 100 + (p.ae?0:0); // base; client recalcs with armor/enhance
  p.hp = p.mhp;
  // 특성 포인트 보너스
  p.talentPts = expectedTalentPts(p);
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); } catch(e) {}
  pushAdminStat(req.userKey, { lv:p.lv, xp:p.xp, nx:p.nx, hp:p.hp, mhp:p.mhp, coin:p.coin });
  res.json({ ok:true, rebirth:p.rebirth, rcoin:p.rcoin, title:p.title, lv:p.lv, xp:p.xp, nx:p.nx, talentPts:p.talentPts });
});

app.post('/api/talent', requireUser, (req, res) => {
  const body = req.body || {};
  const id = String(body.id||'');
  const def = TALENT_DEFS[id];
  if (!def) return res.status(400).json({ error: '존재하지 않는 특성입니다.' });
  const p = ensurePlayer(req.userKey);
  // 포인트 재계산(치트 방지): 기대 포인트 - 이미 투자
  const expect = expectedTalentPts(p);
  const spent = talentSpent(p.talents);
  let avail = Math.max(0, expect - spent);
  // 저장된 talentPts와 동기
  p.talentPts = avail;
  const cur = (p.talents[id]|0);
  if (cur >= def.max) return res.status(400).json({ error: '이미 최대 레벨입니다.' });
  if (avail < def.cost) return res.status(400).json({ error: '특성 포인트가 부족합니다.', need: def.cost, have: avail });
  p.talents[id] = cur + 1;
  p.talentPts = avail - def.cost;
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); } catch(e) {}
  res.json({ ok:true, id, level: p.talents[id], talents: p.talents, talentPts: p.talentPts });
});
app.post('/api/talent/reset', requireUser, (req, res) => {
  const p = ensurePlayer(req.userKey);
  const cost = 500;
  if ((p.coin|0) < cost) return res.status(400).json({ error: '초기화에 🪙'+cost+'이 필요합니다.' });
  p.coin -= cost;
  p.talents = {};
  p.talentPts = expectedTalentPts(p);
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); } catch(e) {}
  res.json({ ok:true, talents:{}, talentPts:p.talentPts, coin:p.coin });
});

app.post('/api/rune/equip', requireUser, (req, res) => {
  const body = req.body || {};
  const runeId = String(body.runeId||'');
  const slot = body.slot; // w|a|u
  if (!['w','a','u'].includes(slot)) return res.status(400).json({ error: '슬롯이 올바르지 않습니다.' });
  const p = ensurePlayer(req.userKey);
  if (!runeId) { p.runeEq[slot] = null; }
  else {
    const r = (p.runes||[]).find(x => x.id === runeId);
    if (!r) return res.status(400).json({ error: '보유하지 않은 룬입니다.' });
    if (r.slot !== slot) return res.status(400).json({ error: '이 룬은 '+({w:'무기',a:'방어구',u:'유틸'}[r.slot])+' 슬롯 전용입니다.' });
    p.runeEq[slot] = runeId;
  }
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); } catch(e) {}
  res.json({ ok:true, runeEq: p.runeEq });
});

// 보스 처치 시 룬 드랍 (applyPlayerHit 보상 루프에서 호출)
function tryDropRune(ws, m, d) {
  if (!d.boss || !ws || !ws._userKey) return;
  const chance = m.type === 'worldboss' ? 0.35 : m.type === 'dragon' || m.type === 'demonlord' ? 0.18 : 0.08;
  if (Math.random() > chance) return;
  const p = ensurePlayer(ws._userKey);
  if ((p.runes||[]).length >= 40) return;
  const rune = rollRune();
  p.runes.push(rune);
  db.states[ws._userKey].savedAt = Date.now();
  persistSoon();
  try { ws.send(JSON.stringify({ type: 'rune_drop', rune })); } catch {}
}

// 무한의 탑
const towerSessions = new Map(); // userKey -> { floor, started, killsNeed, kills, boss }
function towerScale(floor) {
  const f = Math.max(1, floor|0);
  return {
    hp: Math.floor(80 * Math.pow(1.18, f-1)),
    dmg: Math.floor(8 * Math.pow(1.12, f-1)),
    n: Math.min(20, 3 + Math.floor(f/5)),
    boss: f % 5 === 0,
    xp: Math.floor(20 * Math.pow(1.15, f-1)),
    coin: Math.floor(15 * Math.pow(1.12, f-1))
  };
}
app.post('/api/tower/enter', requireUser, (req, res) => {
  const p = ensurePlayer(req.userKey);
  const floor = Math.max(1, Math.min((p.towerBest|0)+1, Math.floor(Number(req.body&&req.body.floor)||1)));
  if (floor > (p.towerBest|0)+1) return res.status(400).json({ error: '아직 도전할 수 없는 층입니다.', max: (p.towerBest|0)+1 });
  const sc = towerScale(floor);
  const sess = { floor, started: Date.now(), killsNeed: sc.boss ? 1 : sc.n, kills: 0, boss: !!sc.boss, sc };
  towerSessions.set(req.userKey, sess);
  res.json({ ok:true, floor, ...sc, killsNeed: sess.killsNeed });
});
app.post('/api/tower/kill', requireUser, (req, res) => {
  const sess = towerSessions.get(req.userKey);
  if (!sess) return res.status(400).json({ error: '탑에 입장하지 않았습니다.' });
  if (Date.now() - sess.started > 600000) { towerSessions.delete(req.userKey); return res.status(400).json({ error: '세션 만료. 다시 입장하세요.' }); }
  // 초당 킬 제한
  const now = Date.now();
  if (!sess._kt) sess._kt = now;
  if (now - sess._kt < 400) return res.json({ ok:true, kills: sess.kills, need: sess.killsNeed, progress: false });
  sess._kt = now;
  sess.kills++;
  const done = sess.kills >= sess.killsNeed;
  res.json({ ok:true, kills: sess.kills, need: sess.killsNeed, progress: true, clearReady: done });
});
app.post('/api/tower/clear', requireUser, (req, res) => {
  const sess = towerSessions.get(req.userKey);
  if (!sess) return res.status(400).json({ error: '탑에 입장하지 않았습니다.' });
  if (sess.kills < sess.killsNeed) return res.status(400).json({ error: '아직 클리어 조건 미달', kills: sess.kills, need: sess.killsNeed });
  const p = ensurePlayer(req.userKey);
  const floor = sess.floor;
  const sc = sess.sc;
  p.coin = (p.coin|0) + sc.coin;
  p.xp = (p.xp|0) + sc.xp;
  if (floor > (p.towerBest|0)) p.towerBest = floor;
  towerSessions.delete(req.userKey);
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); } catch(e) {}
  // 다음 층 자동 입장 가능
  res.json({ ok:true, floor, coin: p.coin, xp: p.xp, towerBest: p.towerBest, reward: { coin: sc.coin, xp: sc.xp }, next: floor+1 });
});
app.post('/api/tower/daily', requireUser, (req, res) => {
  const p = ensurePlayer(req.userKey);
  const day = Math.floor(Date.now()/86400000);
  if ((p.towerDailyAt|0) === day) return res.status(400).json({ error: '오늘 이미 일일 보상을 받았습니다.' });
  const best = p.towerBest|0;
  if (best < 1) return res.status(400).json({ error: '탑 1층 이상 클리어 후 받을 수 있습니다.' });
  const coin = 100 + best * 25;
  const rcoin = Math.floor(best / 10);
  p.coin = (p.coin|0) + coin;
  p.rcoin = (p.rcoin|0) + rcoin;
  p.towerDailyAt = day;
  p.towerDaily = best;
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); } catch(e) {}
  res.json({ ok:true, coin, rcoin, towerBest: best, totalCoin: p.coin, totalRcoin: p.rcoin });
});
app.get('/api/tower/info', requireUser, (req, res) => {
  const p = ensurePlayer(req.userKey);
  const day = Math.floor(Date.now()/86400000);
  res.json({
    towerBest: p.towerBest|0, rebirth: p.rebirth|0, rcoin: p.rcoin|0, title: p.title||'',
    talentPts: Math.max(0, expectedTalentPts(p) - talentSpent(p.talents)),
    talents: p.talents||{}, runes: p.runes||[], runeEq: p.runeEq||{},
    dailyClaimed: (p.towerDailyAt|0)===day, nextFloor: (p.towerBest|0)+1,
    talentDefs: TALENT_DEFS, runePool: RUNE_POOL
  });
});

// 환생 상점
const RSHOP = [
  { id:'raura', name:'환생 아우라', cost:30, type:'flag' },
  { id:'rpot', name:'환생 엘릭서 x3', cost:15, type:'pot', n:3 },
  { id:'rboost', name:'영구 공격 +5%', cost:50, type:'perm', key:'rAtk' },
  { id:'rhp', name:'영구 체력 +5%', cost:50, type:'perm', key:'rHp' }
];
app.post('/api/rebirth/shop', requireUser, (req, res) => {
  const id = String((req.body&&req.body.id)||'');
  const item = RSHOP.find(x=>x.id===id);
  if (!item) return res.status(400).json({ error: '상품이 없습니다.' });
  const p = ensurePlayer(req.userKey);
  if ((p.rebirth|0) < 1) return res.status(400).json({ error: '환생 후 이용 가능합니다.' });
  if ((p.rcoin|0) < item.cost) return res.status(400).json({ error: '환생 코인이 부족합니다.', need: item.cost, have: p.rcoin|0 });
  p.rcoin -= item.cost;
  if (!p.items) p.items={};
  if (item.type==='flag') p.items['raura'] = 1;
  else if (item.type==='pot') { p.pot[3] = (p.pot[3]|0) + item.n; }
  else if (item.type==='perm') { p.items[item.key] = (p.items[item.key]|0) + 1; }
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); } catch(e) {}
  res.json({ ok:true, rcoin:p.rcoin, items:p.items, pot:p.pot });
});

app.get('/healthz',(_req,res)=>res.json({ok:true, monsters:monsters.size}));
app.use(express.static(path.join(__dirname,'public'),{index:'index.html',dotfiles:'deny',maxAge:'1h',setHeaders(res,p){if(p.endsWith('.html'))res.setHeader('Cache-Control','no-cache');res.setHeader('X-Content-Type-Options','nosniff');}}));
app.use((err,_req,res,_next)=>{if(res.headersSent)return;res.status(400).json({error:'요청을 처리할 수 없습니다.'});});

const wss=new WebSocketServer({noServer:true,maxPayload:8192,perMessageDeflate:false});
let server = null;
const players=new Map(), socketsByIp=new Map(), wsById=new Map();

function allowedOrigin(origin,req){if(!origin)return false;if(ALLOWED_ORIGINS.has(origin))return true;try{const u=new URL(origin),secure=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https';return u.host===req.headers.host&&u.protocol===(secure?'https:':'http:');}catch{return false;}}
function broadcast(data,except){const raw=JSON.stringify(data);for(const c of wss.clients)if(c!==except&&c.readyState===WebSocket.OPEN)try{c.send(raw);}catch{}}
function broadcastAll(data){const raw=JSON.stringify(data);for(const c of wss.clients)if(c.readyState===WebSocket.OPEN)try{c.send(raw);}catch{}}

function userFromWsReq(req){
  let key=null;
  try{const item=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('rpg_session='));
    if(item)key=userFromToken(decodeURIComponent(item.slice('rpg_session='.length)));}catch{}
  if(!key){try{const t=new URL(req.url,'http://localhost').searchParams.get('t');if(t)key=userFromToken(t);}catch{}}
  return key?{ key, username: db.users[key].username }:null;
}

function attachUpgrade(server){server.on('upgrade',(req,socket,head)=>{
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
}

wss.on('connection',ws=>{
  ws.isAlive=true; ws.last=0;
  const id=crypto.randomUUID();
  // 회원가입/로그인 닉네임이 있으면 그 이름, 없으면 익명
  const displayName = ws._username || ('플레이어-'+id.slice(0,4));
  const p={id, name:displayName, x:0, z:8, y:0, face:0, pvp:false, hp:100, mhp:100, lv:1, job:'', gn:''};
  { const gg=ws._userKey?guildOfKey(ws._userKey):null; p.gn=gg?gg.name:''; }
  Object.defineProperty(p,'invTill',{value:0,writable:true,enumerable:false});   // 서버 전용(브로드캐스트 제외)
  Object.defineProperty(p,'party',{value:null,writable:true,enumerable:false});
  Object.defineProperty(p,'key',{value:ws._userKey||null,writable:true,enumerable:false});
  players.set(id,p); ws.player=p; wsById.set(id,ws);
  ws._tokens=40; ws._tokT=Date.now();

  // 접속 시: 다른 플레이어 + 서버 몬스터 전체 상태 전송
  ws._seen=new Map();
  for(const m of monsters.values()) ws._seen.set(m.id,m.ver);
  ws.send(JSON.stringify({
    type:'welcome',
    id,
    name: displayName,
    authed: !!ws._userKey,
    players:[...players.values()].filter(x=>x.id!==id),
    monsters: monsterSnapshot()
  }));
  { const gg=ws._userKey?guildOfKey(ws._userKey):null; if(gg){ try{ws.send(JSON.stringify({type:'guild',g:guildInfo(gg,ws._userKey)}));}catch{} } }
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
      if(Number.isFinite(m.lv)) p.lv=Math.max(1,Math.min(999,Math.floor(m.lv)));
      if(typeof m.job==='string'&&/^[a-z_]{0,24}$/.test(m.job)) p.job=m.job;
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

        // ---------- 플레이어 목록 / 파티 / 채팅 (서버 권한) ----------
    if(m.type==='plist'){
      if(now-(ws._plT||0)<700) return; ws._plT=now;
      const list=[...players.values()].map(q=>({id:q.id,name:q.name,lv:q.lv||1,job:q.job||'',gn:q.gn||'',inParty:q.party?1:0,self:q.id===p.id?1:0}));
      try{ws.send(JSON.stringify({type:'plist',list}));}catch{}
      return;
    }
    if(m.type==='p_invite'){
      if(typeof m.to!=='string') return;
      if(now-(ws._invT||0)<1200) return; ws._invT=now;
      const tp=players.get(m.to);
      if(!tp||tp.id===p.id) return msgTo(p.id,'초대할 수 없는 대상이에요.');
      const mine=partyOf(p);
      if(mine&&mine.leader!==p.id) return msgTo(p.id,'파티장만 초대할 수 있어요.');
      if(mine&&mine.members.length>=PARTY_MAX) return msgTo(p.id,'파티가 가득 찼어요. (최대 '+PARTY_MAX+'명)');
      if(tp.party) return msgTo(p.id,tp.name+' 님은 이미 파티에 있어요.');
      const pend=invites.get(tp.id);
      if(pend&&pend.from===p.id&&now-pend.t<30000) return msgTo(p.id,'이미 초대를 보냈어요.');
      invites.set(tp.id,{from:p.id,t:now});
      sendTo(tp.id,{type:'p_invited',from:{id:p.id,name:p.name,lv:p.lv||1,job:p.job||''},ttl:30});
      msgTo(p.id,tp.name+' 님에게 파티 초대를 보냈어요.');
      return;
    }
    if(m.type==='p_reply'){
      const inv=invites.get(p.id);
      if(!inv||inv.from!==m.from) return;
      invites.delete(p.id);
      const hp=players.get(inv.from);
      if(!m.ok){ if(hp) msgTo(hp.id,p.name+' 님이 초대를 거절했어요.'); return; }
      if(!hp||now-inv.t>31000) return msgTo(p.id,'초대가 만료되었어요.');
      if(p.party) return msgTo(p.id,'이미 파티에 참가 중이에요.');
      let pt=partyOf(hp);
      if(!pt){ pt={id:'P'+(++partySeq),leader:hp.id,members:[hp.id]}; parties.set(pt.id,pt); hp.party=pt.id; }
      if(pt.members.length>=PARTY_MAX) return msgTo(p.id,'파티가 가득 찼어요.');
      pt.members.push(p.id); p.party=pt.id;
      pushParty(pt);
      for(const id of pt.members) msgTo(id,p.name+' 님이 파티에 참가했어요. (경험치·코인 50% 공유)');
      return;
    }
    if(m.type==='p_leave'){ partyLeave(p,'파티에서 나왔어요.'); return; }
    if(m.type==='p_kick'){
      const pt=partyOf(p); if(!pt||pt.leader!==p.id||typeof m.id!=='string'||m.id===p.id) return;
      const t=players.get(m.id); if(!t||t.party!==pt.id) return;
      partyLeave(t,'파티에서 추방되었어요.');
      return;
    }
    if(m.type==='chat'){
      if(now-(ws._chatT||0)<600) return; ws._chatT=now;
      const text=String(m.text==null?'':m.text).replace(/[\u0000-\u001f\u007f<>]/g,' ').trim().slice(0,120);
      if(!text) return;
      if(m.ch==='party'){
        const pt=partyOf(p); if(!pt) return;
        for(const id of pt.members) sendTo(id,{type:'chat',ch:'party',name:p.name,text});
      } else if(m.ch==='guild'){
        const g=ws._userKey?guildOfKey(ws._userKey):null; if(!g) return;
        guildSay(g,text,p.name);
      }
      return;
    }

    // 몬스터 타격: {type:'hit', list:[[몬스터id, 피해, 넉백], ...]} — 체력/사망/보상은 서버가 결정
    if(m.type==='hit'){
      if(!Array.isArray(m.list)||m.list.length>60) return;
      // 초당 타격 수 제한 (매크로/조작 완화)
      if(now-(ws._hitT||0)>=1000){ws._hitT=now;ws._hitN=0;}
      for(const h of m.list){
        if(!Array.isArray(h)||++ws._hitN>240) break;
        applyPlayerHit(p,ws,h[0],Number(h[1]),h[2],h[3]);
      }
      return;
    }
  });

  ws.on('close',()=>{
    try{ partyLeave(p,''); invites.delete(p.id); for(const [to,iv] of invites) if(iv.from===p.id) invites.delete(to); }catch{}
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

setInterval(()=>{ try{ for(const pt of parties.values()) pushParty(pt); }catch(e){ console.error('party tick error:',e); } },1000);
process.on('SIGTERM', () => {
  const done = () => { disconnectFromMongoDB().finally(() => { if (server) server.close(() => process.exit(0)); else process.exit(0); }); };
  persist().then(done).catch(done);
});
process.on('SIGINT', () => {
  const done = () => { disconnectFromMongoDB().finally(() => { if (server) server.close(() => process.exit(0)); else process.exit(0); }); };
  persist().then(done).catch(done);
});

(async () => {
  try {
    await connectMongo();
  } catch (e) {
    console.error('MongoDB connection failed:', e.message);
    process.exit(1);
  }
  try { await seedAdmin(); } catch (e) { console.error('seedAdmin', e.message); }
  server = app.listen(PORT, HOST, () => {
    console.log(`RPG server listening on ${HOST}:${PORT}; mongo=${MONGO_DB_NAME}`);
  });
  server.on('close', () => { for (const ws of wss.clients) ws.terminate(); });
  attachUpgrade(server);
})();
