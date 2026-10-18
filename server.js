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
let db = { users: {}, states: {}, guilds: {}, bans: {}, mapOverrides: { version:1, objects:[], equipment:{} } };
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
    db.mapOverrides = doc.mapOverrides && typeof doc.mapOverrides === 'object' ? doc.mapOverrides : { version:1, objects:[], equipment:{} };
    console.log('MongoDB loaded: users=%d states=%d guilds=%d overrides=%d equip=%d', Object.keys(db.users).length, Object.keys(db.states).length, Object.keys(db.guilds).length, (db.mapOverrides.objects||[]).length, Object.keys(db.mapOverrides.equipment||{}).length);
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
  if (!db.mapOverrides || typeof db.mapOverrides !== 'object') db.mapOverrides = { version:1, objects:[], equipment:{} };
  if (!Array.isArray(db.mapOverrides.objects)) db.mapOverrides.objects = [];
  if (!db.mapOverrides.equipment || typeof db.mapOverrides.equipment !== 'object') db.mapOverrides.equipment = {};
  if (!db.mapOverrides.models || typeof db.mapOverrides.models !== 'object') db.mapOverrides.models = {};
  if (!Array.isArray(db.mapOverrides.sandbox)) db.mapOverrides.sandbox = [];
  if (!db.mapOverrides.spawns || typeof db.mapOverrides.spawns !== 'object') db.mapOverrides.spawns = {};
  try { applySpawns(db.mapOverrides.spawns); } catch (e) { console.log('applySpawns:', e.message); }
  _mongoReady = true;
}

function persist() {
  if (!mongoCol) return Promise.reject(new Error('MongoDB not connected'));
  return mongoCol.updateOne(
    { _id: MONGO_DOC_ID },
    { $set: { users: db.users, states: db.states, guilds: db.guilds, bans: db.bans, mapOverrides: db.mapOverrides, updatedAt: new Date() } },
    { upsert: true }
  ).catch(e => {
    console.error('persist failed:', e.message);
    throw e;
  });
}

// 저장 요청이 몰려도 1초에 한 번만 MongoDB 에 쓴다
let _persistT = null;
let _persistDirty = false;
function persistSoon() {
  _persistDirty = true;
  if (_persistT) return;
  _persistT = setTimeout(() => {
    _persistT = null;
    if (!_persistDirty) return;
    _persistDirty = false;
    persist().catch(e => console.error('persist failed:', e.message));
  }, 1000);
}
// 1초마다 dirty 면 강제 플러시 (로그인/레벨 롤백 방지)
setInterval(() => {
  if (_persistDirty && !_persistT) {
    _persistDirty = false;
    persist().catch(e => console.error('persist failed:', e.message));
  }
}, 1000);

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

const SHOP_W = [
  null, // 0 나무검
  {name:'철검',cost:80},           // 1
  {name:'강철검',cost:300},         // 2
  {name:'미스릴검',cost:900},       // 3
  {name:'용사검',cost:2500},        // 4
  {name:'마검',cost:7000},          // 5
  {name:'드래곤 슬레이어',cost:18000}, // 6
  {name:'신검',cost:45000},         // 7
  {name:'천벌',cost:65000},         // 8
  {name:'흑염검',cost:80000},       // 9
  {name:'성역의 창',cost:100000},   // 10
  {name:'심연 도끼',cost:120000},   // 11
  null, // 12 드래곤 검 (드롭)
  null, // 13 월드의 검 (드롭)
  {name:'도적의 단검',cost:60000},  // 14
  {name:'번개검',cost:150000},      // 15
  {name:'서리 대검',cost:350000},   // 16
  {name:'지옥불 대검',cost:700000}, // 17
  {name:'공허의 낫검',cost:1500000},// 18
  null, // 19 환생의 검
  null, // 20 영겁의 검
  {name:'천상의 성검',cost:12000000},   // 21
  {name:'별빛 파멸검',cost:18000000},   // 22
  {name:'성역의 심판검',cost:22000000}, // 23
  {name:'천계의 창',cost:26000000},     // 24
  {name:'성운의 별검',cost:42000000},   // 25 신규 천상 상인 무기
  {name:'신들의 심판검',cost:24000000},  // 26 신기 상인
  {name:'천뢰의 파멸검',cost:36000000},  // 27
  {name:'창세의 신검',cost:44000000},    // 28
  {name:'천상천하의 창',cost:52000000},  // 29
  {name:'신성한 성운검',cost:84000000}     // 30: 성운의 별검 가격의 2배
];
const SHOP_A = [
  null, // 0 천 옷
  {name:'가죽갑옷',cost:80},
  {name:'사슬갑옷',cost:250},
  {name:'철갑옷',cost:700},
  {name:'강철갑옷',cost:1800},
  {name:'미스릴 갑옷',cost:4500},
  {name:'용비늘 갑옷',cost:11000},
  {name:'성기사 갑옷',cost:28000},
  {name:'암흑왕 갑옷',cost:65000},
  null, // 9 드래곤 갑옷 (드롭)
  {name:'그림자 갑옷',cost:80000},
  {name:'독사 가죽 갑옷',cost:200000},
  {name:'서리 갑옷',cost:450000},
  {name:'지옥불 갑옷',cost:900000},
  {name:'공허의 갑옷',cost:1800000}, // 14
  null, // 15 환생의 갑옷
  null, // 16 영겁의 갑옷
  {name:'천상의 갑옷',cost:10000000},   // 17
  {name:'별빛 갑옷',cost:15000000},     // 18
  {name:'성역의 갑옷',cost:20000000},   // 19
  {name:'천계 수호갑',cost:25000000},   // 20 — 월드 갑옷급 바로 아래
  {name:'신들의 성갑',cost:20000000},     // 21 신기 상인
  {name:'천뢰의 갑주',cost:30000000},     // 22
  {name:'창세의 신갑',cost:40000000},     // 23
  {name:'천상천하의 갑옷',cost:50000000} // 24
];
const SHOP_P = [{name:'체력 물약',cost:15},{name:'고급 물약',cost:45},{name:'대형 물약',cost:120},{name:'엘릭서',cost:500}];
const QUESTS = {
  s1:{name:'슬라임 사냥',need:5,coin:80,xp:40}, m1:{name:'버섯 소탕',need:6,coin:150,xp:90},
  w1:{name:'늑대 퇴치',need:8,coin:300,xp:180}, b1:{name:'불곰 사냥',need:5,coin:550,xp:350},
  g1:{name:'고블린 소탕',need:10,coin:900,xp:700}, o1:{name:'오크 전사 토벌',need:6,coin:1500,xp:1100},
  k1:{name:'해골 군단',need:10,coin:2400,xp:1800}, h1:{name:'유령 퇴치',need:8,coin:3800,xp:3000},
  l1:{name:'골렘 파괴',need:3,coin:6500,xp:5500}, d1:{name:'용 사냥',need:1,coin:14000,xp:13000},
  hvn1:{name:'케루빔 소탕',need:10,coin:60000,xp:40000},
  hvn2:{name:'세라핌 처치',need:10,coin:80000,xp:60000},
  hvn3:{name:'대천사 격파',need:1,coin:200000,xp:150000},
  hvn4:{name:'세라핌 토벌',need:1,coin:800000,xp:600000},
  hxp1:{name:'케루빔 수련',need:15,coin:10000,xp:150000},
  hxp2:{name:'빛의 정령 정화',need:15,coin:10000,xp:180000},
  hxp3:{name:'하급 천사의 시련',need:20,coin:15000,xp:300000},
  hxp4:{name:'천상 기사의 시련',need:15,coin:20000,xp:400000},
  hxp5:{name:'신성 야수 사냥',need:10,coin:30000,xp:600000},
  god_c1:{name:'구름 사신 토벌',need:5,coin:240000,xp:450000},
  god_c2:{name:'천뢰 기사 격파',need:3,coin:360000,xp:650000},
  god_c3:{name:'성천 뱀 사냥',need:2,coin:480000,xp:850000},
  god_c4:{name:'신역 수호자 처치',need:1,coin:1200000,xp:1800000},
  god_c5:{name:'제우스 토벌',need:1,coin:1500000,xp:2200000}
};

// ===== 서버 권한 몬스터 엔진 (위치 / 체력 / AI / 공격 / 리스폰 / 보상 전부 서버가 결정) =====
// WORLD 는 index.html 의 최종 몬스터 정의(MT), 구역(ZD), 절벽(BK), 보스 위치를 추출한 값입니다.
const WORLD = {"MT":{"slime":{"hp":30,"dmg":6,"xp":12,"g":3,"sp":3.6,"reach":1.8,"rt":8,"sc":1,"n":22,"nm":"슬라임"},"wolf":{"hp":55,"dmg":10,"xp":20,"g":6,"sp":8,"reach":2.2,"rt":8,"sc":1,"n":18,"nm":"늑대"},"goblin":{"hp":135,"dmg":18,"xp":51,"g":16,"sp":5,"reach":2.3,"rt":10,"sc":1.1,"n":14,"nm":"고블린"},"skeleton":{"hp":252,"dmg":30,"xp":88,"g":28,"sp":5.5,"reach":2.4,"rt":12,"sc":1.15,"n":12,"nm":"해골 병사"},"golem":{"hp":3750,"dmg":76,"xp":528,"g":216,"sp":3,"reach":4.4,"rt":30,"sc":2.4,"n":6,"ag":20,"cd":1.8,"nm":"골렘"},"mushroom":{"hp":40,"dmg":8,"xp":16,"g":4,"sp":4,"reach":1.7,"rt":8,"sc":1,"n":14,"nm":"독버섯"},"bear":{"hp":130,"dmg":17,"xp":38,"g":12,"sp":5,"reach":3,"rt":12,"sc":1.5,"n":10,"nm":"불곰"},"orc":{"hp":304,"dmg":33,"xp":104,"g":35,"sp":4.8,"reach":3,"rt":14,"sc":1.4,"n":9,"nm":"오크 전사"},"ghost":{"hp":216,"dmg":39,"xp":128,"g":41,"sp":6,"reach":2.2,"rt":14,"sc":1,"n":9,"nm":"유령"},"dragon":{"hp":600000,"dmg":1000,"xp":40000,"g":30000,"sp":5,"reach":8,"rt":300,"sc":2.8,"n":1,"ag":29.4,"cd":2,"boss":1,"fix":[-150,-2000],"nm":"에인션트 드래곤"},"frostwolf":{"hp":2700,"dmg":100,"xp":288,"g":96,"sp":9,"reach":2.4,"rt":10,"sc":1.1,"n":14,"nm":"서리 늑대"},"yeti":{"hp":5850,"dmg":155,"xp":528,"g":192,"sp":5,"reach":3.4,"rt":14,"sc":1.7,"n":9,"nm":"예티"},"scorpion":{"hp":4680,"dmg":180,"xp":624,"g":216,"sp":6,"reach":2.6,"rt":10,"sc":1.2,"n":14,"nm":"거대 전갈"},"mummy":{"hp":9120,"dmg":228,"xp":912,"g":312,"sp":4.5,"reach":2.6,"rt":14,"sc":1.2,"n":10,"nm":"미라"},"toad":{"hp":14280,"dmg":283,"xp":1344,"g":456,"sp":5,"reach":2.8,"rt":12,"sc":1.3,"n":14,"nm":"독두꺼비"},"witch":{"hp":10200,"dmg":350,"xp":1680,"g":576,"sp":5,"reach":2.6,"rt":15,"sc":1.15,"n":9,"nm":"늪지 마녀"},"imp":{"hp":22800,"dmg":435,"xp":2160,"g":720,"sp":8.5,"reach":2.4,"rt":10,"sc":0.95,"n":14,"nm":"임프"},"hellhound":{"hp":38400,"dmg":528,"xp":3120,"g":1080,"sp":10,"reach":3,"rt":14,"sc":1.3,"n":10,"nm":"지옥견"},"darkknight":{"hp":46800,"dmg":735,"xp":4800,"g":1680,"sp":5.5,"reach":3.2,"rt":18,"sc":1.5,"n":8,"nm":"암흑 기사"},"demonlord":{"hp":2000000,"dmg":2000,"xp":200000,"g":120000,"sp":5,"reach":7,"rt":600,"sc":3.2,"n":1,"ag":32.2,"cd":2,"boss":1,"fix":[365,-820],"nm":"마왕"},"kingslime":{"hp":3000,"dmg":35,"xp":500,"g":400,"sp":3.5,"reach":3.8,"rt":60,"sc":3,"n":1,"ag":19.6,"cd":1.6,"boss":1,"fix":[0,-225],"nm":"킹 슬라임"},"wolfalpha":{"hp":9000,"dmg":110,"xp":1800,"g":1200,"sp":9,"reach":4,"rt":90,"sc":2.2,"n":1,"ag":23.8,"cd":1.4,"boss":1,"fix":[-185,-240],"nm":"늑대 대장"},"goblinking":{"hp":25000,"dmg":220,"xp":6000,"g":4000,"sp":5.5,"reach":4.5,"rt":120,"sc":2.4,"n":1,"ag":25.2,"cd":1.6,"boss":1,"fix":[185,-240],"nm":"고블린 왕"},"lich":{"hp":150000,"dmg":450,"xp":15000,"g":12000,"sp":5.5,"reach":5,"rt":180,"sc":2.6,"n":1,"ag":26.6,"cd":1.8,"boss":1,"fix":[495,-770],"nm":"해골 군주"},"boar":{"hp":70,"dmg":12,"xp":24,"g":7,"sp":6.5,"reach":2.3,"rt":8,"sc":1.1,"n":10,"nm":"멧돼지"},"spider":{"hp":150,"dmg":22,"xp":45,"g":14,"sp":7,"reach":2.4,"rt":9,"sc":1.2,"n":10,"nm":"거대 거미"},"goblinshaman":{"hp":330,"dmg":36,"xp":70,"g":24,"sp":4.5,"reach":2.6,"rt":10,"sc":1.1,"n":8,"nm":"고블린 주술사"},"zombie":{"hp":420,"dmg":44,"xp":90,"g":30,"sp":3.5,"reach":2.5,"rt":10,"sc":1.15,"n":9,"nm":"좀비"},"gargoyle":{"hp":4500,"dmg":90,"xp":450,"g":150,"sp":6,"reach":2.8,"rt":14,"sc":1.3,"n":4,"nm":"가고일"},"icegolem":{"hp":9000,"dmg":190,"xp":675,"g":225,"sp":4,"reach":3.6,"rt":14,"sc":2,"n":8,"nm":"얼음 골렘"},"cactus":{"hp":10800,"dmg":230,"xp":900,"g":300,"sp":4,"reach":2.8,"rt":12,"sc":1.3,"n":10,"nm":"선인장 몬스터"},"lizardman":{"hp":19500,"dmg":330,"xp":1500,"g":495,"sp":6,"reach":2.9,"rt":12,"sc":1.3,"n":10,"nm":"리자드맨"},"flamegolem":{"hp":32000,"dmg":560,"xp":2700,"g":900,"sp":4.5,"reach":3.8,"rt":16,"sc":2.1,"n":8,"nm":"화염 골렘"},"wraith":{"hp":30000,"dmg":800,"xp":3000,"g":1000,"sp":7,"reach":2.6,"rt":16,"sc":1.1,"n":8,"nm":"망령"},"bee":{"hp":60,"dmg":14,"xp":22,"g":6,"sp":8.5,"reach":2,"rt":8,"sc":1.2,"n":10,"nm":"거대 벌"},"treant":{"hp":220,"dmg":28,"xp":55,"g":18,"sp":3.5,"reach":3,"rt":10,"sc":1.6,"n":8,"nm":"나무 정령"},"hobgoblin":{"hp":380,"dmg":48,"xp":85,"g":28,"sp":5,"reach":2.7,"rt":10,"sc":1.3,"n":8,"nm":"홍고블린"},"necromancer":{"hp":500,"dmg":55,"xp":120,"g":40,"sp":4.5,"reach":2.6,"rt":12,"sc":1.15,"n":7,"nm":"네크로맨서"},"minotaur":{"hp":5400,"dmg":110,"xp":570,"g":195,"sp":5.5,"reach":3.4,"rt":14,"sc":1.8,"n":4,"nm":"미노타우르스"},"frostmage":{"hp":9900,"dmg":210,"xp":780,"g":255,"sp":4.5,"reach":2.8,"rt":12,"sc":1.2,"n":8,"nm":"얼음 마법사"},"anubis":{"hp":12600,"dmg":260,"xp":1050,"g":345,"sp":5.5,"reach":3,"rt":12,"sc":1.3,"n":8,"nm":"아누비스 전사"},"snake":{"hp":22500,"dmg":360,"xp":1725,"g":570,"sp":7,"reach":3.2,"rt":12,"sc":1.4,"n":10,"nm":"거대 뱀"},"pyromancer":{"hp":42000,"dmg":520,"xp":2550,"g":840,"sp":5,"reach":2.8,"rt":14,"sc":1.2,"n":8,"nm":"화염술사"},"vampire":{"hp":33000,"dmg":900,"xp":3400,"g":1100,"sp":7.5,"reach":2.8,"rt":14,"sc":1.2,"n":8,"nm":"흡혈귀"},"frostgiant":{"hp":200000,"dmg":600,"xp":30000,"g":25000,"sp":5,"reach":6,"rt":240,"sc":3,"n":1,"ag":28,"cd":1.8,"boss":1,"fix":[365,-660],"nm":"서리 거인"},"pharaoh":{"hp":300000,"dmg":800,"xp":45000,"g":35000,"sp":5.5,"reach":5.5,"rt":270,"sc":2.6,"n":1,"ag":29,"cd":1.7,"boss":1,"fix":[365,-700],"nm":"파라오"},"hydra":{"hp":450000,"dmg":1100,"xp":70000,"g":55000,"sp":5,"reach":7,"rt":300,"sc":3,"n":1,"ag":30,"cd":2,"boss":1,"fix":[365,-740],"nm":"히드라"},"balrog":{"hp":800000,"dmg":1600,"xp":120000,"g":90000,"sp":5.5,"reach":7,"rt":420,"sc":3.4,"n":1,"ag":31,"cd":2,"boss":1,"fix":[365,-780],"nm":"발록"},"mgoat":{"hp":170,"dmg":21,"xp":44,"g":14,"sp":6.5,"reach":2.4,"rt":9,"sc":1.15,"n":8,"nm":"산양"},"bandit":{"hp":280,"dmg":32,"xp":68,"g":24,"sp":5.2,"reach":2.6,"rt":11,"sc":1.1,"n":8,"nm":"산적"},"worldboss":{"hp":8000000,"dmg":5000,"xp":3000000,"g":1500000,"sp":6.5,"reach":8,"rt":600,"sc":4.5,"n":1,"ag":70,"cd":2.2,"boss":1,"fix":[760,-740],"nm":"하데스"},"crystalbeetle":{"hp":650,"dmg":70,"xp":150,"g":50,"sp":5,"reach":2.6,"rt":10,"sc":1.25,"n":12,"nm":"수정 딱정벌레"},"crystalbat":{"hp":520,"dmg":80,"xp":170,"g":56,"sp":9.5,"reach":2.2,"rt":9,"sc":1.0,"n":12,"nm":"수정 박쥐"},"prismwisp":{"hp":900,"dmg":110,"xp":240,"g":80,"sp":6.5,"reach":2.4,"rt":11,"sc":1.0,"n":8,"nm":"프리즘 정령"},"amethystgolem":{"hp":1700,"dmg":125,"xp":340,"g":120,"sp":3.6,"reach":4.0,"rt":16,"sc":2.0,"n":6,"ag":20,"cd":1.8,"nm":"자수정 골렘"},"statueguard":{"hp":1500,"dmg":115,"xp":300,"g":100,"sp":4.2,"reach":3.2,"rt":14,"sc":1.7,"n":8,"nm":"석상 수호병"},"harpy":{"hp":800,"dmg":105,"xp":230,"g":78,"sp":9,"reach":2.4,"rt":10,"sc":1.1,"n":10,"nm":"하피"},"cursedarmor":{"hp":1200,"dmg":140,"xp":280,"g":96,"sp":5.5,"reach":3.0,"rt":12,"sc":1.4,"n":8,"nm":"저주받은 갑옷"},"mimic":{"hp":1000,"dmg":150,"xp":260,"g":200,"sp":6,"reach":2.4,"rt":12,"sc":1.2,"n":6,"nm":"미믹"}},"ZD":{"village":[[-40,40,-40,40]],"corridor":[[-8,8,-150,-40]],"plains":[[-110,110,-300,-150]],"forest":[[-260,-110,-300,-170]],"camp":[[110,260,-300,-170]],"hill":[[-160,80,-440,-300]],"cavearea":[[-260,-160,-440,-300]],"bentry":[[380,480,-640,-560]],"grave":[[430,560,-840,-640]],"snow":[[300,430,-680,-640]],"desert":[[300,430,-720,-680]],"swamp":[[300,430,-760,-720]],"hell":[[300,430,-800,-760]],"dark":[[300,430,-840,-800]],"centry":[[-220,-80,-1900,-1800]],"golem":[[-300,0,-2060,-1900]],"arena":[[700,820,-780,-660]],"crystal":[[80,260,-440,-300]],"ruins":[[-400,-260,-300,-170]],"volcano":[[-420,-260,-460,-280]]},"ZT":{"slime":"plains","mushroom":"plains","boar":"plains","bee":"plains","wolf":"forest","bear":"forest","spider":"forest","treant":"forest","goblin":"camp","orc":"camp","hobgoblin":"camp","goblinshaman":"camp","skeleton":"grave","ghost":"grave","zombie":"grave","necromancer":"grave","wraith":"grave","vampire":"grave","frostwolf":"snow","yeti":"snow","frostmage":"snow","scorpion":"desert","mummy":"desert","cactus":"desert","lizardman":"desert","anubis":"desert","toad":"swamp","witch":"swamp","snake":"swamp","imp":"hell","hellhound":"hell","pyromancer":"hell","darkknight":"dark","golem":"golem","gargoyle":"golem","icegolem":"golem","flamegolem":"golem","minotaur":"golem","mgoat":"hill","bandit":"hill","crystalbeetle":"crystal","crystalbat":"crystal","prismwisp":"crystal","amethystgolem":"crystal","statueguard":"ruins","harpy":"ruins","cursedarmor":"ruins","mimic":"ruins"},"BK":[[-60,-30,-390,-340],[10,40,-420,-380],[428,432,-840,-800],[428,432,-770,-720],[428,432,-690,-640]],"BOSS":{"kingslime":[0,-225],"wolfalpha":[-185,-240],"goblinking":[185,-240],"lich":[495,-770],"frostgiant":[365,-660],"pharaoh":[365,-700],"hydra":[365,-740],"balrog":[365,-780],"demonlord":[365,-820],"dragon":[-150,-2000],"worldboss":[760,-740],"volcanolord":[-340,-370]}};
const MT = WORLD.MT;

// 신규 몬스터 스탯
Object.assign(WORLD.MT, {
  shadowwolf:{hp:800,dmg:95,xp:200,g:70,sp:9.5,reach:2.5,rt:10,sc:1.15,n:10,nm:'그림자 늑대'},
  stonegolem:{hp:2500,dmg:140,xp:400,g:140,sp:3.2,reach:4.2,rt:16,sc:2.2,n:6,ag:22,cd:1.9,nm:'석상 골렘'},
  fireimp:{hp:1100,dmg:160,xp:280,g:90,sp:8.5,reach:2.3,rt:11,sc:1.0,n:10,nm:'화염 임프'},
  icewraith:{hp:1400,dmg:130,xp:320,g:110,sp:7,reach:2.5,rt:12,sc:1.1,n:8,nm:'얼음 망령'},
  swampbeast:{hp:1800,dmg:150,xp:360,g:120,sp:4.5,reach:3.2,rt:14,sc:1.6,n:8,nm:'늪 야수'},
  voidcultist:{hp:1600,dmg:180,xp:380,g:130,sp:5.5,reach:2.6,rt:13,sc:1.2,n:8,nm:'공허 신도'},
  // 화산 지대 몬스터
  lavaslime:{hp:35000,dmg:480,xp:2800,g:900,sp:4.5,reach:2.6,rt:12,sc:1.4,n:12,nm:'용암 슬라임'},
  magmabeetle:{hp:42000,dmg:520,xp:3200,g:1100,sp:6.5,reach:2.4,rt:11,sc:1.2,n:10,nm:'마그마 딱정벌레'},
  fireelemental:{hp:55000,dmg:600,xp:4500,g:1500,sp:5.5,reach:2.8,rt:14,sc:1.5,n:8,nm:'화염 정령'},
  volcanoorc:{hp:70000,dmg:720,xp:6000,g:2000,sp:5,reach:3.0,rt:15,sc:1.6,n:8,nm:'화산 오크'},
  ashgolem:{hp:120000,dmg:900,xp:12000,g:4000,sp:3.5,reach:4.2,rt:20,sc:2.4,n:4,ag:22,cd:1.9,nm:'재 골렘'},
  phoenix:{hp:90000,dmg:850,xp:10000,g:3500,sp:8,reach:3.5,rt:18,sc:1.8,n:3,ag:26,cd:1.6,nm:'불사조'},
  volcanolord:{hp:2500000,dmg:2200,xp:250000,g:150000,sp:5.5,reach:7,rt:420,sc:3.0,n:1,ag:32,cd:2,boss:1,pos:[-340,-370],nm:'화산 군주'}
});

Object.assign(WORLD.ZT, {
  shadowwolf:'dark', stonegolem:'golem', fireimp:'hell',
  icewraith:'snow', swampbeast:'swamp', voidcultist:'dark',
  lavaslime:'volcano', magmabeetle:'volcano', fireelemental:'volcano',
  volcanoorc:'volcano', ashgolem:'volcano', phoenix:'volcano', volcanolord:'volcano'
});

// ===== 천상 지역 (최고 난이도, 화산 북쪽) =====
WORLD.ZD.heaven = [[-420,-260,-520,-460]];
WORLD.ZD.abyss = [[-520,-360,-620,-520]]; // 심연 지대 (천상 서쪽)
Object.assign(WORLD.MT, {
  cherub:{hp:60000,dmg:900,xp:7000,g:2500,sp:6,reach:2.6,rt:14,sc:1.3,n:10,nm:'케루빔'},
  seraphim:{hp:80000,dmg:1100,xp:9000,g:3200,sp:6.5,reach:2.8,rt:15,sc:1.4,n:10,nm:'하급 천사'},
  celestialknight:{hp:100000,dmg:1300,xp:12000,g:4000,sp:5.5,reach:3.0,rt:16,sc:1.6,n:8,nm:'천상 기사'},
  lightwisp:{hp:50000,dmg:800,xp:6000,g:2000,sp:7,reach:2.4,rt:12,sc:1.0,n:8,nm:'빛의 정령'},
  divinebeast:{hp:120000,dmg:1500,xp:15000,g:5000,sp:5,reach:3.2,rt:18,sc:1.8,n:6,ag:22,cd:1.9,nm:'신성 야수'},
  archangel:{hp:800000,dmg:2500,xp:100000,g:50000,sp:5,reach:6,rt:240,sc:2.8,n:1,ag:28,cd:1.8,boss:1,fix:[-340,-480],nm:'대천사'},
  heavenlord:{hp:4000000,dmg:3500,xp:500000,g:300000,sp:5.5,reach:7,rt:420,sc:3.2,n:1,ag:32,cd:2,boss:1,fix:[-340,-500],nm:'세라핌'}
});
Object.assign(WORLD.ZT, {cherub:'heaven',seraphim:'heaven',celestialknight:'heaven',lightwisp:'heaven',divinebeast:'heaven',archangel:'heaven',heavenlord:'heaven'});
WORLD.BOSS.archangel=[-340,-480]; WORLD.BOSS.heavenlord=[-340,-500];
// ===== /천상 지역 =====

// ===== 심연 지대 (신규 맵) =====
Object.assign(WORLD.MT, {
  voidspawn:{hp:90000,dmg:1400,xp:12000,g:4000,sp:6.5,reach:2.8,rt:14,sc:1.3,n:12,nm:'심연 새끼'},
  abyssfiend:{hp:120000,dmg:1700,xp:16000,g:5500,sp:5.5,reach:3.0,rt:15,sc:1.5,n:10,nm:'심연 악령'},
  nightcrawler:{hp:150000,dmg:2000,xp:22000,g:7000,sp:7,reach:2.6,rt:12,sc:1.2,n:10,nm:'밤의 기어다니는 자'},
  voidknight:{hp:200000,dmg:2400,xp:30000,g:10000,sp:5,reach:3.2,rt:16,sc:1.7,n:8,nm:'공허 기사'},
  abyssbeast:{hp:280000,dmg:2800,xp:40000,g:14000,sp:5.5,reach:3.5,rt:18,sc:2.0,n:6,ag:24,cd:1.8,nm:'심연 야수'},
  abysslord:{hp:6000000,dmg:4500,xp:800000,g:400000,sp:5.5,reach:7.5,rt:480,sc:3.4,n:1,ag:34,cd:2,boss:1,pos:[-440,-570],nm:'포세이돈'}
});
Object.assign(WORLD.ZT, {voidspawn:'abyss',abyssfiend:'abyss',nightcrawler:'abyss',voidknight:'abyss',abyssbeast:'abyss',abysslord:'abyss'});
WORLD.BOSS.abysslord=[-440,-570];
// ===== 신(GOD) 지역: 구름 군도 =====
WORLD.ZD.god = [[820,1060,-1200,-900]]; // 절벽 없이 구름 섬이 흩어진 하늘 지역
WORLD.ZD.godarena = [[835,975,-1190,-1115]]; // 신들의 결투장 전용 스폰 구역
Object.assign(WORLD.MT, {
  zeus:{hp:40000000,dmg:7500,xp:5000000,g:2500000,sp:6.5,reach:8,rt:900,sc:4.8,n:1,ag:80,cd:2.2,boss:1,fix:[980,-1080],nm:'제우스'}
});
Object.assign(WORLD.ZT, {zeus:'god'});
WORLD.BOSS.zeus=[980,-1080];
// 신(GOD) 지역 추가 몬스터 — 최상위 난이도 ★★★★★★★★
Object.assign(WORLD.MT, {
  cloudreaper:{hp:1266666,dmg:6800,xp:900000,g:480000,sp:7.5,reach:4.2,rt:20,sc:2.2,n:5,ag:42,cd:1.6,nm:'구름 사신'},
  thunderknight:{hp:2066666,dmg:8200,xp:1400000,g:720000,sp:5.8,reach:4.0,rt:22,sc:2.6,n:4,ag:46,cd:1.8,nm:'천뢰 기사'},
  astralserpent:{hp:2833333,dmg:9600,xp:1900000,g:950000,sp:8.2,reach:4.8,rt:24,sc:2.8,n:3,ag:50,cd:1.7,nm:'성천 뱀'},
  godsentinel:{hp:24000000,dmg:12500,xp:12000000,g:6000000,sp:5.2,reach:9,rt:900,sc:5.2,n:1,ag:90,cd:2.1,boss:1,fix:[1030,-1130],nm:'신역 수호자'}
});
Object.assign(WORLD.ZT,{cloudreaper:'god',thunderknight:'god',astralserpent:'god',godsentinel:'god'});
WORLD.BOSS.godsentinel=[1030,-1130];
// 신들의 결투장 전용 몬스터
Object.assign(WORLD.MT, {
  olympusduelist:{hp:3600000,dmg:9800,xp:2200000,g:1100000,sp:6.2,reach:4.2,rt:20,sc:2.3,n:5,ag:48,cd:1.6,nm:'올림포스 결투사'},
  stormgladiator:{hp:6200000,dmg:11800,xp:3600000,g:1800000,sp:5.6,reach:4.8,rt:22,sc:2.7,n:3,ag:52,cd:1.7,nm:'폭풍 검투사'},
  aegiswarden:{hp:10500000,dmg:14500,xp:5800000,g:2900000,sp:4.8,reach:5.2,rt:24,sc:3.0,n:2,ag:58,cd:1.9,nm:'아이기스 수호병'},
  areschampion:{hp:32000000,dmg:18500,xp:18000000,g:9000000,sp:5.8,reach:9,rt:900,sc:4.4,n:1,ag:95,cd:2.0,boss:1,fix:[910,-1150],nm:'아레스 · 결투장 군주'}
});
Object.assign(WORLD.ZT,{olympusduelist:'godarena',stormgladiator:'godarena',aegiswarden:'godarena',areschampion:'godarena'});
WORLD.BOSS.areschampion=[910,-1150];
// ===== /신(GOD) 지역 =====

// ===== 성운 지역 (신규 지역: 별빛 섬) =====
WORLD.ZD.nebula = [[1160,1420,-1510,-1240]];
Object.assign(WORLD.MT, {
  starguard:{hp:420000,dmg:3200,xp:180000,g:90000,sp:5.5,reach:3.2,rt:18,sc:1.7,n:8,ag:25,cd:1.7,nm:'별빛 수호자'},
  nebulafox:{hp:360000,dmg:2800,xp:150000,g:75000,sp:8.5,reach:2.7,rt:14,sc:1.3,n:10,ag:24,cd:1.4,nm:'성운 여우'},
  astralmage:{hp:520000,dmg:3900,xp:220000,g:110000,sp:4.8,reach:3.0,rt:16,sc:1.5,n:7,ag:28,cd:1.8,nm:'성운 마도사'},
  astralguardian:{hp:4200000,dmg:6200,xp:1200000,g:650000,sp:4.5,reach:6.5,rt:360,sc:3.4,n:1,ag:36,cd:2,boss:1,fix:[1290,-1370],nm:'성운 수호왕'}
});
Object.assign(WORLD.ZT, {starguard:'nebula',nebulafox:'nebula',astralmage:'nebula',astralguardian:'nebula'});
WORLD.BOSS.astralguardian=[1290,-1370];
// ===== /성운 지역 =====

// ===== /심연 지대 =====

const ZONE_RECTS = WORLD.ZD;
const ZT = WORLD.ZT;
const BK = WORLD.BK;
const BOSS_POS = Object.values(WORLD.BOSS);
const ALLR = Object.values(ZONE_RECTS).flat();
const AOI_RADIUS = 260;          // 이 거리 안의 몬스터 변화만 각 플레이어에게 전송
const inSafe = (x, z) => Math.abs(x) <= 42 && Math.abs(z) <= 42; // 시작마을 전체(정사각형 ±24 + 여유) = 안전지대
const VILLAGE_R = 18;            // 마을 반경 (몬스터 진입/공격 불가)
// 신(GOD) 지역 천사마을: 몬스터 스폰/진입 금지 + 보스 공격·PvP 무효 (클라이언트 ANGEL_VIL 과 동일 좌표)
const ANGEL_VILLAGE = { x0:828, x1:912, z0:-982, z1:-906 };
const inAngelVillage = (x, z) => x >= ANGEL_VILLAGE.x0 && x <= ANGEL_VILLAGE.x1 && z >= ANGEL_VILLAGE.z0 && z <= ANGEL_VILLAGE.z1;
const inSafeAny = (x, z) => inSafe(x, z) || inAngelVillage(x, z);
// 수정 쉴드 보스 전용 격리 구역 (다른 몬스터 진입 불가)
// 보스 신전/신구역: 다른 몬스터 스폰 금지 + 플레이어 어그로 차단
const BOSS_EXCLUSION = [
  { x:760, z:-740, r:60 },    // 하데스 신전
  { x:-340, z:-500, r:55 },   // 세라핌 신구역
  { x:-440, z:-570, r:55 },   // 포세이돈 신전
  { x:980, z:-1080, r:75 }    // 제우스 구름 왕좌
];
const nearBossExclusion = (x,z) => BOSS_EXCLUSION.some(b => Math.hypot(x-b.x,z-b.z) < b.r);
const inBossSanctuary = (x,z) => nearBossExclusion(x,z);

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
    if (inAngelVillage(x, z)) continue; // 천사마을 안에는 몬스터 스폰 금지
    if (BOSS_POS.some(b => Math.hypot(x - b[0], z - b[1]) < 45)) continue; // 쉴드 보스 주변은 다른 몬스터 스폰 금지
    if (!d.boss && nearBossExclusion(x, z)) continue;
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
  m.hp = d.hp; m.mhp = d.hp; m.dead = false; m.rt = 0; m.cd = 0; m.kx = m.kz = 0; m.face = 0; m.cast = null; m.skT = rnd(4, 8); m._ret = null; m._lastTgtId = null; m._wbDone = false; m.shield = null; m.crystals = null; m.floor = null; m.stun = 0;
  m.dmg.clear(); m.fireDot = null; m.ver++;
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
const BOSS_CAP = { kingslime:15, wolfalpha:20, goblinking:30, lich:40, frostgiant:50, pharaoh:60, hydra:70, balrog:80, dragon:75, demonlord:100, worldboss:400, archangel:90, heavenlord:150, zeus:1200, godsentinel:1600 }
const BOSS_CAP_SCALE = 0.5;   // ★ 보스 최소 처치시간 배율 (1=원래, 0.5=절반 → 상한 DPS 2배, 0.25=4배). 보스가 너무 안 닳으면 낮추세요
const WB_TEAM_CAP = 0.015;   // 월드 보스: 전체 플레이어 합산 초당 최대 1.5% (최소 약 67초)
function bossLimit(m, d, ws, dmg) {
  return dmg;   // 보스 데미지 상한 제거 (타격당 최대치는 MAX_HIT_DMG 만 적용)
}
function applyPlayerHit(p, ws, id, dmg, kb, elem) {
  // 크리스탈 타격 (부위 파괴)
  if (false && typeof id === 'string' && id.startsWith('cr_')) {
    const mid = Number(id.slice(3));
    const m = monsters.get(mid);
    if (!m || m.dead || !m.crystals) return;
    let ci = -1, bd = 1e9;
    m.crystals.forEach((cc, i) => { if (cc.dead) return; const dd = Math.hypot(cc.x - p.x, cc.z - p.z); if (dd < 11 && dd < bd) { bd = dd; ci = i; } });
    if (ci < 0) return;
    const c = m.crystals[ci];
    c.hp -= Math.max(1, Math.min(MAX_HIT_DMG, Math.floor(dmg)));
    sendNear(m.x, m.z, { type: 'cr_hp', id: mid, i: ci, hp: Math.max(0, Math.ceil(c.hp)) });
    if (m.shield && m.shield.crystal) {
      m.shield.hp = m.crystals.reduce((a, x) => a + (x.dead ? 0 : Math.max(0, x.hp)), 0);
      m.ver++;
      sendNear(m.x, m.z, { type: 'shield_hit', id: m.id, hp: Math.ceil(m.shield.hp), mhp: m.shield.mhp });
    }
    if (c.hp <= 0) {
      c.dead = true;
      sendNear(m.x, m.z, { type: 'cr_break', id: mid, i: ci });
      if (m.shield && m.shield.crystal && m.crystals.every(x => x.dead)) {
        m.shield = null; m.crystals = null; m.ver++;
        sendNear(m.x, m.z, { type: 'shield_break', id: m.id });
      } else if (m.crystals.every(x => x.dead)) {
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
  if (elem !== 'spear') p.lastHit = dmg;                       // 죽음의 창 기준 데미지(클라가 bd 를 안 보낼 때 대체값)
  if (deathOn(p, 'scythe')) dmg = Math.floor(dmg * DEATH_SCYTHE_MULT);   // 죽음의 낫: 데미지 5배
  if (false && m.shield && m.shield.crystal) {   // 보스 쉴드 비활성화
    if (Date.now() - (ws._shT || 0) > 800) {
      ws._shT = Date.now();
      try { ws.send(JSON.stringify({ type: 'shield_block', id: m.id, elem: 'all' })); } catch {}
    }
    return;
  }
  // 원소 쉴드: 맞는 속성만 쉴드 파괴, 아니면 본체 피해 0
  if (false && d.boss && m.shield && m.shield.hp > 0) {
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
  // 하데스의 검: 적중한 몬스터에게 사망할 때까지 최대 체력의 1% 화염 지속 피해
  if (p.hadesSword) m.fireDot = { source:p.id, next:Date.now()+1000 };
  // 그로기: 크리티컬 200%
  if (m.groggy && m.groggy > 0) dmg = Math.floor(dmg * 2);
  // 넉백 약화: 일반 몬스터 35%, 보스 20%만 적용
  kb = Math.max(0, Math.min(14, Number(kb) || 0)) * (d.boss ? 0.2 : 0.35);
  m.hp -= dmg;
  m.dmg.set(p.id, (m.dmg.get(p.id) || 0) + dmg);
  if (m.type === 'worldboss' && ws._userKey) bumpStat(ws._userKey, 'wb', dmg);
  if (kb > 0) { const dd = dist || 1; m.kx = dx / dd * kb; m.kz = dz / dd * kb; }
  m.ver++;
  // 죽음의 인도: 체력 30% 이하면 즉사 (제우스/아레스 제외) — 죽음의 창 피해에도 동일 적용
  if (m.hp > 0 && deathGuideReady(p, m)) { m.dmg.set(p.id, (m.dmg.get(p.id) || 0) + Math.max(1, Math.ceil(m.hp))); m.hp = 0; }
  if (m.hp <= 0) killMonster(m, d, p);
}
function killMonster(m, d, p) {
  {
    if (m.crystals) sendNear(m.x, m.z, { type: 'cr_clear', id: m.id });
    m.hp = 0; m.dead = true; m.rt = d.rt; m.kx = m.kz = 0; m.cast = null; m.shield = null; m.groggy = 0; m.crystals = null; m.floor = null; m.fireDot = null;
    // 보상: 마지막 일격을 가한 사람 + 몬스터 체력의 2% 이상 피해를 준 접속자
    const got = new Set();
    for (const [pid, dm] of m.dmg) {
      if (pid !== p.id && dm < m.mhp * 0.02) continue;
      const w = wsById.get(pid);
      if (w && w.readyState === WebSocket.OPEN) {
        got.add(pid);
        let rewardCoin = 0, rewardXp = 0;
        if (w._userKey) {
          try {
            const player = ensurePlayer(w._userKey);
            rewardCoin = Math.max(0, Math.floor(d.g || 0));
            rewardXp = Math.max(0, Math.floor(d.xp || 0));
            if (rewardCoin > 0) player.coin = (player.coin || 0) + rewardCoin;
            if (rewardXp > 0) player.xp = (player.xp || 0) + rewardXp;
            if (db.states[w._userKey]) db.states[w._userKey].savedAt = Date.now();
          } catch (_) {}
          bumpStat(w._userKey, 'kills', 1); if(m.type==='slime') bumpStat(w._userKey,'slimeKills',1); if (d.boss) bumpStat(w._userKey, 'boss', 1);
          const g = guildOfKey(w._userKey);
          if (g) addGuildExp(g, w._userKey, Math.min(2000, Math.max(1, Math.floor((d.xp || 0) / 25))));
          if (d.boss) tryDropRune(w, m, d);
        }
        try { w.send(JSON.stringify({ type: 'kill', id: m.id, mt: m.type, coin: rewardCoin, xp: rewardXp })); } catch {}
        if (m.type === 'heavenlord' && !w.player.godUnlocked) {
          if (Math.random() < 0.10) { w.player.godUnlocked=true; try { w.send(JSON.stringify({type:'god_portal_unlock'})); } catch {} }
          else { try { w.send(JSON.stringify({type:'god_portal_fail'})); } catch {} }
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

// ===================================================================================
//  죽음의 신 (환생 500회 달성 시 전직) — 스킬/패시브는 전부 서버 권한
//  1 죽음의 인도(on/off) · 2 죽음의 낫(on/off) · 3 죽음의 회피(발동형) · 4 죽음의 창(on/off)
//  5 패시브: 목숨 2개 · 6 영혼 모드(on/off)
// ===================================================================================
const DEATH_REBIRTH = 500;
const DEATH_GUIDE_RANGE = 50;                       // 죽음의 인도 판정 반경(m)
const DEATH_GUIDE_EXCLUDE = new Set(['zeus', 'areschampion']);   // 제우스, 아레스는 즉사 면역
const DEATH_SCYTHE_MULT = 5;                        // 죽음의 낫 데미지 배율
const DEATH_EVADE_MS = 60000, DEATH_EVADE_CD = 120000, DEATH_EVADE_MULT = 0.1;   // 약 1분 받는 피해 x0.1 / 쿨 2분
const DEATH_SPEAR_COUNT = 15, DEATH_SPEAR_RANGE = 20, DEATH_SPEAR_RATE = 0.15, DEATH_SPEAR_INTERVAL = 600;
const DEATH_MAX_LIVES = 2, DEATH_REVIVE_INV_MS = 4000;
const DEATH_SOUL_SPEED = 3;                         // 영혼 모드 이동속도 배율 (대쉬 불가)
const DEATH_SKILL_IDS = { 1:'guide', 2:'scythe', 3:'evade', 4:'spears', 6:'soul', 7:'harvest', 8:'execution', guide:'guide', scythe:'scythe', evade:'evade', spears:'spears', soul:'soul', harvest:'harvest', execution:'execution' };

function deathSt(p) {   // 죽음의 신이면 DB 플레이어 객체, 아니면 null
  if (!p || !p.key) return null;
  const s = db.states[p.key], pl = s && s.player;
  return pl && (pl.job === 'deathgod' || (pl.rebirth | 0) >= DEATH_REBIRTH) ? pl : null;
}
function deathOn(p, k) { const s = deathSt(p); return !!(s && s.deathSkills && s.deathSkills[k]); }
function dmgTakenMult(p, now) {   // 죽음의 회피 중이면 받는 피해 0.1배
  const s = deathSt(p);
  return s && s.deathSkills && Number(s.deathSkills.evadeUntil) > now ? DEATH_EVADE_MULT : 1;
}
function deathStateMsg(st, now) {
  const ds = st.deathSkills || {};
  if (!(st.job === 'deathgod' || (st.rebirth | 0) >= DEATH_REBIRTH)) return { type: 'death_state', active: false };
  return {
    type: 'death_state', active: true, job: 'deathgod',
    lives: st.deathLives | 0, maxLives: DEATH_MAX_LIVES,
    skills: { guide: !!ds.guide, scythe: !!ds.scythe, spears: !!ds.spears, soul: !!ds.soul, harvest: !!ds.harvest, execution: !!ds.execution },
    evadeLeft: Math.max(0, (Number(ds.evadeUntil) || 0) - now),
    evadeCd: Math.max(0, (Number(ds.evadeCd) || 0) - now),
    spearCount: DEATH_SPEAR_COUNT, soulSpeedMul: DEATH_SOUL_SPEED, soulDash: false
  };
}
function pushDeathState(key) {
  const s = db.states[key], st = s && s.player; if (!st) return;
  const raw = JSON.stringify(deathStateMsg(st, Date.now()));
  for (const c of socketsOf(key)) { try { c.send(raw); } catch {} }
}
function deathInfo(key) {
  const s = db.states[key], st = s && s.player; if (!st) return null;
  return deathStateMsg(st, Date.now());
}
// 전직 처리 (환생 500회 달성 시 1회 컷씬). 이미 500회 이상이던 계정도 접속 시 한 번 컷씬을 본다.
function awakenDeathGod(key, p) {
  if (!p || (p.rebirth | 0) < DEATH_REBIRTH) return false;
  p.job = 'deathgod';
  for (const pl of players.values()) if (pl.key === key) pl.job = 'deathgod';
  const first = !p.deathCutsceneDone;
  if (first) {
    p.deathCutsceneDone = true; persistSoon();
    for (const c of socketsOf(key)) { try { c.send(JSON.stringify({ type: 'death_cutscene', job: 'deathgod', title: '죽음의 신' })); } catch {} }
  }
  pushDeathState(key);
  return first;
}
function deathGuideReady(p, m) {
  return !m.dead && m.hp > 0 && m.hp <= m.mhp * 0.3 && !DEATH_GUIDE_EXCLUDE.has(m.type) && deathOn(p, 'guide');
}
function deathGuideKill(p, m) {
  const d = MT[m.type]; if (!d) return;
  // 즉사 시에도 최소 5% 기여로 인정해 처치 보상이 누락되지 않게 한다.
  const cur = m.dmg.get(p.id) || 0;
  m.dmg.set(p.id, Math.max(cur + Math.max(1, Math.ceil(m.hp)), Math.ceil(m.mhp * 0.05)));
  m.hp = 0; m.ver++;
  killMonster(m, d, p);
}
// 죽음의 창: 15개 고정, 창마다 다른 몬스터를 노리고 몬스터가 15마리 미만이면 남는 창을 한 마리씩 더 배정
function deathSpearsAttack(p, ws) {
  const base = (Number(p.baseDmg) > 0 ? Number(p.baseDmg) : Number(p.lastHit)) || 0;
  const cand = [];
  for (const m of monsters.values()) {
    if (m.dead || m.hp <= 0) continue;
    const dd = Math.hypot(m.x - p.x, m.z - p.z);
    if (dd <= DEATH_SPEAR_RANGE) cand.push([dd, m]);
  }
  if (!cand.length) return;
  cand.sort((a, b) => a[0] - b[0]);
  const tg = cand.length > DEATH_SPEAR_COUNT ? cand.slice(0, DEATH_SPEAR_COUNT) : cand;
  const per = new Map(), assign = [];
  for (let i = 0; i < DEATH_SPEAR_COUNT; i++) {
    const m = tg[i % tg.length][1];
    assign.push(m.id); per.set(m, (per.get(m) || 0) + 1);
  }
  sendNear(p.x, p.z, { type: 'death_spears', id: p.id, t: assign, n: DEATH_SPEAR_COUNT }, 150);   // 창마다 타겟 몬스터 id (연출용)
  const one = Math.floor(base * DEATH_SPEAR_RATE);   // 창 1개 = 내 데미지의 15%
  if (one < 1) return;
  for (const [m, n] of per) applyPlayerHit(p, ws, m.id, one * n, 0, 'spear');
}
let _deathGuideT = 0, _deathSpearT = 0;
function tickDeath(now) {
  const doGuide = now - _deathGuideT >= 200; if (doGuide) _deathGuideT = now;
  const doSpear = now - _deathSpearT >= DEATH_SPEAR_INTERVAL; if (doSpear) _deathSpearT = now;
  if (!doGuide && !doSpear) return;
  for (const ws of wss.clients) {
    const p = ws.player;
    if (!p || ws.readyState !== WebSocket.OPEN || p.hp <= 0) continue;
    const st = deathSt(p); if (!st || !st.deathSkills) continue;
    if (inSafeAny(p.x, p.z)) continue;
    const ds = st.deathSkills; if(ds.execution && Number(ds.executionUntil||0)<=now){ds.execution=false;ds.executionUntil=0;pushDeathState(p.key)}
    if (doGuide && ds.guide) {
      for (const m of monsters.values()) {
        if (deathGuideReady(p, m) && Math.hypot(m.x - p.x, m.z - p.z) <= DEATH_GUIDE_RANGE) deathGuideKill(p, m);
      }
    }
    if (doSpear && ds.spears) deathSpearsAttack(p, ws);
  }
}
// 패시브: 목숨 2개 — 죽은 자리에서 즉시 부활(아우라 연출), 사망 페널티(코인 손실) 없음
function deathLifeCheck(p, ws, st, now) {
  if ((p.reviveUntil || 0) > now) return;
  const lives = st.deathLives | 0;
  if (lives > 0) {
    st.deathLives = lives - 1;
    p.hp = p.mhp; p.invTill = now + DEATH_REVIVE_INV_MS; p.reviveUntil = now + 2000;
    if (db.states[p.key]) db.states[p.key].savedAt = Date.now();
    persistSoon();
    sendTo(p.id, { type: 'death_revive', x: q2(p.x), y: q2(p.y || 0), z: q2(p.z), hp: p.mhp, mhp: p.mhp, lives: st.deathLives, aura: true, keepCoin: true, invMs: DEATH_REVIVE_INV_MS });
    sendNear(p.x, p.z, { type: 'death_revive_fx', id: p.id, x: q2(p.x), z: q2(p.z) }, 150);
    pushDeathState(p.key);
  } else {
    st.deathLives = DEATH_MAX_LIVES;   // 목숨이 다 떨어져 진짜 사망 → 다음 생을 위해 목숨 재충전
    persistSoon();
    sendTo(p.id, { type: 'death_final', lives: st.deathLives });   // 클라이언트는 일반 사망 처리(코인 손실 등)
    pushDeathState(p.key);
  }
}


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
  worldboss: ['slam', 'breath', 'meteor', 'charge', 'nova', 'leap'],
  volcanolord: ['slam', 'breath', 'meteor', 'charge', 'nova'],
  zeus: ['slam', 'meteor', 'nova', 'breath']
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
  if (inSafeAny(p.x, p.z)) return;
  dmg = Math.max(1, Math.floor(dmg * dmgTakenMult(p, now)));   // 죽음의 회피: 받는 피해 x0.1
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
const BOSS_SHIELD_ELEMS = { heavenlord:'holy', abysslord:'ice' }; // 천상 지역 보스와 포세이돈은 원소 쉴드 사용
const WB_CRYSTALS = 4, WB_SHIELD_REGEN = 0.005;   // 수정 쉴드: 수정 4개(각 보스 최대체력 10%), 쉴드 중 초당 0.5% 회복
const SHIELD_NAMES = { fire:'화염 쉴드', ice:'서리 쉴드', dark:'암흑 쉴드', poison:'독 쉴드', holy:'신성 쉴드', all:'만능 쉴드' };
function maybeStartShield(m, d) { /* 모든 보스 쉴드 비활성화 */ }
function spawnCrystals(m, d, hpEach) { /* 보스 쉴드용 수정 소환 비활성화 */ }
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
  // 보스 쉴드/수정 페이즈 비활성화
  if (m.shield) m.shield = null;
  if (m.crystals) { m.crystals = null; sendNear(m.x, m.z, {type:'cr_clear', id:m.id}); }
  // 장판: 주기적으로 월드보스/마왕
  if ((m.type === 'worldboss' || m.type === 'demonlord' || m.type === 'balrog') && !m.floor && !(m.shield && m.shield.crystal)) {
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
  for (const p of players.values()) if (p.hp > 0 && !inSafeAny(p.x, p.z)) alive.push(p);
  for (const m of monsters.values()) {
    const d = MT[m.type]; if (!d) continue;
    if (m.dead) { m.rt -= dt; if (m.rt <= 0) respawnMonster(m); continue; }
    // 하데스의 검 화염: 모든 몬스터/보스에게 면역 없이 최대 체력의 1%를 1초마다 적용
    if (m.fireDot && now >= m.fireDot.next) {
      m.fireDot.next = now + 1000;
      m.hp -= Math.max(1, Math.floor(m.mhp * 0.01)); m.ver++;
      if (m.hp <= 0) {
        const w = wsById.get(m.fireDot.source), p = w && w.player;
        if (p) {
          const oxp=p.x, ozp=p.z, oldShield=m.shield;
          p.x=m.x; p.z=m.z; m.hp=1; m.shield=null;
          try { applyPlayerHit(p,w,m.id,1,0,'fire'); } catch(e) { m.hp=0; m.dead=true; m.rt=MT[m.type].rt; }
          p.x=oxp; p.z=ozp; if (m.dead) m.fireDot=null; else m.shield=oldShield;
        } else { m.hp=0; m.dead=true; m.rt=MT[m.type].rt; m.cast=null; m.shield=null; m.fireDot=null; m.ver++; }
      }
      if (m.dead) continue;
    }
    const ox = m.x, oz = m.z, ohp = m.hp, oface = m.face;
    m.cd -= dt; m.t += dt * 4;
    // 빙결 중에는 넉백 이동도 정지시켜 공격/이동 상태가 재개되지 않도록 한다.
    if (m.stun > 0) { m.kx = 0; m.kz = 0; }
    if (m.kx || m.kz) {
      m.x += m.kx * dt * 5; m.z += m.kz * dt * 5;
      const f = Math.pow(0.86, dt * 60); m.kx *= f; m.kz *= f;
      if (Math.abs(m.kx) + Math.abs(m.kz) < 0.2) m.kx = m.kz = 0;
    }
    const ag = d.ag || (d.boss ? 40 : 15), reach = d.reach * 1.3;
    let tgt = null, td = 1e9, nearAny = 1e9;
    // 보스 어그로: 일반과 비슷하게, 홈에서 멀어지면 강제 해제 (끝없는 추격 방지)
    const agR = d.boss ? Math.min(ag * 1.2, ag + 10) : ag;
    const stickR = d.boss ? ag * 1.4 : ag * 1.4;
    const leash = d.boss ? Math.max(50, ag * 1.6) : ag * 2.2;
    const homeDist = Math.hypot(m.x - m.home[0], m.z - m.home[1]);
    for (const p of alive) {
      const dd = Math.hypot(p.x - m.x, p.z - m.z);
      if (dd < nearAny) nearAny = dd;
      const inVillageCore = !d.boss && Math.hypot(m.x, m.z) <= 17;
      // 신전/신구역 안: 보스 본인만 어그로, 다른 몬스터는 무시
      if (!d.boss && inBossSanctuary(p.x, p.z)) continue;
      if (d.boss && inBossSanctuary(p.x, p.z)) {
        // 해당 보스 구역의 그 보스만 (다른 보스는 추적 안 함)
        const isOwn = Math.hypot(p.x - m.home[0], p.z - m.home[1]) < 70;
        if (!isOwn) continue;
      }
      if (!inVillageCore && dd < agR && dd < td) { td = dd; tgt = p; }
    }
    // 홈에서 leash 넘으면 어그로 강제 해제 → 홈 복귀
    if (homeDist > leash) { tgt = null; m._lastTgtId = null; }
    if (!tgt && m._lastTgtId) {
      const lp = alive.find(p => p.id === m._lastTgtId);
      if (lp) {
        const dd = Math.hypot(lp.x - m.x, lp.z - m.z);
        if (dd < stickR && homeDist <= leash) { tgt = lp; td = dd; }
      }
    }
    if (tgt) { m._lastTgtId = tgt.id; if (!m._ret) m._ret = [m.x, m.z]; }   // 어그로가 걸리기 전 위치 기억
    else if (nearAny > stickR || homeDist > leash) m._lastTgtId = null;
    // ★ 마검사 아이스볼: 스턴 중에는 이동·공격·스킬·쉴드 시전 불가 (월드보스는 면역)
    let stunned = false;
    if (m.stun > 0) {
      if (m.type === 'worldboss' || m.type === 'zeus') m.stun = 0;
      else { m.stun -= dt; if (m.stun > 0) stunned = true; else { m.stun = 0; m.ver++; } }
    }
    // 제우스 패턴: 신 지역 구름 군도에 무작위 낙뢰, 적중 시 HP 2,000 감소
    if (m.type === 'zeus') {
      m._lightningT = (m._lightningT == null ? rnd(3,5) : m._lightningT) - dt;
      if (m._lightningT <= 0) {
        m._lightningT = rnd(3.5,6.5);
        const lx=rnd(835,1045), lz=rnd(-1180,-920);
        sendNear(lx,lz,{type:'zeus_lightning',x:lx,z:lz,r:4,dmg:2000},AOI_RADIUS+60);
        for (const pl of alive) if (pl.x>=820&&pl.x<=1060&&pl.z>=-1200&&pl.z<=-900&&Math.hypot(pl.x-lx,pl.z-lz)<=4) bossHit(m,pl,2000,now);
      }
    }
    if (d.boss && !stunned) tickBossGimmick(m, d, dt, now, alive);
    const wbLock = false; // 보스 쉴드 제거: 이동/공격/스킬 제한 없음
    const casting = (d.boss && !wbLock && !stunned) ? bossSkillTick(m, d, dt, now, alive, tgt, td) : false;
    if (stunned) { m.cast = null; }
    else if (casting) { /* 보스 특수 패턴 시전 중 */ }
    else if (wbLock) { if (tgt) m.face = Math.atan2(tgt.x - m.x, tgt.z - m.z); }
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
        if (w && w.readyState === WebSocket.OPEN) { try { w.send(JSON.stringify({ type: 'mdmg', id: m.id, dmg: Math.max(1, Math.floor(d.dmg * dmgTakenMult(tgt, now))), mt: m.type })); } catch {} }
      }
    } else if (!m.kx && !m.kz) {
      const rt = m._ret || m.home;
      const hx = rt[0] - m.x, hz = rt[1] - m.z, hd = Math.hypot(hx, hz);
      if (m._ret && hd <= 1.2) m._ret = null;   // 복귀 완료
      // 어그로 해제 시 홈 복귀만 (체력 리젠 없음)
      const noAggro = true;   // 어그로가 풀리면 (근처에 플레이어가 있어도) 즉시 복귀
      if (d.boss) {
        if (noAggro && hd > 1) {
          m.x += hx / hd * 12 * dt; m.z += hz / hd * 12 * dt; m.face = Math.atan2(hx, hz);
        }
      } else if (hd > 1.2) {
        const s = Math.min(hd, 13 * dt);
        m.x += hx / hd * s; m.z += hz / hd * s; m.face = Math.atan2(hx, hz);
      }
    }
    // 이동 가능 영역(절벽 등) / 마을 진입 방지
    if (!inW(m.x, m.z)) { m.x = m.px; m.z = m.pz; } else { m.px = m.x; m.pz = m.z; }
    const er = Math.hypot(m.x, m.z);
    if (er < VILLAGE_R && er > 0) { m.x *= VILLAGE_R / er; m.z *= VILLAGE_R / er; }
    if (inAngelVillage(m.x, m.z)) { // 천사마을 진입 방지: 가장 가까운 가장자리 밖으로 밀어낸다
      const A = ANGEL_VILLAGE, dl = m.x - A.x0, dr = A.x1 - m.x, dn = m.z - A.z0, ds = A.z1 - m.z, mn = Math.min(dl, dr, dn, ds);
      if (mn === dl) m.x = A.x0 - 1; else if (mn === dr) m.x = A.x1 + 1; else if (mn === dn) m.z = A.z0 - 1; else m.z = A.z1 + 1;
      if (!inW(m.x, m.z)) { m.x = m.px; m.z = m.pz; } else { m.px = m.x; m.pz = m.z; }
    }
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
app.use('/api/admin/map-overrides', express.json({limit:'4mb',strict:true}));
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
    db.states[key]={version:1,player:{x:0,z:8,y:0,hp:100,mhp:100,lv:1,xp:0,nx:30,coin:0,at:0,face:0,inv:0,w:0,a:0,pot:[2,0,0,0],rg:0,ow:[0],oa:[0],qa:{},qd:[],questProgress:{},godUnlocked:false,hadesSword:false,godQuestAccepted:false,godQuestDone:false,deathSkills:{guide:false,scythe:false,evadeUntil:0,spears:false,soul:false},deathLives:2,deathReborn:false},camera:{},savedAt:Date.now()};
  }
  const p=db.states[key].player;
  if(!Array.isArray(p.pot)) p.pot=[2,0,0,0];
  while(p.pot.length<4) p.pot.push(0);
  if(!Array.isArray(p.ow)) p.ow=[0];
  if(!Array.isArray(p.oa)) p.oa=[0];
  if(!Array.isArray(p.sw)) p.sw=[]; p.sw=p.sw.filter(v=>![21,22,23,24].includes(v));   // 마검사 자동공격용 "검 도감" (환생해도 유지, 천상 검 제외)
  if(!p.qa || typeof p.qa!=='object') p.qa={};
  if(!Array.isArray(p.qd)) p.qd=[];
  if(!p.questProgress || typeof p.questProgress!=='object') p.questProgress={};
  if(typeof p.we!=='number'||!Number.isFinite(p.we)) p.we=0;
  if(typeof p.ae!=='number'||!Number.isFinite(p.ae)) p.ae=0;
  p.we=Math.max(0,Math.min(15,Math.floor(p.we)));
  p.ae=Math.max(0,Math.min(15,Math.floor(p.ae)));
  if(!p.items||typeof p.items!=='object') p.items={};
  if(typeof p.rebirth!=='number'||!Number.isFinite(p.rebirth)) p.rebirth=0;
  p.rebirth=Math.max(0,Math.min(1000000,Math.floor(p.rebirth)));
  if(typeof p.rcoin!=='number'||!Number.isFinite(p.rcoin)) p.rcoin=0;
  p.rcoin=Math.max(0,Math.min(1e9,Math.floor(p.rcoin)));
  if(typeof p.title!=='string') p.title='';
  if(!Array.isArray(p.achievementIds)) p.achievementIds=[];
  if(!Array.isArray(p.unlockedTitles)) p.unlockedTitles=[];
  if(typeof p.equippedTitle!=='string') p.equippedTitle='';
  if(!p.deathSkills||typeof p.deathSkills!=='object') p.deathSkills={};
  p.deathSkills={guide:!!p.deathSkills.guide,scythe:!!p.deathSkills.scythe,evadeUntil:Math.max(0,Math.floor(Number(p.deathSkills.evadeUntil)||0)),spears:!!p.deathSkills.spears,soul:!!p.deathSkills.soul,evadeCd:Math.max(0,Math.floor(Number(p.deathSkills.evadeCd)||0))};
  p.deathLives=Math.max(0,Math.min(2,Math.floor(Number(p.deathLives==null?2:p.deathLives)||0)));
  p.deathReborn=!!p.deathReborn;
  p.deathCutsceneDone=!!p.deathCutsceneDone; if(p.rebirth>=500){p.job='deathgod';}
  if(!p.bank||typeof p.bank!=='object') p.bank={coin:0,items:{}};
  if(typeof p.bank.coin!=='number'||!Number.isFinite(p.bank.coin)) p.bank.coin=0;
  if(!p.bank.items||typeof p.bank.items!=='object') p.bank.items={};
  if(!p.talents||typeof p.talents!=='object') p.talents={};
  if(typeof p.talentPts!=='number'||!Number.isFinite(p.talentPts)) p.talentPts=0;
  p.talentPts=Math.max(0,Math.min(500,Math.floor(p.talentPts)));
  if(!Array.isArray(p.runes)) p.runes=[];
  if(!p.runeEq||typeof p.runeEq!=='object') p.runeEq={w:null,a:null,u:null};
  if(typeof p.towerBest!=='number'||!Number.isFinite(p.towerBest)) p.towerBest=0;
  p.towerBest=Math.max(0,Math.min(9999,Math.floor(p.towerBest)));
  if(typeof p.towerDaily!=='number') p.towerDaily=0;
  if(typeof p.towerDailyAt!=='number') p.towerDailyAt=0;
  if(typeof p.rstat!=='number'||!Number.isFinite(p.rstat)) p.rstat=0;
  p.rstat=Math.max(0,Math.min(1e6,Math.floor(p.rstat)));
  if(!p.rbMult||typeof p.rbMult!=='object') p.rbMult={atk:0,hp:0,exp:0,rcoin:0,rebirth:0,rstat:0};
  for(const k of ['atk','hp','exp','rcoin','rebirth','rstat']){
    if(typeof p.rbMult[k]!=='number'||!Number.isFinite(p.rbMult[k])) p.rbMult[k]=0;
    p.rbMult[k]=Math.max(0,Math.min(30,Math.floor(p.rbMult[k])));
  }
  return p;
}
// ===== 저장 데이터 보강: 알려지지 않은 클라이언트 필드도 (크기 제한 안에서) MongoDB 에 보존 =====
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const KNOWN_PLAYER_KEYS = new Set(['x','z','y','hp','mhp','lv','xp','nx','coin','at','face','inv','w','a','rg','pot','ow','oa','sw','items','qa','qd','questProgress','godUnlocked','hadesSword','godQuestAccepted','godQuestDone','job','msUnlocked','jstep','jm','jhp','we','ae','rebirth','rcoin','title','achievementIds','unlockedTitles','equippedTitle','deathSkills','deathLives','deathReborn','deathCutsceneDone','talents','talentPts','runes','runeEq','towerBest','towerDaily','towerDailyAt','rstat','rbMult','sbk','sks','look','bank','stats','guild','party']);
function cleanExtraVal(v, depth) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.max(-1e12, Math.min(1e12, v)) : undefined;
  if (typeof v === 'string') return v.slice(0, 200);
  if (depth >= 3 || v === null || typeof v !== 'object') return undefined;
  if (Array.isArray(v)) { const a = []; for (const x of v.slice(0, 100)) { const c = cleanExtraVal(x, depth + 1); if (c !== undefined) a.push(c); } return a; }
  const o = {}; let n = 0;
  for (const [k, x] of Object.entries(v)) {
    if (n >= 50) break;
    if (!SAFE_KEY.test(k) || k === 'constructor' || k === 'prototype') continue;
    const c = cleanExtraVal(x, depth + 1); if (c !== undefined) { o[k] = c; n++; }
  }
  return o;
}
function copyExtraPlayerFields(p, player) {
  let n = 0, size = 0;
  for (const [k, v] of Object.entries(p)) {
    if (n >= 60) break;
    if (KNOWN_PLAYER_KEYS.has(k) || !SAFE_KEY.test(k) || k === 'constructor' || k === 'prototype') continue;
    const c = cleanExtraVal(v, 0); if (c === undefined) continue;
    const s = JSON.stringify(c).length; if (size + s > 20000) continue;
    size += s; player[k] = c; n++;
  }
}
// 서버가 권한을 가진 값(환생 횟수, 죽음의 신 상태)은 클라이언트의 오래된 저장본이 덮어쓰지 못하게 한다
function keepServerAuth(prev, np) {
  if (!prev || !np) return;
  if ((prev.rebirth | 0) > (np.rebirth | 0)) np.rebirth = prev.rebirth | 0;
  if (prev.deathSkills && typeof prev.deathSkills === 'object') np.deathSkills = Object.assign({}, prev.deathSkills);
  if (prev.deathLives != null) np.deathLives = prev.deathLives;
  if (prev.deathReborn) np.deathReborn = true;
  if (prev.deathCutsceneDone) np.deathCutsceneDone = true;
  if (!np.title && prev.title) np.title = prev.title;
  if ((np.rebirth | 0) >= DEATH_REBIRTH) np.job = 'deathgod';
}
function cleanState(input){
 if(!input||typeof input!=='object'||Array.isArray(input))return null;
 const p=input.player,c=input.camera;if(!p||typeof p!=='object'||Array.isArray(p))return null;
 const fields=['x','z','y','hp','mhp','lv','xp','nx','coin','at','face','inv','w','a','rg'],player={};
 for(const k of fields){const v=p[k];if(typeof v==='number'&&Number.isFinite(v)){const cap=(k==='coin'||k==='xp'||k==='nx')?1e9:1000000;player[k]=Math.max(-cap,Math.min(cap,v));}}
 player.x=Math.max(-1100,Math.min(1100,Number(player.x)||0));player.z=Math.max(-2400,Math.min(400,Number(player.z)||0));
 player.lv=Math.max(1,Math.min(1e6,Math.floor(Number(player.lv)||1)));player.mhp=Math.max(1,Math.min(100000,Number(player.mhp)||100));player.hp=Math.max(0,Math.min(player.mhp,Number(player.hp)||0));
 player.coin=Math.max(0,Math.min(1e9,Math.floor(Number(player.coin)||0)));player.xp=Math.max(0,Math.min(1e9,Math.floor(Number(player.xp)||0)));
 player.pot=Array.isArray(p.pot)?p.pot.slice(0,8).map(v=>Math.max(0,Math.min(999,Math.floor(Number(v)||0)))):[2,0,0,0];
 if(Array.isArray(p.ow)) player.ow=p.ow.filter(v=>Number.isInteger(v)&&v>=0&&v<40).slice(0,40);
 if(Array.isArray(p.oa)) player.oa=p.oa.filter(v=>Number.isInteger(v)&&v>=0&&v<40).slice(0,40);
 if(Array.isArray(p.sw)) player.sw=[...new Set(p.sw.filter(v=>Number.isInteger(v)&&v>=0&&v<40&&![21,22,23,24].includes(v)))].slice(0,40);
 if(p.items && typeof p.items==='object' && !Array.isArray(p.items)){
  const it={};let n=0;
  for(const [k,v] of Object.entries(p.items)){
   if(n>=120) break;
   if(/^[A-Za-z0-9_]{1,24}$/.test(k) && Number.isFinite(Number(v))){it[k]=Math.max(0,Math.min(999999,Math.floor(Number(v))));n++;}
  }
  player.items=it;
 }
 if(p.qa && typeof p.qa==='object' && !Array.isArray(p.qa)){
  const qa={}; let n=0;
  for(const [k,v] of Object.entries(p.qa)){
    if(n>=30) break;
    if(typeof k==='string' && /^[A-Za-z0-9_-]{1,24}$/.test(k) && Number.isFinite(Number(v))){
      qa[k]=Math.max(0,Math.min(100000,Math.floor(Number(v)))); n++;
    }
  }
  player.qa=qa;
 }
 if(Array.isArray(p.qd)) player.qd=p.qd.filter(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,24}$/.test(v)).slice(0,100);
 if(p.questProgress && typeof p.questProgress==='object' && !Array.isArray(p.questProgress)){
  const qp={}; let n=0;
  for(const [k,v] of Object.entries(p.questProgress)){
    if(n>=30) break;
    if(typeof k==='string' && /^[A-Za-z0-9_-]{1,24}$/.test(k) && Number.isFinite(Number(v))){
      qp[k]=Math.max(0,Math.min(100000,Math.floor(Number(v)))); n++;
    }
  }
  player.questProgress=qp;
  // qa 없으면 questProgress로 채움
  if(!player.qa) player.qa=Object.assign({}, qp);
 }
 if(p.godUnlocked===true) player.godUnlocked=true;
 if(p.hadesSword===true) player.hadesSword=true;
 if(p.godQuestAccepted===true) player.godQuestAccepted=true;
 if(p.godQuestDone===true) player.godQuestDone=true;
 if(typeof p.job==='string'&&/^[a-z_]{1,24}$/.test(p.job)) player.job=p.job;
 if(p.msUnlocked===true||p.job==='magesword') player.msUnlocked=true;
 if(Number.isFinite(Number(p.jstep))) player.jstep=Math.max(0,Math.min(10,Number(p.jstep)));
 if(Number.isFinite(Number(p.jm))) player.jm=Math.max(0.1,Math.min(5,Number(p.jm)));
 if(Number.isFinite(Number(p.jhp))) player.jhp=Math.max(0.1,Math.min(5,Number(p.jhp)));
 if(Number.isFinite(Number(p.we))) player.we=Math.max(0,Math.min(15,Math.floor(Number(p.we))));
 if(Number.isFinite(Number(p.ae))) player.ae=Math.max(0,Math.min(15,Math.floor(Number(p.ae))));
 if(Number.isFinite(Number(p.rebirth))) player.rebirth=Math.max(0,Math.min(1000000,Math.floor(Number(p.rebirth))));
 if(Number.isFinite(Number(p.rcoin))) player.rcoin=Math.max(0,Math.min(1e9,Math.floor(Number(p.rcoin))));
 if(typeof p.title==='string') player.title=String(p.title).slice(0,24);
 if(p.deathSkills&&typeof p.deathSkills==='object'&&!Array.isArray(p.deathSkills)){const ds=p.deathSkills;player.deathSkills={guide:!!ds.guide,scythe:!!ds.scythe,evadeUntil:Math.max(0,Math.floor(Number(ds.evadeUntil)||0)),spears:!!ds.spears,soul:!!ds.soul,evadeCd:Math.max(0,Math.floor(Number(ds.evadeCd)||0))};}
 if(Number.isFinite(Number(p.deathLives))) player.deathLives=Math.max(0,Math.min(2,Math.floor(Number(p.deathLives))));
 if(p.deathReborn===true) player.deathReborn=true;
 if(Number(p.rebirth)>=500){player.job='deathgod';player.deathLives=Math.max(1,player.deathLives==null?2:player.deathLives);}
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
 if(Number.isFinite(Number(p.rstat))) player.rstat=Math.max(0,Math.min(1e6,Math.floor(Number(p.rstat))));
 if(p.rbMult&&typeof p.rbMult==='object'&&!Array.isArray(p.rbMult)){
  const rm={}; for(const k of ['atk','hp','exp','rcoin','rebirth','rstat']){
    const v=Number(p.rbMult[k]); if(Number.isFinite(v)) rm[k]=Math.max(0,Math.min(30,Math.floor(v)));
  }
  player.rbMult=rm;
 }
 if(Array.isArray(p.sbk)) player.sbk=p.sbk.filter(v=>typeof v==='string'&&/^[A-Za-z0-9_]{1,32}$/.test(v)).slice(0,60);
 if(Array.isArray(p.sks)) player.sks=p.sks.filter(v=>typeof v==='string'&&v.length>0&&v.length<=24).slice(0,8);
 if(p.look&&typeof p.look==='object'&&!Array.isArray(p.look)){const lk={};for(const k of['skin','hair','hs','hat','cape','wing','halo','glass','aura','shirt','pants','boot','face','tail']){const v=Number(p.look[k]);if(Number.isFinite(v)&&v>=0&&v<=0xffffff)lk[k]=Math.floor(v);}player.look=lk;}
 if(p.deathCutsceneDone===true) player.deathCutsceneDone=true;
 copyExtraPlayerFields(p,player);
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
 if(db.states[key]&&db.states[key].player)ensurePlayer(key);res.json({death:deathInfo(key),user:u.username,state:db.states[key]||null,isAdmin:!!u.isAdmin,token});
});
app.get('/api/me',(req,res)=>{const key=userFromReq(req);if(!key)return res.status(401).json({error:'로그인이 필요합니다.'});const u=db.users[key];if(u.banned||(db.bans&&db.bans[key]))return res.status(403).json({error:'차단된 계정입니다.'});const token=newToken(key);cookie(req,res,token);if(db.states[key]&&db.states[key].player)ensurePlayer(key);res.json({death:deathInfo(key),user:publicName(key),state:db.states[key]||null,isAdmin:!!u.isAdmin,token});});
app.post('/api/save',requireUser,(req,res)=>{
  const state=cleanState(req.body&&req.body.state);
  if(!state)return res.status(400).json({error:'저장 데이터 형식이 올바르지 않습니다.'});
  // 기존 서버 권한 수치(코인/장비 구매 등)가 더 최신이면 보존
  const prev = db.states[req.userKey] && db.states[req.userKey].player;
  if(prev){
    const np = state.player;
    // ★ 코인 롤백 방지: 서버 값이 더 크면 서버 유지
    if(typeof prev.coin==='number' && typeof np.coin==='number' && prev.coin > np.coin){
      np.coin = prev.coin;
    }
    if((prev.rcoin|0) > (np.rcoin|0)) np.rcoin = prev.rcoin|0;
    if((prev.rstat|0) > (np.rstat|0)) np.rstat = prev.rstat|0;
    if(prev.rbMult && typeof prev.rbMult==='object'){
      if(!np.rbMult) np.rbMult={};
      for(const k of ['atk','hp','exp','rcoin','rebirth','rstat']){
        if((prev.rbMult[k]|0) > (np.rbMult[k]|0)) np.rbMult[k] = prev.rbMult[k]|0;
      }
    }
    // 서버 구매 기록이 장비 보유의 단일 기준이다.
    // 이전 클라이언트 저장본과 합집합하면 환생 때 초기화한 일반 장비가 되살아나
    // 상점에서 '이미 보유' 오류가 발생하므로 서버 목록으로 덮어쓴다.
    if(Array.isArray(prev.ow)) np.ow = prev.ow.filter(v=>Number.isInteger(v)&&v>=0).slice(0,40);
    if(Array.isArray(prev.oa)) np.oa = prev.oa.filter(v=>Number.isInteger(v)&&v>=0).slice(0,40);
    // 검 도감(sw) 합집합 (환생 후에도 유지)
    if(Array.isArray(prev.sw)){
      const s=new Set([...prev.sw, ...(Array.isArray(np.sw)?np.sw:[])]); np.sw=[...s].filter(v=>Number.isInteger(v)&&v>=0&&v<40&&![21,22,23,24].includes(v)).slice(0,40);
    }
    // 레벨은 더 높은 쪽 유지 (롤백 방지)
    if((prev.lv|0) > (np.lv|0)){
      np.lv = prev.lv; np.xp = Math.max(np.xp|0, prev.xp|0); np.nx = prev.nx || np.nx;
    }
  }
  if(prev&&prev.bank) state.player.bank=prev.bank;
  if(prev&&prev.msUnlocked) state.player.msUnlocked=true;
  if(prev){
    if(prev.rstat!=null && state.player.rstat==null) state.player.rstat=prev.rstat;
    if(prev.rbMult && !state.player.rbMult) state.player.rbMult=prev.rbMult;
    if(prev.rcoin!=null && state.player.rcoin==null) state.player.rcoin=prev.rcoin;
    if(prev.rebirth!=null && state.player.rebirth==null) state.player.rebirth=prev.rebirth;
  }
  keepServerAuth(prev, state.player);
  db.states[req.userKey]=state;
  persistSoon();
  res.json({ok:true,savedAt:state.savedAt});
});
app.post('/api/save-beacon',(req,res)=>{const key=userFromReq(req);if(!key)return res.status(401).end();let body=req.body;if(typeof body==='string'){try{body=JSON.parse(body);}catch{return res.status(400).end();}}const state=cleanState(body&&body.state);if(!state)return res.status(400).end();{const pv=db.states[key]&&db.states[key].player;if(pv){if(pv.bank)state.player.bank=pv.bank;if(typeof pv.coin==='number'&&typeof state.player.coin==='number'&&pv.coin>state.player.coin)state.player.coin=pv.coin;if((pv.rcoin|0)>(state.player.rcoin|0))state.player.rcoin=pv.rcoin|0;if((pv.rstat|0)>(state.player.rstat|0))state.player.rstat=pv.rstat|0;}}keepServerAuth(db.states[key]&&db.states[key].player,state.player);db.states[key]=state;persistSoon();res.status(204).end();});
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
  const repeatableGodQuest = questId.startsWith('god_') && !!QUESTS[questId];
  if (!repeatableGodQuest && player.qd.includes(questId)) return res.status(400).json({ error: '이미 완료한 퀘스트입니다.' });
  if (player.qa[questId] !== undefined) return res.status(400).json({ error: '이미 수락한 퀘스트입니다.' });
  if (!repeatableGodQuest && Object.keys(player.qa).length >= 5) return res.status(400).json({ error: '퀘스트는 동시에 5개까지 받을 수 있습니다.' });
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
  const repeatableGodQuest = questId.startsWith('god_') && !!QUESTS[questId];
  if (!repeatableGodQuest && player.qd.includes(questId)) return res.status(400).json({ error: '이미 완료한 퀘스트입니다.' });
  const def = QUESTS[questId];
  const needN = def ? def.need : (Number.isInteger(need) ? Math.min(100000, Math.max(1, need)) : 1);
  const coinR = def ? def.coin : Math.max(0, Math.min(1e7, Math.floor(Number(rewardCoin) || 0)));
  const xpR = def ? def.xp : Math.max(0, Math.min(1e7, Math.floor(Number(rewardXp) || 0)));
  const prog = player.questProgress[questId] || player.qa[questId] || 0;
  if (prog < needN) return res.status(400).json({ error: '아직 퀘스트 조건을 충족하지 않았습니다.', progress: prog, need: needN });
  player.coin = (player.coin || 0) + coinR;
  player.xp = (player.xp || 0) + xpR;
  delete player.qa[questId];
  if (!repeatableGodQuest && !player.qd.includes(questId)) player.qd.push(questId);
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
  if(!Number.isFinite(lv)||lv<1||lv>1e6) return res.status(400).json({error:'레벨은 1 이상의 정수입니다.'});
  const key=usernameKey(username);
  if(!db.users[key]) return res.status(404).json({error:'사용자를 찾을 수 없습니다.'});
  const p=ensurePlayer(key);
  p.lv=lv;
  p.xp=0;
  // Lv50 이후 경험치 곡선 완화 (1.15 → 1.10)
  if(lv<=50) p.nx=Math.max(30, Math.floor(30*Math.pow(1.15, lv-1)));
  else p.nx=Math.max(30, Math.floor(30*Math.pow(1.15, 49)*Math.pow(1.10, lv-50)));
  // 체력도 대략 맞춤
  const base=100;
  p.mhp=Math.max(p.mhp||base, base + (lv-1)*15);
  p.hp=p.mhp;
  db.states[key].savedAt=Date.now();
  try{persist();}catch(e){}
  pushAdminStat(key, {lv:p.lv, xp:p.xp, nx:p.nx, hp:p.hp, mhp:p.mhp, coin:p.coin});
  res.json({ok:true, username:db.users[key].username, lv:p.lv, coin:p.coin, mhp:p.mhp});
});
app.post('/api/admin/unlock-god', requireAdmin, (req,res)=>{
  const {username}=req.body||{};
  if(typeof username!=='string'||!username.trim()) return res.status(400).json({error:'닉네임이 필요합니다.'});
  const key=usernameKey(username);
  if(!db.users[key]) return res.status(404).json({error:'사용자를 찾을 수 없습니다.'});
  const p=ensurePlayer(key); p.godUnlocked=true;
  if(!db.states[key]) db.states[key]={version:1,player:p,camera:{},savedAt:Date.now()};
  db.states[key].player=p; db.states[key].savedAt=Date.now();
  try{persist();}catch(e){return res.status(500).json({error:'저장 실패'});}
  let online=false;
  for(const ws of wss.clients){ if(ws._userKey===key&&ws.readyState===WebSocket.OPEN){online=true;try{ws.send(JSON.stringify({type:'admin_action',action:'unlock_god'}));}catch{}} }
  // Update in-memory player state immediately for server-side checks.
  for(const pl of players.values()) if(pl.key===key) pl.godUnlocked=true;
  res.json({ok:true,username:db.users[key].username,online, godUnlocked:true});
});
app.post('/api/admin/magesword', requireAdmin, (req,res)=>{
  const {username}=req.body||{};
  if(typeof username!=='string'||!username.trim()) return res.status(400).json({error:'닉네임이 필요합니다.'});
  const key=usernameKey(username);
  if(!db.users[key]) return res.status(404).json({error:'사용자를 찾을 수 없습니다.'});
  const p=ensurePlayer(key); p.job='magesword'; p.msUnlocked=true; p.jstep=0.34; p.jm=1.3; p.jhp=1.6; p.godUnlocked=true;
  if(!db.states[key]) db.states[key]={version:1,player:p,camera:{},savedAt:Date.now()};
  db.states[key].player=p; db.states[key].savedAt=Date.now();
  try{persist();}catch(e){return res.status(500).json({error:'저장 실패'});}
  let online=false;
  for(const ws of wss.clients){ if(ws._userKey===key&&ws.readyState===WebSocket.OPEN){online=true;try{ws.send(JSON.stringify({type:'admin_action',action:'magesword'}));}catch{}} }
  for(const pl of players.values()) if(pl.key===key){pl.job='magesword';pl.msUnlocked=true;pl.godUnlocked=true;}
  res.json({ok:true,username:db.users[key].username,online,job:p.job,msUnlocked:true,godUnlocked:true});
});

app.post('/api/admin/set-rebirth', requireAdmin, (req,res)=>{
  const {username, rebirth} = req.body||{};
  if(typeof username!=='string') return res.status(400).json({error:'아이디가 필요합니다.'});
  const rb=Math.floor(Number(rebirth));
  if(!Number.isFinite(rb)||rb<0||rb>1e6) return res.status(400).json({error:'환생 횟수가 올바르지 않습니다.'});
  const key=usernameKey(username);
  if(!db.users[key]) return res.status(404).json({error:'사용자를 찾을 수 없습니다.'});
  const p=ensurePlayer(key); const prev=p.rebirth|0; p.rebirth=rb;
  if(rb>=DEATH_REBIRTH){
    if(prev<DEATH_REBIRTH){ p.deathLives=2; p.deathReborn=false; p.deathSkills={guide:false,scythe:false,evadeUntil:0,spears:false,soul:false,harvest:false,execution:false,executionUntil:0,evadeCd:0}; p.deathCutsceneDone=false; }
    p.title='죽음의 신';
  } else if(prev>=DEATH_REBIRTH && p.job==='deathgod'){ p.job=''; p.deathCutsceneDone=false; }
  db.states[key].savedAt=Date.now();
  try{persist();}catch(e){}
  const first = rb>=DEATH_REBIRTH ? awakenDeathGod(key,p) : false;
  if(rb<DEATH_REBIRTH) pushDeathState(key);
  res.json({ok:true, username:db.users[key].username, rebirth:p.rebirth, job:p.job, deathAwakened:first});
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

// ===== 관리자 맵/장비 모델 오버라이드 =====
function cleanXform(o) {
  const x=Number(o.x), y=Number(o.y), z=Number(o.z);
  const rx=Number(o.rx)||0, ry=Number(o.ry)||0, rz=Number(o.rz)||0;
  const sx=Number(o.sx), sy=Number(o.sy), sz=Number(o.sz);
  if (![x,y,z].every(Number.isFinite)) return null;
  return {
    x: Math.round(x*1000)/1000, y: Math.round(y*1000)/1000, z: Math.round(z*1000)/1000,
    rx: Math.round(rx*1000)/1000, ry: Math.round(ry*1000)/1000, rz: Math.round(rz*1000)/1000,
    sx: Number.isFinite(sx) ? Math.min(12, Math.max(0.05, Math.round(sx*1000)/1000)) : 1,
    sy: Number.isFinite(sy) ? Math.min(12, Math.max(0.05, Math.round(sy*1000)/1000)) : 1,
    sz: Number.isFinite(sz) ? Math.min(12, Math.max(0.05, Math.round(sz*1000)/1000)) : 1
  };
}
function _n(v, def, lo, hi) { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v*1000)/1000)) : def; }
function bossList() { const o = {}; for (const [t, d] of Object.entries(MT)) if (d.fix) o[t] = { x: d.fix[0], z: d.fix[1], nm: d.nm || t }; return o; }
function applySpawns(sp) {
  for (const [t, v] of Object.entries(sp || {})) {
    const d = MT[t]; if (!d || !d.fix || !Array.isArray(v)) continue;
    d.fix = [v[0], v[1]]; if (WORLD.BOSS[t]) WORLD.BOSS[t] = [v[0], v[1]];
    for (const m of monsters.values()) { if (m.type !== t) continue; m.x = m.px = v[0]; m.z = m.pz = v[1]; m.home = [v[0], v[1]]; m.kx = m.kz = 0; m.ver++; }
  }
  BOSS_POS.length = 0; BOSS_POS.push(...Object.values(WORLD.BOSS));
}
function cleanPart(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    t: ['b','s','c','n'].includes(p.t) ? p.t : 'b',
    c: Math.max(0, Math.min(0xffffff, Number(p.c)|0)), e: p.e ? 1 : 0,
    x: _n(p.x,0,-500,500), y: _n(p.y,0,-100,500), z: _n(p.z,0,-500,500),
    rx: _n(p.rx,0,-20,20), ry: _n(p.ry,0,-20,20), rz: _n(p.rz,0,-20,20),
    sx: _n(p.sx,1,0.01,400), sy: _n(p.sy,1,0.01,400), sz: _n(p.sz,1,0.01,400)
  };
}
app.get('/api/admin/map-overrides', requireAdmin, (req, res) => {
  const mo = db.mapOverrides || { version:1, objects:[], equipment:{} };
  res.json({ ok:true, version: mo.version|0, objects: mo.objects||[], equipment: mo.equipment||{}, models: mo.models||{}, sandbox: mo.sandbox||[], mapEdits: mo.mapEdits||[], bosses: bossList(), updatedAt: mo.updatedAt||null });
});
app.get('/api/map-overrides', (req, res) => {
  const mo = db.mapOverrides || { version:1, objects:[], equipment:{} };
  res.json({ ok:true, version: mo.version|0, objects: mo.objects||[], equipment: mo.equipment||{}, models: mo.models||{}, sandbox: mo.sandbox||[], mapEdits: mo.mapEdits||[], bosses: bossList() });
});
app.post('/api/admin/map-overrides', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const objects = Array.isArray(body.objects) ? body.objects : null;
  const equipment = body.equipment && typeof body.equipment === 'object' ? body.equipment : null;
  const models = body.models && typeof body.models === 'object' && !Array.isArray(body.models) ? body.models : null;
  const sandbox = Array.isArray(body.sandbox) ? body.sandbox : null;
  if (objects === null && equipment === null && models === null && sandbox === null) return res.status(400).json({ error: 'objects, equipment, models 또는 sandbox 가 필요합니다.' });

  const mo = db.mapOverrides || { version:1, objects:[], equipment:{} };
  if (objects) {
    if (objects.length > 500) return res.status(400).json({ error: '맵 오브젝트는 최대 500개입니다.' });
    const cleaned = [];
    for (const o of objects) {
      if (!o || typeof o !== 'object') continue;
      const id = String(o.id||'').slice(0, 64);
      const kind = String(o.kind||'prop').slice(0, 32);
      if (!id || kind === 'equip') continue;
      const xf = cleanXform(o); if (!xf) continue;
      if (Math.abs(xf.x)>2000 || Math.abs(xf.z)>3000 || xf.y<-5 || xf.y>80) continue;
      cleaned.push({
        id, kind, label: typeof o.label==='string'?o.label.slice(0,48):'',
        ...xf, visible: o.visible===false?false:true,
        meta: o.meta && typeof o.meta==='object' ? o.meta : undefined
      });
    }
    mo.objects = cleaned;
  }
  if (equipment) {
    const eq = {};
    for (const [k, v] of Object.entries(equipment)) {
      const key = String(k).slice(0, 32);
      if (!/^[wa]:\d+$/.test(key)) continue;
      if (!v || typeof v !== 'object') continue;
      const xf = cleanXform(v); if (!xf) continue;
      eq[key] = xf;
    }
    mo.equipment = eq;
  }
  if (models) {
    const out = {};
    for (const [k, v] of Object.entries(models).slice(0, 200)) {
      if (!/^[wah]:\d+$/.test(k) || !v || !Array.isArray(v.parts)) continue;
      out[k] = { parts: v.parts.slice(0, 64).map(cleanPart).filter(Boolean) };
    }
    mo.models = out;
  }
  const mapEdits = Array.isArray(body.mapEdits) ? body.mapEdits : null;
  const spawns = body.spawns && typeof body.spawns === 'object' ? body.spawns : null;
  if (mapEdits) {
    if (mapEdits.length > 3000) return res.status(400).json({ error: '맵 편집은 최대 3000개입니다.' });
    mo.mapEdits = mapEdits.map(e => {
      if (!e || typeof e.k !== 'string') return null;
      const o = { k: e.k.slice(0, 120) }; if (e.del) { o.del = 1; return o; } if (e.ref) o.ref = 1;
      return Object.assign(o, { x:_n(e.x,0,-9000,9000), y:_n(e.y,0,-500,2000), z:_n(e.z,0,-9000,9000), rx:_n(e.rx,0,-20,20), ry:_n(e.ry,0,-20,20), rz:_n(e.rz,0,-20,20), sx:_n(e.sx,1,0.01,500), sy:_n(e.sy,1,0.01,500), sz:_n(e.sz,1,0.01,500) });
    }).filter(Boolean);
  }
  if (spawns) {
    mo.spawns = mo.spawns || {};
    for (const [t, v] of Object.entries(spawns)) {
      if (!MT[t] || !MT[t].fix || !Array.isArray(v)) continue;
      const x = _n(v[0], NaN, -9000, 9000), z = _n(v[1], NaN, -9000, 9000);
      if (Number.isNaN(x) || Number.isNaN(z)) continue; mo.spawns[t] = [x, z];
    }
    applySpawns(mo.spawns);
  }
  if (sandbox) {
    if (sandbox.length > 400) return res.status(400).json({ error: '샌드박스 블록은 최대 400개입니다.' });
    mo.sandbox = sandbox.map(cleanPart).filter(Boolean);
  }
  mo.version = (mo.version|0) + 1;
  mo.updatedAt = Date.now();
  mo.by = req.userKey;
  db.mapOverrides = mo;
  try {
    await persist();   // MongoDB 저장 완료 후에만 재시작
    res.json({ ok:true, version: mo.version, restarting:true, count: (mo.objects||[]).length, equipCount: Object.keys(mo.equipment||{}).length });
    setTimeout(() => {
      try {
        const msg = JSON.stringify({ type:'server_restart', msg:'맵/모델 업데이트가 저장되어 서버가 재시작됩니다.' });
        for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) { try { ws.send(msg); } catch {} }
      } catch {}
      setTimeout(() => {
        try { for (const ws of wss.clients) { try { ws.close(1012, 'restart'); } catch {} } } catch {}
        disconnectFromMongoDB().finally(() => process.exit(0));   // Render 등이 자동으로 다시 기동
      }, 1500);
    }, 300);
  } catch (e) {
    res.status(500).json({ error: '저장 실패: '+(e.message||'') });
  }
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
const REBIRTH_MIN_LV = 50;
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
  {id:'r_crit',name:'치명 룬',opt:'crit',val:5,slot:'w'}, {id:'r_atk',name:'강타 룬',opt:'atk',val:8,slot:'w'},
  {id:'r_fire',name:'화염 룬',opt:'fire',val:12,slot:'w'}, {id:'r_ice',name:'빙결 룬',opt:'ice',val:8,slot:'w'},
  {id:'r_thunder',name:'번개 룬',opt:'thunder',val:10,slot:'w'}, {id:'r_boss',name:'학살 룬',opt:'boss',val:7,slot:'w'},
  {id:'r_lifesteal',name:'흡혈 룬',opt:'ls',val:3,slot:'w'}, {id:'r_execute',name:'처형 룬',opt:'execute',val:4,slot:'w'},
  {id:'r_hp',name:'생명 룬',opt:'hp',val:40,slot:'a'}, {id:'r_dr',name:'수호 룬',opt:'dr',val:4,slot:'a'},
  {id:'r_shield',name:'보호 룬',opt:'shield',val:1,slot:'a'}, {id:'r_reflect',name:'반사 룬',opt:'reflect',val:5,slot:'a'},
  {id:'r_regen',name:'재생 룬',opt:'regen',val:2,slot:'a'}, {id:'r_resist',name:'저항 룬',opt:'resist',val:6,slot:'a'},
  {id:'r_cd',name:'신속 룬',opt:'cd',val:6,slot:'u'}, {id:'r_spd',name:'질주 룬',opt:'spd',val:8,slot:'u'},
  {id:'r_exp',name:'경험 룬',opt:'exp',val:10,slot:'u'}, {id:'r_gold',name:'황금 룬',opt:'gold',val:8,slot:'u'},
  {id:'r_luck',name:'행운 룬',opt:'luck',val:5,slot:'u'}, {id:'r_drop',name:'탐욕 룬',opt:'drop',val:6,slot:'u'},
  {id:'r_tower',name:'시련 룬',opt:'tower',val:5,slot:'u'}, {id:'r_dash',name:'질풍 룬',opt:'dash',val:10,slot:'u'}
];
const RUNE_TIERS = [
  {tier:1,name:'일반',mult:1,weight:55,color:'#b9c0ca'},
  {tier:2,name:'고급',mult:1.35,weight:25,color:'#5bd17b'},
  {tier:3,name:'희귀',mult:1.8,weight:13,color:'#4da6ff'},
  {tier:4,name:'영웅',mult:2.5,weight:6,color:'#bf7bff'},
  {tier:5,name:'신화',mult:4,weight:1,color:'#ffbd45'}
];
function genRuneId(){ return 'R'+crypto.randomBytes(4).toString('hex'); }
function rollRune(){
  const base=RUNE_POOL[(Math.random()*RUNE_POOL.length)|0];
  const roll=Math.random()*100; let sum=0,t=RUNE_TIERS[0];
  for(const x of RUNE_TIERS){sum+=x.weight;if(roll<sum){t=x;break;}}
  return {id:genRuneId(),base:base.id,name:base.name,opt:base.opt,val:Math.max(1,Math.round(base.val*t.mult)),slot:base.slot,tier:t.tier,tierName:t.name,color:t.color};
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
  // 레벨 기반 환생 배수: Lv50→1, Lv100→2, Lv150→3 … (floor(lv/50))
  // 예: 환생0 + Lv100 → 환생 +2
  const lvNow = p.lv|0;
  const rbGain = Math.max(1, Math.floor(lvNow / 50));
  const prevRb = p.rebirth|0;
  p.rebirth = prevRb + rbGain;
  // 기본 보상(환생 1회분) * rbGain * rbMult
  // 환생 코인 1회분 = 5 * 현재환생횟수(증가 후 기준 평균 대용으로 증가분 합산)
  let rcoinBase = 0;
  for(let i=0;i<rbGain;i++){
    const step = (p.rebirth|0) - rbGain + 1 + i; // 각 단계 환생 번호
    rcoinBase += 5 * Math.max(1, step);
  }
  const rcoinGain = Math.floor(rcoinBase * Math.pow(2, (p.rbMult&&p.rbMult.rcoin)|0));
  const rstatGain = Math.floor(rbGain * Math.pow(2, (p.rbMult&&p.rbMult.rstat)|0));
  p.rcoin = (p.rcoin|0) + rcoinGain;
  p.rstat = (p.rstat|0) + rstatGain;
  p.title = REBIRTH_TITLES[Math.min(REBIRTH_TITLES.length-1, p.rebirth)] || '환생자';
  p.lv = 1; p.xp = 0; p.nx = 30;
  // 환생 시 코인·장비 초기화 (특성/룬/환생코인/강화재료(items)는 유지)
  p.coin = 0;
  // 환생 전용 장비(환생의 검/영겁의 검, 환생의 갑옷/영겁의 갑옷)는 초기화하지 않고 유지
  // 환생 전 보유했던 모든 검을 "검 도감"에 기록 (마검사 자동공격용 · 천상 검 21~24 제외)
  const HV_W = [21, 22, 23, 24];
  p.sw = [...new Set([...(Array.isArray(p.sw) ? p.sw : []), ...(Array.isArray(p.ow) ? p.ow : [])])]
    .filter(v => Number.isInteger(v) && v >= 0 && !HV_W.includes(v)).slice(0, 40);
  const RB_W = [19, 20], RB_A = [15, 16]; // 환생/영겁 장비만 유지 (천상 장비는 환생 시 사라짐)
  const keepOw = (Array.isArray(p.ow) ? p.ow : []).filter(v => RB_W.includes(v));
  const keepOa = (Array.isArray(p.oa) ? p.oa : []).filter(v => RB_A.includes(v));
  if (!RB_W.includes(p.w|0)) { p.w = 0; p.we = 0; }
  if (!RB_A.includes(p.a|0)) { p.a = 0; p.ae = 0; }
  p.ow = [...new Set([0, ...keepOw])]; p.oa = [...new Set([0, ...keepOa])];
  // 초기화된 장비 인덱스가 클라이언트의 이전 상태에 남지 않도록 보유 목록과 동기화
  if (!p.ow.includes(p.w|0)) { p.w = 0; p.we = 0; }
  if (!p.oa.includes(p.a|0)) { p.a = 0; p.ae = 0; }
  p.pot = [2, 0, 0, 0];
  if (p.job==='magesword') p.msUnlocked = true; // 마검사는 환생 후에도 재전직 가능
  p.job = ''; p.jstep = 0; p.jm = 1; p.jhp = 1; // 직업 초기화
  if(p.rebirth >= 500){ p.job='deathgod'; if(prevRb < 500){ p.deathLives=2; p.deathReborn=false; p.deathSkills={guide:false,scythe:false,evadeUntil:0,spears:false,soul:false,harvest:false,execution:false,executionUntil:0,evadeCd:0}; } p.title='죽음의 신'; }
  // 환생해도 누적된 최대 체력/환생 스탯 보너스는 유지
  p.mhp = Math.max(100, Math.floor(Number(p.mhp)||100));
  p.hp = p.mhp;
  p.talentPts = expectedTalentPts(p);
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); } catch(e) {}
  pushAdminStat(req.userKey, { lv:p.lv, xp:p.xp, nx:p.nx, hp:p.hp, mhp:p.mhp, coin:p.coin });
  const deathAwakened = awakenDeathGod(req.userKey, p);   // 500회 달성 시 컷씬 + 전직 (최초 1회)
  res.json({
    ok:true, rebirth:p.rebirth, rbGain, job:p.job, deathAwakened, cutscene:deathAwakened, deathSkills:p.deathSkills, deathLives:p.deathLives, death:deathInfo(req.userKey), rcoin:p.rcoin, rstat:p.rstat, rbMult:p.rbMult, title:p.title,
    rcoinGain, rstatGain,
    lv:p.lv, xp:p.xp, nx:p.nx, talentPts:p.talentPts,
    coin:p.coin, w:p.w, a:p.a, ow:p.ow, oa:p.oa, sw:p.sw, we:p.we, ae:p.ae, pot:p.pot, mhp:p.mhp, hp:p.hp
  });
});

// ===== 환생 스탯 업그레이드 =====
// 배율 = 2^level, 비용 = base * 2^level (업글할 때마다 2배)
const RSTAT_DEFS = {
  atk:     { name:'공격력 2배', base:1 },
  hp:      { name:'체력 2배', base:1 },
  exp:     { name:'경험치 2배', base:1 },
  rcoin:   { name:'환생 코인 2배', base:4 },
  rebirth: { name:'환생 횟수 효과 2배', base:4 },
  rstat:   { name:'환생 스탯 2배', base:6 }
};
function rstatCost(id, level){
  const d = RSTAT_DEFS[id]; if(!d) return null;
  return d.base * Math.pow(2, level|0);
}
app.get('/api/rebirth/stat/info', requireUser, (req, res) => {
  const p = ensurePlayer(req.userKey);
  const info = {};
  for(const [id,d] of Object.entries(RSTAT_DEFS)){
    const lv = (p.rbMult&&p.rbMult[id])|0;
    info[id] = { name:d.name, level:lv, mult:Math.pow(2,lv), cost:rstatCost(id,lv), nextMult:Math.pow(2,lv+1) };
  }
  res.json({ ok:true, rstat:p.rstat|0, rbMult:p.rbMult||{}, info });
});
app.post('/api/rebirth/stat', requireUser, (req, res) => {
  const id = String((req.body&&req.body.id)||'');
  if(!RSTAT_DEFS[id]) return res.status(400).json({ error:'존재하지 않는 환생 스탯입니다.' });
  const p = ensurePlayer(req.userKey);
  if(!p.rbMult) p.rbMult={atk:0,hp:0,exp:0,rcoin:0,rebirth:0,rstat:0};
  const lv = p.rbMult[id]|0;
  if(lv >= 20) return res.status(400).json({ error:'최대 레벨입니다.' });
  const cost = rstatCost(id, lv);
  if((p.rstat|0) < cost) return res.status(400).json({ error:'환생 스탯이 부족합니다.', need:cost, have:p.rstat|0 });
  p.rstat = (p.rstat|0) - cost;
  p.rbMult[id] = lv + 1;
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); } catch(e) {}
  res.json({
    ok:true, id, level:p.rbMult[id], mult:Math.pow(2,p.rbMult[id]),
    rstat:p.rstat, rbMult:p.rbMult,
    nextCost: rstatCost(id, p.rbMult[id])
  });
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

// ===== 플레이어 거래 =====
const trades = new Map(); // key: pair id sorted "idA|idB" -> {a,b,offerA,offerB,readyA,readyB,t}
function tradeKey(a,b){ return a<b ? a+'|'+b : b+'|'+a; }
function cleanOffer(o){
  if(!o||typeof o!=='object') return {coin:0, items:{}, w:[], a:[], runes:[]};
  const coin = Math.max(0, Math.min(1e12, Math.floor(Number(o.coin)||0)));
  const items = {};
  if(o.items&&typeof o.items==='object'){
    for(const [k,v] of Object.entries(o.items)){
      if(typeof k!=='string'||k.length>24) continue;
      const n=Math.floor(Number(v)||0);
      if(n>0&&n<=9999) items[k]=n;
    }
  }
  const w = Array.isArray(o.w)?o.w.filter(x=>Number.isInteger(x)&&x>0&&x<80).slice(0,10):[];
  const a = Array.isArray(o.a)?o.a.filter(x=>Number.isInteger(x)&&x>0&&x<80).slice(0,10):[];
  const runes = Array.isArray(o.runes)?o.runes.filter(x=>typeof x==='string'&&/^R[a-f0-9]{8}$/.test(x)).slice(0,10):[];
  return {coin, items, w, a, runes};
}
function hasOffer(p, offer){
  if((p.coin|0) < (offer.coin|0)) return '코인이 부족합니다.';
  for(const [k,n] of Object.entries(offer.items||{})){
    if(((p.items||{})[k]|0) < n) return '재료가 부족합니다: '+k;
  }
  const ow = Array.isArray(p.ow)?p.ow:[];
  for(const wi of offer.w||[]){
    if(wi=== (p.w|0)) return '장착 중인 무기는 거래할 수 없습니다.';
    if(!ow.includes(wi)) return '보유하지 않은 무기입니다.';
  }
  const oa = Array.isArray(p.oa)?p.oa:[];
  for(const ai of offer.a||[]){
    if(ai=== (p.a|0)) return '장착 중인 방어구는 거래할 수 없습니다.';
    if(!oa.includes(ai)) return '보유하지 않은 방어구입니다.';
  }
  const runes = Array.isArray(p.runes)?p.runes:[];
  for(const rid of offer.runes||[]){
    if(!runes.some(r=>r&&r.id===rid)) return '보유하지 않은 룬입니다.';
    // 장착 중인 룬 제외
    const eq = p.runeEq||{};
    if(eq.w===rid||eq.a===rid||eq.u===rid) return '장착 중인 룬은 거래할 수 없습니다.';
  }
  return null;
}
function applyOffer(fromP, toP, offer){
  // remove from fromP, add to toP
  fromP.coin = (fromP.coin|0) - (offer.coin|0);
  toP.coin = (toP.coin|0) + (offer.coin|0);
  if(!fromP.items) fromP.items={};
  if(!toP.items) toP.items={};
  for(const [k,n] of Object.entries(offer.items||{})){
    fromP.items[k] = (fromP.items[k]|0) - n;
    if(fromP.items[k]<=0) delete fromP.items[k];
    toP.items[k] = (toP.items[k]|0) + n;
  }
  if(!Array.isArray(fromP.ow)) fromP.ow=[0];
  if(!Array.isArray(toP.ow)) toP.ow=[0];
  for(const wi of offer.w||[]){
    fromP.ow = fromP.ow.filter(x=>x!==wi);
    if(!toP.ow.includes(wi)) toP.ow.push(wi);
  }
  if(!Array.isArray(fromP.oa)) fromP.oa=[0];
  if(!Array.isArray(toP.oa)) toP.oa=[0];
  for(const ai of offer.a||[]){
    fromP.oa = fromP.oa.filter(x=>x!==ai);
    if(!toP.oa.includes(ai)) toP.oa.push(ai);
  }
  if(!Array.isArray(fromP.runes)) fromP.runes=[];
  if(!Array.isArray(toP.runes)) toP.runes=[];
  for(const rid of offer.runes||[]){
    const idx = fromP.runes.findIndex(r=>r&&r.id===rid);
    if(idx>=0){
      const [rn] = fromP.runes.splice(idx,1);
      if(toP.runes.length<40) toP.runes.push(rn);
    }
  }
}
function tradeSnapshot(p){
  return {
    coin: p.coin|0,
    items: Object.assign({}, p.items||{}),
    ow: (p.ow||[]).slice(),
    oa: (p.oa||[]).slice(),
    runes: (p.runes||[]).map(r=>({id:r.id,name:r.name,opt:r.opt,val:r.val,slot:r.slot,tier:r.tier})),
    w: p.w|0, a: p.a|0
  };
}

function tryDropRune(ws, m, d) {
  if (!d.boss || !ws || !ws._userKey) return;
  // 모든 보스 룬 드롭 확률 5%
  if (Math.random() > 0.05) return;
  const p = ensurePlayer(ws._userKey);
  if ((p.runes||[]).length >= 40) return;
  const rune = rollRune();
  p.runes.push(rune);
  db.states[ws._userKey].savedAt = Date.now();
  persistSoon();
  try { ws.send(JSON.stringify({ type: 'rune_drop', rune })); } catch {}
}

// 업적과 칭호: 해금 조건과 보상은 서버가 판정한다.
const ACHIEVEMENTS=[
 {id:'slime_100',name:'슬라임 학살자',desc:'슬라임 100마리 처치',title:'슬라임 학살자',coin:500,xp:250,ok:(p,st)=>((st.slimeKills|0)>=100)},
 {id:'kills_1000',name:'천인 참살',desc:'몬스터 1,000마리 처치',title:'천인 참살자',coin:2500,xp:1200,ok:(p,st)=>((st.kills|0)>=1000)},
 {id:'level_100',name:'한계 돌파',desc:'레벨 100 달성',title:'한계 돌파자',coin:5000,xp:0,ok:p=>((p.lv|0)>=100)},
 {id:'boss_25',name:'보스 사냥꾼',desc:'보스 25마리 처치',title:'보스 사냥꾼',coin:3000,xp:1500,ok:(p,st)=>((st.boss|0)>=25)},
 {id:'tower_10',name:'탑의 개척자',desc:'무한의 탑 10층 클리어',title:'탑의 개척자',coin:2000,xp:1000,ok:p=>((p.towerBest|0)>=10)},
 {id:'tower_50',name:'천공의 도전자',desc:'무한의 탑 50층 클리어',title:'천공의 도전자',coin:10000,xp:5000,ok:p=>((p.towerBest|0)>=50)},
 {id:'legend_gear',name:'전설의 수집가',desc:'고등급 무기 보유',title:'전설의 수집가',coin:1500,xp:500,ok:p=>Math.max(...(Array.isArray(p.ow)?p.ow:[0]).map(Number),Number(p.w)||0)>=20}
];
app.get('/api/achievements',requireUser,(req,res)=>{
 const p=ensurePlayer(req.userKey),u=db.users[req.userKey]||{},st=u.stats||{};
 if(!Array.isArray(p.achievementIds))p.achievementIds=[]; if(!Array.isArray(p.unlockedTitles))p.unlockedTitles=[];
 let changed=false;
 for(const a of ACHIEVEMENTS){if(!p.achievementIds.includes(a.id)&&a.ok(p,st)){p.achievementIds.push(a.id);if(!p.unlockedTitles.includes(a.title))p.unlockedTitles.push(a.title);p.coin=(p.coin|0)+a.coin;p.xp=(p.xp|0)+a.xp;changed=true;}}
 if(changed){db.states[req.userKey].savedAt=Date.now();try{persist();}catch{}}
 res.json({achievements:ACHIEVEMENTS.map(a=>({...a,ok:undefined,unlocked:p.achievementIds.includes(a.id)})),unlockedTitles:p.unlockedTitles,equippedTitle:p.equippedTitle||'',coin:p.coin|0,xp:p.xp|0});
});
app.post('/api/title/equip',requireUser,(req,res)=>{
 const p=ensurePlayer(req.userKey),title=String(req.body&&req.body.title||'').slice(0,32);
 if(title&&!((p.unlockedTitles||[]).includes(title))&&title!==(p.title||''))return res.status(400).json({error:'아직 해금하지 않은 칭호입니다.'});
 p.equippedTitle=title;db.states[req.userKey].savedAt=Date.now();try{persist();}catch{}
 for(const live of players.values())if(live.key===req.userKey)live.title=title;
 res.json({ok:true,equippedTitle:title,unlockedTitles:p.unlockedTitles||[]});
});

// 무한의 탑
const towerSessions = new Map(); // userKey -> { floor, started, killsNeed, kills, boss }
function towerScale(floor) {
  const f = Math.max(1, floor|0);
  // 1층: 약함 / 10층: 설원(서리 늑대)급 / 이후 계속 상승
  return {
    hp: Math.floor(60 * Math.pow(1.55, f-1)),
    dmg: Math.floor(6 * Math.pow(1.38, f-1)),
    n: Math.min(20, 3 + Math.floor(f/5)),
    boss: f % 5 === 0,
    xp: Math.floor(25 * Math.pow(1.22, f-1)),
    coin: Math.floor(18 * Math.pow(1.18, f-1))
  };
}
app.post('/api/tower/enter', requireUser, (req, res) => {
  const p = ensurePlayer(req.userKey);
  const floor = Math.max(1, Math.min((p.towerBest|0)+1, Math.floor(Number(req.body&&req.body.floor)||1)));
  if (floor > (p.towerBest|0)+1) return res.status(400).json({ error: '아직 도전할 수 없는 층입니다.', max: (p.towerBest|0)+1 });
  const sc = towerScale(floor);
  const started=Date.now(); const timeLimitMs=Math.max(60000,180000-Math.min(90000,(floor-1)*1000));
  const sess = { floor, started, deadline:started+timeLimitMs, timeLimitMs, killsNeed: sc.boss ? 1 : sc.n, kills: 0, boss: !!sc.boss, sc };
  towerSessions.set(req.userKey, sess);
  res.json({ ok:true, floor, ...sc, killsNeed: sess.killsNeed, timeLimitMs:sess.timeLimitMs, deadline:sess.deadline });
});
app.post('/api/tower/kill', requireUser, (req, res) => {
  const sess = towerSessions.get(req.userKey);
  if (!sess) return res.status(400).json({ error: '탑에 입장하지 않았습니다.' });
  if (Date.now() > sess.deadline) { towerSessions.delete(req.userKey); return res.status(400).json({ error: '제한 시간 초과! 이번 층 도전이 종료되었습니다.' }); }
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
  if(Date.now()>sess.deadline){towerSessions.delete(req.userKey);return res.status(400).json({error:'제한 시간 초과! 보상을 받을 수 없습니다.'});}
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
app.get('/api/tower/ranking', requireUser, (req,res)=>{
  const rows=[];
  for(const [key,u] of Object.entries(db.users||{})){
    if(u.isAdmin||u.banned||(db.bans&&db.bans[key]))continue;
    const p=(db.states[key]&&db.states[key].player)||{};
    rows.push({name:u.username||'모험가',floor:p.towerBest|0,rebirth:p.rebirth|0,lv:p.lv|0,mine:key===req.userKey?1:0});
  }
  rows.sort((a,b)=>b.floor-a.floor||b.rebirth-a.rebirth||b.lv-a.lv);
  res.json({rows:rows.slice(0,50),mine:rows.findIndex(x=>x.mine===1)+1});
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
    towerBest: p.towerBest|0, rebirth: p.rebirth|0, rcoin: p.rcoin|0, rstat: p.rstat|0, rbMult: p.rbMult||{}, title: p.title||'', equippedTitle:p.equippedTitle||'', unlockedTitles:p.unlockedTitles||[], achievementIds:p.achievementIds||[],
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
  { id:'rhp', name:'영구 체력 +5%', cost:50, type:'perm', key:'rHp' },
  { id:'rsword1', name:'환생의 검', cost:120, type:'w', index:19 },
  { id:'rsword2', name:'영겁의 검', cost:280, type:'w', index:20 },
  { id:'rarmor1', name:'환생의 갑옷', cost:100, type:'a', index:15 },
  { id:'rarmor2', name:'영겁의 갑옷', cost:220, type:'a', index:16 }
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
  else if (item.type==='w') {
    const idx = item.index|0;
    if (!Array.isArray(p.ow)) p.ow = [0];
    if (!p.ow.includes(idx)) p.ow.push(idx);
    p.w = idx;
  } else if (item.type==='a') {
    const idx = item.index|0;
    if (!Array.isArray(p.oa)) p.oa = [0];
    if (!p.oa.includes(idx)) p.oa.push(idx);
    p.a = idx;
  }
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); } catch(e) {}
  res.json({ ok:true, rcoin:p.rcoin, items:p.items, pot:p.pot, w:p.w, a:p.a, ow:p.ow, oa:p.oa });
});


// ===== 은행원: 코인/재료 보관 =====
const BANK_ITEM_CAP=999999, BANK_SLOTS=60;
function bankView(p){return {coin:p.coin|0,items:p.items||{},bank:{coin:p.bank.coin|0,items:p.bank.items}};}
// ★ 코인/재료는 클라이언트(화면) 기준으로 쌓이므로, 은행 이용 직전에 화면에 보이는 값으로 서버 값을 맞춘다.
//   (저장이 아직 서버에 도착하지 않아 150만이 148만으로 줄어드는 현상 방지)
function bankSyncFromClient(p,b){
  if(!b||typeof b!=='object') return;
  const c=Number(b.sc);
  if(Number.isFinite(c)) p.coin=Math.max(0,Math.min(1e9,Math.floor(c)));
  const it=b.si;
  if(it&&typeof it==='object'&&!Array.isArray(it)){
    const out={};let n=0;
    for(const [k,v] of Object.entries(it)){
      if(n>=120) break;
      if(!/^[A-Za-z0-9_]{1,24}$/.test(k)) continue;
      const q=Math.max(0,Math.min(BANK_ITEM_CAP,Math.floor(Number(v)||0)));
      if(q>0){out[k]=q;n++;}
    }
    p.items=out;
  }
}
app.get('/api/bank/info',requireUser,(req,res)=>{
  const p=ensurePlayer(req.userKey);
  res.json(bankView(p));
});
app.post('/api/bank/info',requireUser,(req,res)=>{
  const p=ensurePlayer(req.userKey);
  bankSyncFromClient(p,req.body);
  persistSoon();
  res.json(bankView(p));
});
app.post('/api/bank/tx',requireUser,(req,res)=>{
  const p=ensurePlayer(req.userKey);
  const b=req.body||{};
  bankSyncFromClient(p,b);
  if(inSafe(Number(p.x)||0,Number(p.z)||0)===false) return res.status(400).json({error:'은행은 시작 마을에서만 이용할 수 있어요.'});
  const act=b.act, kind=b.kind;
  let amt=Math.floor(Number(b.amount));
  if(!Number.isFinite(amt)||amt<=0) return res.status(400).json({error:'수량이 올바르지 않습니다.'});
  if(act!=='deposit'&&act!=='withdraw') return res.status(400).json({error:'요청이 올바르지 않습니다.'});
  if(kind==='coin'){
    if(act==='deposit'){
      if(amt>p.coin) return res.status(400).json({error:'보유 코인이 부족합니다.'});
      if(p.bank.coin+amt>1e9) return res.status(400).json({error:'은행 한도를 초과합니다.'});
      p.coin-=amt;p.bank.coin+=amt;
    }else{
      if(amt>p.bank.coin) return res.status(400).json({error:'예금이 부족합니다.'});
      if(p.coin+amt>1e9) return res.status(400).json({error:'보유 코인 한도를 초과합니다.'});
      p.bank.coin-=amt;p.coin+=amt;
    }
  }else if(kind==='item'){
    const id=String(b.id||'');
    if(!/^[A-Za-z0-9_]{1,24}$/.test(id)) return res.status(400).json({error:'아이템이 올바르지 않습니다.'});
    const from=act==='deposit'?p.items:p.bank.items, to=act==='deposit'?p.bank.items:p.items;
    if((from[id]|0)<amt) return res.status(400).json({error:'수량이 부족합니다.'});
    if(!(id in to)&&Object.keys(to).length>=(act==='deposit'?BANK_SLOTS:120)) return res.status(400).json({error:'보관함이 가득 찼습니다.'});
    if((to[id]|0)+amt>BANK_ITEM_CAP) return res.status(400).json({error:'한도를 초과합니다.'});
    from[id]-=amt; if(from[id]<=0) delete from[id];
    to[id]=(to[id]|0)+amt;
  }else return res.status(400).json({error:'요청이 올바르지 않습니다.'});
  persistSoon();
  res.json(bankView(p));
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
  const savedPlayer=ws._userKey&&db.states[ws._userKey]&&db.states[ws._userKey].player;
  const p={id, name:displayName, x:0, z:8, y:0, face:0, pvp:false, hp:100, mhp:100, lv:1, job:'', gn:'', soul:false, sp:false, title:savedPlayer&&savedPlayer.equippedTitle||''};
  { const gg=ws._userKey?guildOfKey(ws._userKey):null; p.gn=gg?gg.name:''; }
  Object.defineProperty(p,'invTill',{value:0,writable:true,enumerable:false});   // 서버 전용(브로드캐스트 제외)
  Object.defineProperty(p,'party',{value:null,writable:true,enumerable:false});
  Object.defineProperty(p,'key',{value:ws._userKey||null,writable:true,enumerable:false});
  Object.defineProperty(p,'baseDmg',{value:0,writable:true,enumerable:false});     // 클라가 보고한 기본 공격력(bd)
  Object.defineProperty(p,'lastHit',{value:0,writable:true,enumerable:false});
  Object.defineProperty(p,'wasAlive',{value:false,writable:true,enumerable:false});
  Object.defineProperty(p,'reviveUntil',{value:0,writable:true,enumerable:false});
  // 같은 계정의 기존 접속은 종료 (내 캐릭터가 복제되어 보이는 현상 방지)
  if(ws._userKey){
    for(const o of wss.clients){
      if(o!==ws&&o._userKey===ws._userKey){
        try{o.send(JSON.stringify({type:'dup'}));}catch{}
        try{o.close(4001,'duplicate login');}catch{}
        if(o.player){players.delete(o.player.id);wsById.delete(o.player.id);broadcast({type:'leave',id:o.player.id});}
      }
    }
  }
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
  { const dst=(p.key&&db.states[p.key]&&db.states[p.key].player)?ensurePlayer(p.key):null;
    if(dst&&(dst.rebirth|0)>=DEATH_REBIRTH){ p.job='deathgod'; p.soul=!!(dst.deathSkills&&dst.deathSkills.soul); p.sp=!!(dst.deathSkills&&dst.deathSkills.spears);
      try{ws.send(JSON.stringify(deathStateMsg(dst,Date.now())));}catch{}
      awakenDeathGod(p.key,dst); } }
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
      if(!Number.isFinite(m.x)||!Number.isFinite(m.z)||!Number.isFinite(m.y)||!Number.isFinite(m.face)||Math.abs(m.x)>1100||m.z>400||m.z<-2400||m.y<0||m.y>40){
        ws.strikes=(ws.strikes||0)+1; if(ws.strikes>=5)ws.close(1008,'state'); return;
      }
      Object.assign(p,{x:m.x,z:m.z,y:m.y,face:m.face});
      if(typeof m.pvp==='boolean') p.pvp=m.pvp;
      if(Number.isFinite(m.hp)) p.hp=Math.max(0,Math.min(1e6,m.hp));
      if(Number.isFinite(m.mhp)) p.mhp=Math.max(1,Math.min(1e6,m.mhp));
      if(Number.isFinite(m.lv)) p.lv=Math.max(1,Math.min(1e6,Math.floor(m.lv)));
      if(typeof m.job==='string'&&/^[a-z_]{0,24}$/.test(m.job)) p.job=m.job;
      if(typeof m.hadesSword==='boolean') p.hadesSword=m.hadesSword;
      if(typeof m.godUnlocked==='boolean') p.godUnlocked=m.godUnlocked;
      if(Number.isFinite(m.bd)&&m.bd>0) p.baseDmg=Math.min(1e9,m.bd);   // 죽음의 창 데미지 기준(내 1회 공격 데미지)
      const dsx=deathSt(p);
      if(dsx) p.job='deathgod';
      if(m.inv && !(dsx&&dsx.deathSkills&&dsx.deathSkills.soul)) p.invTill=Math.max(p.invTill||0,now+150);   // 영혼 모드는 대쉬 불가
      if(p.hp>0) p.wasAlive=true;
      else if(p.wasAlive){ p.wasAlive=false; if(dsx) deathLifeCheck(p,ws,dsx,now); }   // 목숨 패시브   // 대쉬/스킬 무적 중에는 몬스터 공격 무효
      // 원격 애니메이션용 필드 전달
      p.atk = m.atk ? 1 : 0;
      if(Number.isFinite(m.shirt)) p.shirt = Math.floor(m.shirt) & 0xffffff;
      if(Number.isFinite(m.skin)) p.skin = Math.floor(m.skin) & 0xffffff;
      if(m.look && typeof m.look==='object') p.look = m.look;
      broadcast({type:'state',player:p},ws);
      // atk 플래그는 1회성
      p.atk = 0;
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
      if(inSafeAny(p.x,p.z)||inSafeAny(targetPlayer.x,targetPlayer.z)) return;
      const dmg=Math.max(1,Math.floor(Math.max(1,Math.min(500,Math.floor(m.dmg)))*dmgTakenMult(targetPlayer,now)));
      targetPlayer.hp=Math.max(0,(targetPlayer.hp||100)-dmg);
      broadcastAll({type:'pvp_damage', from:p.id, to:targetPlayer.id, dmg, hp:targetPlayer.hp, name:p.name});
      return;
    }

        // ---------- 플레이어 목록 / 파티 / 채팅 (서버 권한) ----------
    if(m.type==='death_skill'){
      const st=deathSt(p); if(!st) return msgTo(p.id,'죽음의 신만 사용할 수 있어요.');
      if(now-(ws._dsT||0)<150) return; ws._dsT=now;
      const sk=DEATH_SKILL_IDS[String(m.skill)]; if(!sk) return;
      if(!st.deathSkills||typeof st.deathSkills!=='object') st.deathSkills={guide:false,scythe:false,evadeUntil:0,spears:false,soul:false,harvest:false,execution:false,executionUntil:0,evadeCd:0};
      const ds=st.deathSkills; if(typeof ds.harvest!=='boolean')ds.harvest=false; if(typeof ds.execution!=='boolean')ds.execution=false;
      if(sk==='evade'){
        
        if((Number(ds.evadeCd)||0)>now){ msgTo(p.id,'죽음의 회피 쿨타임 '+Math.ceil(((Number(ds.evadeCd)||0)-now)/1000)+'초'); pushDeathState(p.key); return; }
        ds.evadeUntil=now+DEATH_EVADE_MS; ds.evadeCd=now+DEATH_EVADE_CD;
      } else if(sk==='execution'){
        ds.execution=(typeof m.on==='boolean')?m.on:!ds.execution; ds.executionUntil=ds.execution?now+20000:0;
      } else {
        ds[sk]=(typeof m.on==='boolean')?m.on:!ds[sk];
        if(sk==='spears') p.sp=!!ds.spears;
        if(sk==='soul') p.soul=!!ds.soul;
      }
      if(db.states[p.key]) db.states[p.key].savedAt=Date.now();
      persistSoon();
      pushDeathState(p.key);
      broadcast({type:'state',player:p},ws);
      return;
    }
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
    
    if(m.type==='trade_req'){
      if(typeof m.to!=='string') return;
      if(now-(ws._trT||0)<1500) return; ws._trT=now;
      const tp=players.get(m.to);
      if(!tp||tp.id===p.id) return msgTo(p.id,'거래할 수 없는 대상이에요.');
      if(Math.hypot((p.x||0)-(tp.x||0),(p.z||0)-(tp.z||0))>18) return msgTo(p.id,'상대가 너무 멀어요. (18m 이내)');
      const k=tradeKey(p.id,tp.id);
      if(trades.has(k)) return msgTo(p.id,'이미 진행 중인 거래가 있어요.');
      // cancel any other pending invites for this player
      trades.set(k,{a:p.id,b:tp.id,offerA:cleanOffer(null),offerB:cleanOffer(null),readyA:0,readyB:0,t:now,stage:'open'});
      sendTo(tp.id,{type:'trade_invited',from:{id:p.id,name:p.name,lv:p.lv||1},ttl:45});
      msgTo(p.id,tp.name+' 님에게 거래를 요청했어요.');
      return;
    }
    if(m.type==='trade_reply'){
      const fromId=typeof m.from==='string'?m.from:'';
      const k=tradeKey(p.id,fromId);
      const tr=trades.get(k);
      if(!tr||(tr.a!==fromId&&tr.b!==fromId)) return;
      if(!m.ok){
        trades.delete(k);
        sendTo(fromId,{type:'trade_end',reason:'거절됨'});
        msgTo(fromId,p.name+' 님이 거래를 거절했어요.');
        return;
      }
      tr.stage='active'; tr.t=now;
      // send open panels to both
      const pa=players.get(tr.a), pb=players.get(tr.b);
      if(!pa||!pb){ trades.delete(k); return; }
      sendTo(tr.a,{type:'trade_open',with:{id:pb.id,name:pb.name,lv:pb.lv||1},you:'A'});
      sendTo(tr.b,{type:'trade_open',with:{id:pa.id,name:pa.name,lv:pa.lv||1},you:'B'});
      return;
    }
    if(m.type==='trade_offer'){
      // update my side offer
      let tr=null, side=null;
      for(const [k,v] of trades){ if(v.a===p.id){tr=v;side='A';break} if(v.b===p.id){tr=v;side='B';break} }
      if(!tr||tr.stage!=='active') return;
      if(now-tr.t>180000){ trades.delete(tradeKey(tr.a,tr.b)); sendTo(tr.a,{type:'trade_end',reason:'시간 초과'}); sendTo(tr.b,{type:'trade_end',reason:'시간 초과'}); return; }
      const offer=cleanOffer(m.offer);
      const pl=ensurePlayer(ws._userKey);
      const err=hasOffer(pl,offer);
      if(err){ try{ws.send(JSON.stringify({type:'trade_err',error:err}));}catch{} return; }
      if(side==='A'){ tr.offerA=offer; tr.readyA=0; tr.readyB=0; }
      else { tr.offerB=offer; tr.readyA=0; tr.readyB=0; }
      sendTo(tr.a,{type:'trade_update',offerA:tr.offerA,offerB:tr.offerB,readyA:tr.readyA,readyB:tr.readyB});
      sendTo(tr.b,{type:'trade_update',offerA:tr.offerA,offerB:tr.offerB,readyA:tr.readyA,readyB:tr.readyB});
      return;
    }
    if(m.type==='trade_ready'){
      let tr=null, side=null;
      for(const [k,v] of trades){ if(v.a===p.id){tr=v;side='A';break} if(v.b===p.id){tr=v;side='B';break} }
      if(!tr||tr.stage!=='active') return;
      if(side==='A') tr.readyA = m.ok?1:0; else tr.readyB = m.ok?1:0;
      sendTo(tr.a,{type:'trade_update',offerA:tr.offerA,offerB:tr.offerB,readyA:tr.readyA,readyB:tr.readyB});
      sendTo(tr.b,{type:'trade_update',offerA:tr.offerA,offerB:tr.offerB,readyA:tr.readyA,readyB:tr.readyB});
      if(tr.readyA&&tr.readyB){
        // execute trade
        const keyA = (wsById.get(tr.a)||{})._userKey;
        const keyB = (wsById.get(tr.b)||{})._userKey;
        // find user keys from players
        const pa=players.get(tr.a), pb=players.get(tr.b);
        const ua=pa&&pa._userKey, ub=pb&&pb._userKey;
        // store userKey on player at login - check
        const wsa=wsById.get(tr.a), wsb=wsById.get(tr.b);
        const userA=wsa&&wsa._userKey, userB=wsb&&wsb._userKey;
        if(!userA||!userB){ trades.delete(tradeKey(tr.a,tr.b)); sendTo(tr.a,{type:'trade_end',reason:'오류'}); sendTo(tr.b,{type:'trade_end',reason:'오류'}); return; }
        const A=ensurePlayer(userA), B=ensurePlayer(userB);
        const e1=hasOffer(A,tr.offerA), e2=hasOffer(B,tr.offerB);
        if(e1||e2){
          sendTo(tr.a,{type:'trade_err',error:e1||e2});
          sendTo(tr.b,{type:'trade_err',error:e1||e2});
          tr.readyA=0; tr.readyB=0;
          return;
        }
        applyOffer(A,B,tr.offerA);
        applyOffer(B,A,tr.offerB);
        db.states[userA].savedAt=Date.now();
        db.states[userB].savedAt=Date.now();
        persistSoon();
        const snapA=tradeSnapshot(A), snapB=tradeSnapshot(B);
        sendTo(tr.a,{type:'trade_done',you:snapA});
        sendTo(tr.b,{type:'trade_done',you:snapB});
        trades.delete(tradeKey(tr.a,tr.b));
        msgTo(tr.a,'거래가 완료되었습니다!');
        msgTo(tr.b,'거래가 완료되었습니다!');
      }
      return;
    }
    if(m.type==='trade_cancel'){
      let tr=null;
      for(const [k,v] of trades){ if(v.a===p.id||v.b===p.id){tr=v;break} }
      if(!tr) return;
      const k=tradeKey(tr.a,tr.b);
      trades.delete(k);
      sendTo(tr.a,{type:'trade_end',reason:'취소됨'});
      sendTo(tr.b,{type:'trade_end',reason:'취소됨'});
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
      } else {
        // 전체 채널: 접속자 모두에게 전달 (말풍선용 id 포함), 전체 채널은 1.5초 간격 제한
        if(now-(ws._chatAllT||0)<1500) return; ws._chatAllT=now;
        broadcastAll({type:'chat',ch:'all',id:p.id,name:p.name,text});
      }
      return;
    }

    // 마검사 아이스볼: {type:'stun', ids:[몬스터id...]} — 3초간 행동불가 (월드보스 제외)
    if(m.type==='stun'){
      if(!Array.isArray(m.ids)||p.hp<=0) return;
      if(now-(ws._stunT||0)<2500) return;
      ws._stunT=now;
      for(const id of m.ids.slice(0,24)){
        const mm=monsters.get(id);
        if(!mm||mm.dead||mm.type==='worldboss'||mm.type==='zeus') continue;
        if(Math.hypot(mm.x-p.x,mm.z-p.z)>75) continue;
        mm.stun=3; mm.cast=null; mm.ver++;
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
    persistSoon();
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
  try{ tickMonsters(dt,now); tickDeath(now); broadcastMonsters(); }catch(e){ console.error('monster tick error:',e); }
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
