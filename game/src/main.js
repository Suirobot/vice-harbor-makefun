// VICE HARBOR — an original open-world crime game in one module.
// A city to explore on foot and by car: traffic, pedestrians, cars to steal,
// a wanted level with police who answer it, a five-mission story, combat,
// a HUD with a minimap, a start screen, sound, and a saved game.
// No assets, no network: everything is drawn and synthesised at run time.

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = canvas.width;
const H = canvas.height;
const params = new URLSearchParams(location.search);
const SHOT = params.get('shot');
const SEED = Number(params.get('seed') ?? '7');

// ---------- deterministic rng ----------
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const srand = mulberry32(SEED * 7919 + 13);
const rand = (a, b) => a + Math.random() * (b - a);
const irand = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const angDiff = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

// ---------- sound (all synthesised) ----------
const AudioSys = {
  ac: null,
  engineOsc: null,
  engineGain: null,
  sirenOsc: null,
  sirenGain: null,
  init() {
    if (this.ac) return;
    try {
      this.ac = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      this.ac = null;
    }
  },
  blip(freq, dur, type = 'square', vol = 0.12, slide = 0) {
    if (!this.ac) return;
    const t = this.ac.currentTime;
    const o = this.ac.createOscillator();
    const g = this.ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.ac.destination);
    o.start(t);
    o.stop(t + dur);
  },
  shot() {
    if (!this.ac) return;
    const t = this.ac.currentTime;
    const len = 0.09;
    const buf = this.ac.createBuffer(1, this.ac.sampleRate * len, this.ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = this.ac.createBufferSource();
    src.buffer = buf;
    const g = this.ac.createGain();
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(g).connect(this.ac.destination);
    src.start(t);
  },
  cash() {
    this.blip(880, 0.08, 'square', 0.1);
    setTimeout(() => this.blip(1320, 0.12, 'square', 0.1), 70);
  },
  hurt() {
    this.blip(140, 0.15, 'sawtooth', 0.14, -60);
  },
  crash(v = 0.15) {
    this.blip(70, 0.2, 'sawtooth', v, -30);
  },
  engine(on, speed) {
    if (!this.ac) return;
    if (on && !this.engineOsc) {
      this.engineOsc = this.ac.createOscillator();
      this.engineGain = this.ac.createGain();
      this.engineOsc.type = 'sawtooth';
      this.engineGain.gain.value = 0.0;
      this.engineOsc.connect(this.engineGain).connect(this.ac.destination);
      this.engineOsc.start();
    }
    if (this.engineOsc) {
      this.engineOsc.frequency.value = 50 + Math.abs(speed) * 26;
      this.engineGain.gain.value = on ? 0.045 : 0.0;
      if (!on) {
        this.engineOsc.stop();
        this.engineOsc = null;
        this.engineGain = null;
      }
    }
  },
  siren(on) {
    if (!this.ac) return;
    if (on && !this.sirenOsc) {
      this.sirenOsc = this.ac.createOscillator();
      this.sirenGain = this.ac.createGain();
      this.sirenOsc.type = 'triangle';
      this.sirenGain.gain.value = 0.018;
      const lfo = this.ac.createOscillator();
      const lg = this.ac.createGain();
      lfo.frequency.value = 0.7;
      lg.gain.value = 180;
      lfo.connect(lg).connect(this.sirenOsc.frequency);
      this.sirenOsc.frequency.value = 780;
      this.sirenOsc.connect(this.sirenGain).connect(this.ac.destination);
      this.sirenOsc.start();
      lfo.start();
      this.sirenLfo = lfo;
    }
    if (!on && this.sirenOsc) {
      this.sirenOsc.stop();
      this.sirenLfo.stop();
      this.sirenOsc = null;
      this.sirenGain = null;
    }
  },
};

// ---------- the city of Port Azura ----------
const BLOCK = 264; // city block size
const ROAD = 104; // road width
const GRID = 11; // blocks per side
const PITCH = BLOCK + ROAD;
const WORLD = GRID * PITCH + ROAD;
const BEACH_Y = WORLD - 300;

const buildings = []; // {x,y,w,h,color,roof,name?}
const trees = [];
const lamps = [];
const roadV = []; // vertical road centre lines x
const roadH = [];
for (let i = 0; i <= GRID; i++) {
  roadV.push(ROAD / 2 + i * PITCH);
  roadH.push(ROAD / 2 + i * PITCH);
}
const PALETTE = ['#c96f4a', '#b8b0a1', '#7f9fb3', '#a35d7c', '#6d8f6a', '#c2a15c', '#8a7fbf', '#5f7f8c', '#d08c60', '#97a8b8'];
const NAMED = [
  { gx: 1, gy: 1, name: 'CASINO AZURA' },
  { gx: 5, gy: 2, name: 'HOTEL MARINA' },
  { gx: 8, gy: 4, name: 'AZURA GENERAL HOSPITAL' },
  { gx: 2, gy: 7, name: 'PORT AZURA DOCKS' },
  { gx: 9, gy: 8, name: 'ROSA’S GARAGE' },
  { gx: 5, gy: 9, name: 'NEON MALL' },
];
function buildCity() {
  for (let gx = 0; gx < GRID; gx++) {
    for (let gy = 0; gy < GRID; gy++) {
      const x0 = ROAD + gx * PITCH;
      const y0 = ROAD + gy * PITCH;
      if (y0 > BEACH_Y - 120) continue; // beach strip stays open
      const named = NAMED.find((n) => n.gx === gx && n.gy === gy);
      if ((gx * 7 + gy * 13) % 9 === 4) {
        // a park block
        for (let t = 0; t < 14; t++) trees.push({ x: x0 + 20 + srand() * (BLOCK - 40), y: y0 + 20 + srand() * (BLOCK - 40), r: 9 + srand() * 7 });
        continue;
      }
      const n = named ? 1 : 2 + Math.floor(srand() * 3);
      for (let b = 0; b < n; b++) {
        const bw = named ? BLOCK - 36 : 60 + srand() * 80;
        const bh = named ? BLOCK - 36 : 60 + srand() * 80;
        const bx = x0 + 14 + srand() * Math.max(1, BLOCK - 28 - bw);
        const by = y0 + 14 + srand() * Math.max(1, BLOCK - 28 - bh);
        buildings.push({ x: bx, y: by, w: bw, h: bh, color: named ? '#e8dcc0' : PALETTE[Math.floor(srand() * PALETTE.length)], name: named?.name });
      }
    }
  }
  for (const rx of roadV) for (let y = 60; y < WORLD - 60; y += 190) lamps.push({ x: rx + ROAD / 2 + 6, y });
  for (const ry of roadH) for (let x = 60; x < WORLD - 60; x += 190) lamps.push({ x, y: ry + ROAD / 2 + 6 });
}
buildCity();

function collideRects(x, y, r) {
  for (const b of buildings) {
    if (x + r > b.x && x - r < b.x + b.w && y + r > b.y && y - r < b.y + b.h) return b;
  }
  return null;
}
function pointInBuilding(x, y) {
  return buildings.some((b) => x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h);
}
const nearestRoadX = (x) => roadV.reduce((p, c) => (Math.abs(c - x) < Math.abs(p - x) ? c : p), roadV[0]);
const nearestRoadY = (y) => roadH.reduce((p, c) => (Math.abs(c - y) < Math.abs(p - y) ? c : p), roadH[0]);

// ---------- game state ----------
const SAVE_KEY = 'viceharbor-save-v1';
const save = (() => {
  try {
    return JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null') ?? { cash: 250, mission: 0, earned: 0, done: false };
  } catch {
    return { cash: 250, mission: 0, earned: 0, done: false };
  }
})();
function persist() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch {
    /* private mode: the game still runs */
  }
}
const G = {
  mode: 'title', // title | play | busted | wasted | ending
  time: 0,
  dayT: 0.32, // 0..1 time of day
  cash: save.cash,
  earned: save.earned,
  missionIdx: save.mission,
  storyDone: save.done,
  wanted: 0,
  wantedTimer: 0,
  seenTimer: 0,
  msg: '',
  msgT: 0,
  objective: '',
  dialogue: null,
  dialogueT: 0,
  shake: 0,
  slowmo: 0,
};

const player = {
  x: roadV[2],
  y: roadH[8] + 30,
  angle: -Math.PI / 2,
  speed: 0,
  r: 11,
  health: 100,
  car: null,
  fireCd: 0,
  ammo: 12,
  reloadT: 0,
  walkPhase: 0,
};

const CAR_COLORS = ['#d94f4f', '#4f7ad9', '#e8c33c', '#57b368', '#e8e8e8', '#333a45', '#b45fd9', '#d97b2f', '#3fbfae', '#c0c6ce'];
const cars = [];
const peds = [];
const bullets = [];
const parts = []; // particles
const skids = [];

function makeCar(x, y, angle, kind) {
  const c = {
    x, y, angle, speed: 0, r: 17,
    w: 20, l: 40,
    kind, // traffic | parked | police | mission | enemy
    color: kind === 'police' ? '#101318' : pick(CAR_COLORS),
    health: 100,
    driver: kind === 'traffic' || kind === 'police' || kind === 'enemy' ? 'ai' : null,
    ai: { tx: x, ty: y, wait: 0, lane: Math.random() < 0.5 ? 1 : -1 },
    sirenPhase: Math.random() * 6,
    dead: false,
  };
  cars.push(c);
  return c;
}
function makePed(x, y) {
  const p = {
    x, y, angle: rand(0, 6.28), speed: 0, r: 8,
    color: pick(['#e8b04f', '#4fd9c0', '#d94f8a', '#7ad94f', '#e8e8e8', '#4f6ad9', '#d97b2f']),
    skin: pick(['#f2c79b', '#c68e5e', '#8a5a34', '#f7d7b0']),
    state: 'walk', t: rand(1, 4), tx: x, ty: y, health: 30, walkPhase: rand(0, 6),
  };
  peds.push(p);
  return p;
}
function spawnAmbient() {
  cars.length = 0;
  peds.length = 0;
  for (let i = 0; i < 26; i++) {
    const vert = Math.random() < 0.5;
    const x = vert ? pick(roadV) + (Math.random() < 0.5 ? 24 : -24) : rand(100, WORLD - 100);
    const y = vert ? rand(100, WORLD - 100) : pick(roadH) + (Math.random() < 0.5 ? 24 : -24);
    if (pointInBuilding(x, y) || y > BEACH_Y) continue;
    makeCar(x, y, vert ? (Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2) : Math.random() < 0.5 ? 0 : Math.PI, 'traffic');
  }
  for (let i = 0; i < 16; i++) {
    // parked cars along block edges
    const gx = irand(0, GRID - 1);
    const gy = irand(0, GRID - 2);
    const x = ROAD + gx * PITCH + rand(10, BLOCK - 10);
    const y = ROAD + gy * PITCH - 16;
    if (pointInBuilding(x, y)) continue;
    makeCar(x, y, Math.PI / 2, 'parked');
  }
  for (let i = 0; i < 46; i++) {
    const x = rand(80, WORLD - 80);
    const y = rand(80, BEACH_Y - 40);
    if (pointInBuilding(x, y)) continue;
    makePed(x, y);
  }
}

// ---------- crime & wanted ----------
function crime(amount, x, y) {
  const witnessed = peds.some((p) => Math.hypot(p.x - x, p.y - y) < 260 && p.state !== 'fallen') || cars.some((c) => c.kind === 'police' && Math.hypot(c.x - x, c.y - y) < 620);
  if (!witnessed && amount < 1) return;
  G.wanted = clamp(G.wanted + amount, 0, 5);
  G.seenTimer = 6;
}
function setMsg(text, t = 3.4) {
  G.msg = text;
  G.msgT = t;
}
function say(who, text, t = 4.2) {
  G.dialogue = { who, text };
  G.dialogueT = t;
}
function pay(amount) {
  G.cash += amount;
  G.earned += amount;
  save.cash = G.cash;
  save.earned = G.earned;
  persist();
  AudioSys.cash();
  setMsg(`+$${amount.toLocaleString()}`);
}

// ---------- missions: the story of Dante Vale ----------
const M = [
  {
    title: 'FIRST WHEELS',
    intro: [
      ['ROSA', 'Dante. You owe me, so you drive for me. A customer left a gold sports car by the Casino Azura.'],
      ['ROSA', 'Take it. Bring it to my garage across town. Try not to scratch the paint — or do. I get paid either way.'],
    ],
    setup(g) {
      const spot = { x: roadV[1] + 30, y: roadH[1] + 60 };
      g.target = makeCar(spot.x, spot.y, 0, 'mission');
      g.target.color = '#e8c33c';
      g.stage = 0;
      g.marker = spot;
      g.objective = 'Steal the gold sports car near Casino Azura';
    },
    update(g, dt) {
      if (g.stage === 0 && player.car === g.target) {
        g.stage = 1;
        g.marker = { x: roadV[9] + 20, y: roadH[8] };
        g.objective = 'Deliver the car to Rosa’s Garage';
        say('ROSA', 'That’s my car now. Bring her home, Dante.');
        crime(1, player.x, player.y);
      } else if (g.stage === 1 && player.car === g.target && dist(player, g.marker) < 70) {
        g.finish(900);
      }
    },
  },
  {
    title: 'HOT PACKAGE',
    intro: [
      ['ROSA', 'A package is waiting at the Port Azura docks. The harbour police watch that pier like hawks.'],
      ['ROSA', 'Grab it, lose any heat, and take it to the buyer at the Neon Mall. Quick hands, quiet engine.'],
    ],
    setup(g) {
      g.stage = 0;
      g.marker = { x: roadV[2] - 20, y: roadH[7] + 40 };
      g.objective = 'Pick up the package at the docks';
    },
    update(g, dt) {
      if (g.stage === 0 && !player.car && dist(player, g.marker) < 34) {
        g.stage = 1;
        G.wanted = Math.max(G.wanted, 2);
        G.seenTimer = 6;
        g.marker = { x: roadV[5], y: roadH[9] - 30 };
        g.objective = 'Deliver the package to the buyer at Neon Mall';
        say('DANTE', 'Got it. And — of course — the whole harbour saw me.');
      } else if (g.stage === 1 && dist(player, g.marker) < 60) {
        g.finish(1400);
      }
    },
  },
  {
    title: 'THE INFORMANT',
    intro: [
      ['ROSA', 'A snitch named Pelican is leaving town in a grey sedan. He knows names — my name.'],
      ['ROSA', 'Stop his car, walk up to him, and convince him to forget everything. I don’t care how loud it gets.'],
    ],
    setup(g) {
      const spot = { x: roadV[7], y: roadH[3] };
      g.target = makeCar(spot.x, spot.y, Math.PI, 'mission');
      g.target.color = '#8d97a3';
      g.target.driver = 'ai';
      g.target.ai.flee = true;
      g.stage = 0;
      g.marker = spot;
      g.objective = 'Stop the informant’s grey sedan';
    },
    update(g, dt) {
      g.marker = { x: g.target.x, y: g.target.y };
      if (g.stage === 0 && g.target.health <= 25) {
        g.stage = 1;
        g.target.driver = null;
        g.target.speed = 0;
        g.objective = 'Walk up to the informant';
        say('PELICAN', 'Okay! Okay! I’ll forget! I already forgot!');
      } else if (g.stage === 1 && !player.car && dist(player, g.target) < 46) {
        g.finish(1800);
      }
    },
  },
  {
    title: 'CONVOY TROUBLE',
    intro: [
      ['ROSA', 'The Vultures jumped my convoy driver near Hotel Marina and left him walking. The cargo’s still in his van.'],
      ['ROSA', 'Three of their cars are circling it. Clear them out — driver or car, I leave the method to you.'],
    ],
    setup(g) {
      g.stage = 0;
      g.vanPos = { x: roadV[5] + 26, y: roadH[2] + 10 };
      g.marker = g.vanPos;
      g.enemies = [];
      for (let k = 0; k < 3; k++) {
        const e = makeCar(g.vanPos.x + rand(-160, 160), g.vanPos.y + rand(-160, 160), rand(0, 6.28), 'enemy');
        e.color = '#5a1f1f';
        g.enemies.push(e);
      }
      g.objective = 'Clear the Vultures around the van (0/3)';
    },
    update(g, dt) {
      const left = g.enemies.filter((e) => !e.dead).length;
      g.objective = `Clear the Vultures around the van (${3 - left}/3)`;
      if (left === 0) g.finish(2400);
    },
  },
  {
    title: 'NEON GETAWAY',
    intro: [
      ['ROSA', 'Last job, Dante. I’m at the Casino with a bag that half the city wants. Pick me up.'],
      ['ROSA', 'Then get us to the marina before every badge in Port Azura finds us. Drive like the rent’s due.'],
    ],
    setup(g) {
      g.stage = 0;
      g.marker = { x: roadV[1] + 30, y: roadH[1] + 60 };
      g.objective = 'Pick Rosa up at Casino Azura';
      g.timer = 150;
    },
    update(g, dt) {
      if (g.stage === 0 && dist(player, g.marker) < 70) {
        g.stage = 1;
        G.wanted = 4;
        G.seenTimer = 8;
        g.marker = { x: roadV[6], y: BEACH_Y - 60 };
        g.objective = 'Reach the marina — GO!';
        say('ROSA', 'Drive, Dante! DRIVE!');
      } else if (g.stage === 1) {
        g.timer -= dt;
        g.objective = `Reach the marina — ${Math.max(0, Math.ceil(g.timer))}s`;
        if (g.timer <= 0) {
          g.fail('The boat left without you.');
          return;
        }
        if (dist(player, g.marker) < 80) {
          pay(4000);
          save.done = true;
          persist();
          G.mode = 'ending';
          AudioSys.engine(false, 0);
          AudioSys.siren(false);
        }
      }
    },
  },
];

let mission = null;
function startMission(idx) {
  const def = M[idx];
  if (!def) return;
  mission = {
    def,
    stage: 0,
    target: null,
    marker: null,
    objective: '',
    enemies: [],
    introQueue: [...def.intro],
    finish(amount) {
      pay(amount);
      say('ROSA', `Clean work. $${amount.toLocaleString()} — spend it somewhere loud.`);
      save.mission = idx + 1;
      persist();
      mission = null;
      G.objective = idx + 1 < M.length ? 'Free roam — the next job is coming…' : 'Story complete — Port Azura is yours';
      setTimeout(() => {
        if (G.mode === 'play' && !mission && save.mission < M.length) startMission(save.mission);
      }, 9000);
    },
    fail(why) {
      setMsg(`MISSION FAILED — ${why} Press R to retry`);
      mission.failed = true;
    },
  };
  mission.objective = def.title;
  def.setup(mission);
  G.objective = mission.objective;
  const first = mission.introQueue.shift();
  if (first) say(first[0], first[1], 5);
}

// ---------- input ----------
const keys = {};
const mouse = { x: W / 2, y: H / 2, down: false };
addEventListener('keydown', (e) => {
  keys[e.key.toLowerCase()] = true;
  AudioSys.init();
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(e.key.toLowerCase())) e.preventDefault();
  if (G.mode === 'title' && (e.key === 'Enter' || e.key === ' ')) startGame(save.mission > 0);
  else if ((G.mode === 'busted' || G.mode === 'wasted') && e.key.toLowerCase() === 'r') respawn();
  else if (G.mode === 'play' && e.key.toLowerCase() === 'r' && mission?.failed) {
    mission = null;
    startMission(save.mission);
  } else if (G.mode === 'ending' && e.key === 'Enter') {
    G.mode = 'play';
  }
});
addEventListener('keyup', (e) => (keys[e.key.toLowerCase()] = false));
canvas.addEventListener('mousemove', (e) => {
  const r = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - r.left) / r.width) * W;
  mouse.y = ((e.clientY - r.top) / r.height) * H;
});
canvas.addEventListener('mousedown', () => {
  mouse.down = true;
  AudioSys.init();
  if (G.mode === 'title') startGame(save.mission > 0);
});
addEventListener('mouseup', () => (mouse.down = false));

function startGame(fresh) {
  if (fresh) {
    save.cash = 250;
    save.mission = 0;
    save.earned = 0;
    save.done = false;
    persist();
    G.cash = 250;
    G.earned = 0;
    G.storyDone = false;
  }
  G.mode = 'play';
  G.wanted = 0;
  player.health = 100;
  player.car = null;
  player.x = roadV[2];
  player.y = roadH[8] + 30;
  spawnAmbient();
  mission = null;
  if (save.mission < M.length) startMission(save.mission);
  else G.objective = 'Free roam — Port Azura is yours';
}
function respawn() {
  G.mode = 'play';
  G.wanted = 0;
  player.health = 100;
  player.car = null;
  player.x = roadV[8];
  player.y = roadH[4] + 40; // hospital
  G.cash = Math.max(0, G.cash - 150);
  save.cash = G.cash;
  persist();
  if (mission?.failed || (mission && save.mission < M.length && mission.def !== M[save.mission])) {
    mission = null;
    startMission(save.mission);
  }
  setMsg('Back on the street. The city forgot nothing.');
}

// ---------- physics helpers ----------
function moveCircle(e, vx, vy, r) {
  let nx = e.x + vx;
  let ny = e.y + vy;
  const hitX = collideRects(nx, e.y, r);
  if (hitX) nx = e.x;
  const hitY = collideRects(e.x, ny, r);
  if (hitY) ny = e.y;
  e.x = clamp(nx, r, WORLD - r);
  e.y = clamp(ny, r, BEACH_Y + 130);
  return hitX || hitY;
}
function burst(x, y, color, n, spd = 130) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, 6.28);
    const s = rand(spd * 0.3, spd);
    parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.25, 0.6), t: 0, color, r: rand(1.5, 3.5) });
  }
}

// ---------- updates ----------
function updatePlayer(dt) {
  player.fireCd -= dt;
  if (player.reloadT > 0) {
    player.reloadT -= dt;
    if (player.reloadT <= 0) player.ammo = 12;
  }
  if (keys['r'] && !player.car && player.ammo < 12 && player.reloadT <= 0) player.reloadT = 0.9;

  if (player.car) {
    const c = player.car;
    const accel = keys['w'] || keys['arrowup'] ? 300 : 0;
    const brake = keys['s'] || keys['arrowdown'] ? (c.speed > 8 ? -420 : -140) : 0;
    c.speed += (accel + brake) * dt;
    c.speed -= c.speed * 0.55 * dt;
    c.speed = clamp(c.speed, -95, 305);
    const steer = (keys['a'] || keys['arrowleft'] ? -1 : 0) + (keys['d'] || keys['arrowright'] ? 1 : 0);
    if (Math.abs(c.speed) > 4) c.angle += steer * 1.9 * dt * Math.sign(c.speed) * clamp(Math.abs(c.speed) / 120, 0.3, 1);
    if (keys[' '] && Math.abs(c.speed) > 60) skids.push({ x: c.x, y: c.y, a: c.angle, t: 0 });
    const vx = Math.cos(c.angle) * c.speed * dt;
    const vy = Math.sin(c.angle) * c.speed * dt;
    const before = { x: c.x, y: c.y };
    if (moveCircle(c, vx, vy, 19)) {
      if (Math.abs(c.speed) > 120) {
        c.health -= 9;
        crime(0.4, c.x, c.y);
        AudioSys.crash();
        G.shake = 5;
        burst(c.x, c.y, '#ffb84f', 8);
      }
      c.speed *= -0.25;
    }
    // hit other cars / peds
    for (const o of cars) {
      if (o === c || o.dead) continue;
      if (Math.hypot(o.x - c.x, o.y - c.y) < 34) {
        o.health -= Math.abs(c.speed) * 0.12;
        o.speed += c.speed * 0.3;
        o.x += (o.x - c.x) * 0.12;
        o.y += (o.y - c.y) * 0.12;
        if (Math.abs(c.speed) > 90) {
          crime(0.5, c.x, c.y);
          AudioSys.crash(0.2);
          burst(o.x, o.y, '#ffd27a', 6);
        }
        c.speed *= 0.72;
      }
    }
    for (const p of peds) {
      if (p.state === 'fallen') continue;
      if (Math.hypot(p.x - c.x, p.y - c.y) < 24 && Math.abs(c.speed) > 26) {
        p.state = 'fallen';
        p.t = 7;
        crime(1, c.x, c.y);
        AudioSys.hurt();
        burst(p.x, p.y, '#d94f4f', 8, 90);
        G.shake = 4;
      }
    }
    player.x = c.x;
    player.y = c.y;
    player.angle = c.angle;
    AudioSys.engine(true, c.speed);
    if (keys['e'] || keys['f']) {
      keys['e'] = keys['f'] = false;
      player.car = null;
      c.driver = null;
      player.x = c.x + Math.cos(c.angle + Math.PI / 2) * 26;
      player.y = c.y + Math.sin(c.angle + Math.PI / 2) * 26;
      AudioSys.engine(false, 0);
    }
    return;
  }

  // on foot
  AudioSys.engine(false, 0);
  const run = keys['shift'] ? 218 : 128;
  let mx = 0;
  let my = 0;
  if (keys['w'] || keys['arrowup']) my -= 1;
  if (keys['s'] || keys['arrowdown']) my += 1;
  if (keys['a'] || keys['arrowleft']) mx -= 1;
  if (keys['d'] || keys['arrowright']) mx += 1;
  const len = Math.hypot(mx, my);
  if (len > 0) {
    mx /= len;
    my /= len;
    player.walkPhase += dt * (keys['shift'] ? 13 : 9);
    moveCircle(player, mx * run * dt, my * run * dt, player.r);
  }
  // aim at the mouse (camera centred on the player)
  player.angle = Math.atan2(mouse.y - H / 2, mouse.x - W / 2);
  // enter a car
  if (keys['e'] || keys['f']) {
    keys['e'] = keys['f'] = false;
    let best = null;
    let bd = 52;
    for (const c of cars) {
      if (c.dead) continue;
      const d = Math.hypot(c.x - player.x, c.y - player.y);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    if (best) {
      const wasParked = best.kind === 'parked' || best.driver === null;
      if (best.driver === 'ai') {
        // pull the driver out
        makePed(best.x + 14, best.y + 10).state = 'flee';
        crime(1, best.x, best.y);
      } else if (!wasParked) crime(0.5, best.x, best.y);
      else if (best.kind === 'mission') crime(1, best.x, best.y);
      best.driver = 'player';
      if (best.kind === 'parked') best.kind = 'traffic';
      player.car = best;
      player.x = best.x;
      player.y = best.y;
    }
  }
  // shoot
  if (mouse.down && player.fireCd <= 0 && player.reloadT <= 0) {
    if (player.ammo <= 0) {
      player.reloadT = 0.9;
    } else {
      player.ammo -= 1;
      player.fireCd = 0.16;
      AudioSys.shot();
      crime(0.7, player.x, player.y);
      bullets.push({
        x: player.x + Math.cos(player.angle) * 16,
        y: player.y + Math.sin(player.angle) * 16,
        vx: Math.cos(player.angle) * 780,
        vy: Math.sin(player.angle) * 780,
        life: 0.55,
        from: 'player',
      });
      burst(player.x + Math.cos(player.angle) * 18, player.y + Math.sin(player.angle) * 18, '#ffd27a', 3, 60);
      for (const p of peds) if (Math.hypot(p.x - player.x, p.y - player.y) < 300) p.state = 'flee';
    }
  }
  // slow health regen up to 60
  if (player.health < 60) player.health = Math.min(60, player.health + dt * 2.2);
}

function updateCars(dt) {
  for (const c of cars) {
    if (c.dead) continue;
    if (c.health <= 0) {
      c.dead = true;
      c.driver = null;
      burst(c.x, c.y, '#555c66', 16, 90);
      burst(c.x, c.y, '#ff8c42', 10, 70);
      if (c.kind === 'enemy' && mission) crime(0.3, c.x, c.y);
      continue;
    }
    if (c.driver === 'player') continue;
    if (c.kind === 'police') {
      updatePoliceCar(c, dt);
      continue;
    }
    if (c.driver !== 'ai') {
      c.speed = 0;
      continue;
    }
    // traffic & fleeing mission cars & enemies
    const ai = c.ai;
    if (ai.flee) {
      // run from the player, along the nearest road direction
      const away = Math.atan2(c.y - player.y, c.x - player.x);
      ai.tx = c.x + Math.cos(away) * 300;
      ai.ty = c.y + Math.sin(away) * 300;
    } else if (c.kind === 'enemy') {
      ai.tx = player.x;
      ai.ty = player.y;
      if (Math.hypot(player.x - c.x, player.y - c.y) < 60) {
        // enemy driver leans out and shoots
        c.shootCd = (c.shootCd ?? 0) - dt;
        if (c.shootCd <= 0 && !player.car) {
          c.shootCd = rand(0.7, 1.3);
          AudioSys.shot();
          const a = Math.atan2(player.y - c.y, player.x - c.x) + rand(-0.12, 0.12);
          bullets.push({ x: c.x, y: c.y, vx: Math.cos(a) * 700, vy: Math.sin(a) * 700, life: 0.5, from: 'enemy' });
        }
      }
    } else if (Math.hypot(ai.tx - c.x, ai.ty - c.y) < 46 || ai.wait > 0) {
      // pick the next intersection target
      ai.wait -= dt;
      const cx = nearestRoadX(c.x);
      const cy = nearestRoadY(c.y);
      const opts = [
        { x: cx + PITCH, y: cy },
        { x: cx - PITCH, y: cy },
        { x: cx, y: cy + PITCH },
        { x: cx, y: cy - PITCH },
      ].filter((o) => o.x > 40 && o.x < WORLD - 40 && o.y > 40 && o.y < BEACH_Y + 60);
      const t = pick(opts.length ? opts : [{ x: cx, y: cy }]);
      ai.tx = t.x + (Math.abs(t.x - c.x) > 4 ? 0 : 24 * ai.lane);
      ai.ty = t.y + (Math.abs(t.y - c.y) > 4 ? 0 : 24 * ai.lane);
      if (Math.random() < 0.14) ai.wait = rand(0.4, 1.4);
    }
    const want = Math.atan2(ai.ty - c.y, ai.tx - c.x);
    const da = angDiff(c.angle, want);
    c.angle += clamp(da, -2.2 * dt, 2.2 * dt);
    let target = ai.flee ? 235 : c.kind === 'enemy' ? 200 : 118;
    // slow for the car ahead
    for (const o of cars) {
      if (o === c || o.dead) continue;
      const fx = c.x + Math.cos(c.angle) * 44;
      const fy = c.y + Math.sin(c.angle) * 44;
      if (Math.hypot(o.x - fx, o.y - fy) < 30) target = 0;
    }
    if (player.car !== c && !player.car && Math.hypot(player.x - (c.x + Math.cos(c.angle) * 44), player.y - (c.y + Math.sin(c.angle) * 44)) < 26) target = 0;
    c.speed += clamp(target - c.speed, -260 * dt, 120 * dt);
    const vx = Math.cos(c.angle) * c.speed * dt;
    const vy = Math.sin(c.angle) * c.speed * dt;
    if (moveCircle(c, vx, vy, 19)) c.speed *= 0.4;
    // traffic avoids peds, mostly
    for (const p of peds) {
      if (p.state === 'fallen') continue;
      if (Math.hypot(p.x - c.x, p.y - c.y) < 23 && Math.abs(c.speed) > 30) {
        p.state = 'fallen';
        p.t = 7;
        burst(p.x, p.y, '#d94f4f', 6, 80);
      }
    }
  }
  // despawn far traffic, keep the streets alive near the player
  for (let i = cars.length - 1; i >= 0; i--) {
    const c = cars[i];
    if (c.kind === 'traffic' && c.driver === 'ai' && Math.hypot(c.x - player.x, c.y - player.y) > 1500) cars.splice(i, 1);
  }
  const near = cars.filter((c) => c.kind === 'traffic' && Math.hypot(c.x - player.x, c.y - player.y) < 1200).length;
  if (near < 12 && Math.random() < dt * 2) {
    const a = rand(0, 6.28);
    const x = clamp(player.x + Math.cos(a) * 800, 60, WORLD - 60);
    const y = clamp(player.y + Math.sin(a) * 800, 60, BEACH_Y);
    if (!pointInBuilding(x, y)) {
      const c = makeCar(nearestRoadX(x), nearestRoadY(y), rand(0, 6.28), 'traffic');
      c.ai.tx = c.x + 300;
      c.ai.ty = c.y;
    }
  }
}

function updatePolice(dt) {
  const want = Math.floor(G.wanted);
  const cops = cars.filter((c) => c.kind === 'police' && !c.dead);
  G.seenTimer -= dt;
  const anyNear = cops.some((c) => Math.hypot(c.x - player.x, c.y - player.y) < 560);
  if (anyNear) G.seenTimer = 6;
  if (G.wanted > 0 && G.seenTimer <= 0) {
    G.wantedTimer += dt;
    if (G.wantedTimer > 7) {
      G.wanted = Math.max(0, G.wanted - 1);
      G.wantedTimer = 0;
      if (G.wanted === 0) setMsg('You lost the heat.');
    }
  } else G.wantedTimer = 0;
  if (want > 0 && cops.length < want + 1 && Math.random() < dt * 0.7) {
    const a = rand(0, 6.28);
    const x = clamp(player.x + Math.cos(a) * 720, 60, WORLD - 60);
    const y = clamp(player.y + Math.sin(a) * 720, 60, BEACH_Y);
    makeCar(nearestRoadX(x), nearestRoadY(y), a + Math.PI, 'police');
  }
  for (let i = cars.length - 1; i >= 0; i--) {
    const c = cars[i];
    if (c.kind === 'police' && (c.dead || Math.hypot(c.x - player.x, c.y - player.y) > 1700 || (want === 0 && Math.hypot(c.x - player.x, c.y - player.y) > 500))) {
      if (!c.dead) cars.splice(i, 1);
    }
  }
  AudioSys.siren(cops.length > 0 && G.mode === 'play');
  // busted: a cop car stays on top of a slow or on-foot player
  if (want >= 1 && !player.car) {
    const close = cops.some((c) => Math.hypot(c.x - player.x, c.y - player.y) < 60);
    if (close) {
      G.bustT = (G.bustT ?? 0) + dt;
      if (G.bustT > 1.6) {
        G.mode = 'busted';
        G.bustT = 0;
        AudioSys.siren(false);
        AudioSys.engine(false, 0);
      }
    } else G.bustT = Math.max(0, (G.bustT ?? 0) - dt * 2);
  }
}
function updatePoliceCar(c, dt) {
  const d = Math.hypot(player.x - c.x, player.y - c.y);
  const want = Math.atan2(player.y - c.y, player.x - c.x);
  const da = angDiff(c.angle, want);
  c.angle += clamp(da, -2.6 * dt, 2.6 * dt);
  const target = d > 46 ? 262 : 40;
  c.speed += clamp(target - c.speed, -300 * dt, 170 * dt);
  const vx = Math.cos(c.angle) * c.speed * dt;
  const vy = Math.sin(c.angle) * c.speed * dt;
  if (moveCircle(c, vx, vy, 19)) c.speed *= 0.3;
  if (player.car && Math.hypot(player.car.x - c.x, player.car.y - c.y) < 36) {
    player.car.health -= 14 * dt;
    if (Math.random() < dt * 2) AudioSys.crash(0.08);
  }
  c.sirenPhase += dt * 9;
}

function updatePeds(dt) {
  for (const p of peds) {
    if (p.state === 'fallen') {
      p.t -= dt;
      if (p.t <= 0) {
        p.state = 'walk';
        p.health = 30;
      }
      continue;
    }
    if (p.state === 'flee') {
      const away = Math.atan2(p.y - player.y, p.x - player.x);
      moveCircle(p, Math.cos(away) * 165 * dt, Math.sin(away) * 165 * dt, p.r);
      p.walkPhase += dt * 14;
      p.t -= dt;
      if (p.t <= 0 || Math.hypot(p.x - player.x, p.y - player.y) > 420) p.state = 'walk';
      continue;
    }
    p.t -= dt;
    if (p.t <= 0) {
      p.t = rand(2, 6);
      p.tx = clamp(p.x + rand(-260, 260), 40, WORLD - 40);
      p.ty = clamp(p.y + rand(-260, 260), 40, BEACH_Y - 20);
      if (pointInBuilding(p.tx, p.ty)) {
        p.tx = nearestRoadX(p.tx);
        p.ty = p.y;
      }
    }
    const d = Math.hypot(p.tx - p.x, p.ty - p.y);
    if (d > 8) {
      const a = Math.atan2(p.ty - p.y, p.tx - p.x);
      p.angle = a;
      p.walkPhase += dt * 8;
      moveCircle(p, Math.cos(a) * 52 * dt, Math.sin(a) * 52 * dt, p.r);
    }
  }
  for (let i = peds.length - 1; i >= 0; i--) if (Math.hypot(peds[i].x - player.x, peds[i].y - player.y) > 1600) peds.splice(i, 1);
  if (peds.length < 34 && Math.random() < dt * 3) {
    const a = rand(0, 6.28);
    const x = clamp(player.x + Math.cos(a) * 700, 50, WORLD - 50);
    const y = clamp(player.y + Math.sin(a) * 700, 50, BEACH_Y - 30);
    if (!pointInBuilding(x, y)) makePed(x, y);
  }
}

function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    let kill = b.life <= 0 || pointInBuilding(b.x, b.y);
    if (!kill && b.from === 'player') {
      for (const c of cars) {
        if (c.dead) continue;
        if (Math.hypot(c.x - b.x, c.y - b.y) < 22) {
          c.health -= 16;
          burst(b.x, b.y, '#ffd27a', 4, 80);
          if (c.kind === 'police') crime(0.8, c.x, c.y);
          if (c.kind === 'enemy' && c.health <= 0) c.dead = true;
          kill = true;
          break;
        }
      }
      if (!kill) {
        for (const p of peds) {
          if (p.state !== 'fallen' && Math.hypot(p.x - b.x, p.y - b.y) < 11) {
            p.state = 'fallen';
            p.t = 8;
            crime(1, p.x, p.y);
            burst(p.x, p.y, '#d94f4f', 7, 90);
            kill = true;
            break;
          }
        }
      }
    }
    if (!kill && b.from === 'enemy') {
      if (!player.car && Math.hypot(player.x - b.x, player.y - b.y) < 12) {
        player.health -= 9;
        AudioSys.hurt();
        G.shake = 3;
        burst(player.x, player.y, '#d94f4f', 5, 80);
        kill = true;
        if (player.health <= 0) G.mode = 'wasted';
      } else if (player.car && Math.hypot(player.car.x - b.x, player.car.y - b.y) < 24) {
        player.car.health -= 5;
        kill = true;
      }
    }
    if (kill) bullets.splice(i, 1);
  }
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.t += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.9;
    p.vy *= 0.9;
    if (p.t > p.life) parts.splice(i, 1);
  }
  for (let i = skids.length - 1; i >= 0; i--) {
    skids[i].t += dt;
    if (skids[i].t > 6) skids.splice(i, 1);
  }
}

// ---------- rendering ----------
const cam = { x: 0, y: 0 };
function drawWorld() {
  const x0 = cam.x - 40;
  const y0 = cam.y - 40;
  const x1 = cam.x + W + 40;
  const y1 = cam.y + H + 40;
  // ground: grass, then the beach and the sea
  ctx.fillStyle = '#3f7040';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#e6cf9a';
  ctx.fillRect(0, BEACH_Y - cam.y, W, 190);
  const seaGrad = ctx.createLinearGradient(0, BEACH_Y + 150 - cam.y, 0, WORLD - cam.y);
  seaGrad.addColorStop(0, '#2e7fb8');
  seaGrad.addColorStop(1, '#144a75');
  ctx.fillStyle = seaGrad;
  ctx.fillRect(0, BEACH_Y + 150 - cam.y, W, WORLD - BEACH_Y);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 2;
  for (let k = 0; k < 3; k++) {
    const wy = BEACH_Y + 165 + k * 42 - cam.y + Math.sin(G.time * 1.4 + k) * 3;
    ctx.beginPath();
    ctx.moveTo(0, wy);
    ctx.lineTo(W, wy);
    ctx.stroke();
  }
  // roads
  ctx.fillStyle = '#33373d';
  for (const rx of roadV) ctx.fillRect(rx - ROAD / 2 - cam.x, 0, ROAD, H);
  for (const ry of roadH) ctx.fillRect(0, ry - ROAD / 2 - cam.y, W, ROAD);
  // sidewalks
  ctx.fillStyle = '#9aa0a3';
  for (const rx of roadV) {
    ctx.fillRect(rx - ROAD / 2 - 7 - cam.x, 0, 7, H);
    ctx.fillRect(rx + ROAD / 2 - cam.x, 0, 7, H);
  }
  for (const ry of roadH) {
    ctx.fillRect(0, ry - ROAD / 2 - 7 - cam.y, W, 7);
    ctx.fillRect(0, ry + ROAD / 2 - cam.y, W, 7);
  }
  // lane dashes
  ctx.fillStyle = '#e8d44f';
  for (const rx of roadV) for (let y = 26; y < WORLD; y += 52) {
    if (y > y0 - 60 && y < y1 + 60) ctx.fillRect(rx - 2 - cam.x, y - cam.y, 4, 26);
  }
  ctx.fillStyle = '#e8e8e8';
  for (const ry of roadH) for (let x = 26; x < WORLD; x += 52) {
    if (x > x0 - 60 && x < x1 + 60) ctx.fillRect(x - cam.x, ry - 2 - cam.y, 26, 4);
  }
  // skid marks
  for (const s of skids) {
    ctx.fillStyle = `rgba(15,15,15,${0.35 * (1 - s.t / 6)})`;
    ctx.fillRect(s.x - 3 - cam.x, s.y - 3 - cam.y, 6, 6);
  }
  // parks' trees
  for (const t of trees) {
    if (t.x < x0 || t.x > x1 || t.y < y0 || t.y > y1) continue;
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.ellipse(t.x + 5 - cam.x, t.y + 7 - cam.y, t.r, t.r * 0.7, 0, 0, 6.29);
    ctx.fill();
    ctx.fillStyle = '#2c5c2e';
    ctx.beginPath();
    ctx.arc(t.x - cam.x, t.y - cam.y, t.r, 0, 6.29);
    ctx.fill();
    ctx.fillStyle = '#3f7d42';
    ctx.beginPath();
    ctx.arc(t.x - 3 - cam.x, t.y - 3 - cam.y, t.r * 0.6, 0, 6.29);
    ctx.fill();
  }
  // buildings with a fake height shadow
  for (const b of buildings) {
    if (b.x + b.w < x0 || b.x > x1 || b.y + b.h < y0 || b.y > y1) continue;
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(b.x + 10 - cam.x, b.y + 12 - cam.y, b.w, b.h);
    ctx.fillStyle = b.color;
    ctx.fillRect(b.x - cam.x, b.y - cam.y, b.w, b.h);
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    ctx.fillRect(b.x - cam.x, b.y - cam.y, b.w, 7);
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    const cols = Math.max(2, Math.floor(b.w / 26));
    const rows = Math.max(2, Math.floor(b.h / 26));
    for (let cx = 0; cx < cols; cx++) for (let cy = 0; cy < rows; cy++) {
      if ((cx * 31 + cy * 17) % 3 === 0) continue;
      ctx.fillRect(b.x + 8 + cx * 24 - cam.x, b.y + 10 + cy * 24 - cam.y, 11, 13);
    }
    if (b.name) {
      ctx.fillStyle = '#20242c';
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(b.name, b.x + b.w / 2 - cam.x, b.y + b.h / 2 - cam.y);
    }
  }
  // mission marker
  if (mission?.marker) {
    const m = mission.marker;
    const bob = Math.sin(G.time * 4) * 6;
    ctx.fillStyle = 'rgba(255, 209, 63, 0.25)';
    ctx.beginPath();
    ctx.arc(m.x - cam.x, m.y - cam.y, 34 + bob, 0, 6.29);
    ctx.fill();
    ctx.fillStyle = '#ffd13f';
    ctx.beginPath();
    ctx.moveTo(m.x - cam.x, m.y - 6 + bob - cam.y);
    ctx.lineTo(m.x - 11 - cam.x, m.y - 26 + bob - cam.y);
    ctx.lineTo(m.x + 11 - cam.x, m.y - 26 + bob - cam.y);
    ctx.closePath();
    ctx.fill();
  }
}

function drawCar(c) {
  const x = c.x - cam.x;
  const y = c.y - cam.y;
  if (x < -70 || x > W + 70 || y < -70 || y > H + 70) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(c.angle);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(-c.l / 2 + 3, -c.w / 2 + 4, c.l, c.w);
  ctx.fillStyle = c.dead ? '#2b2b2b' : c.color;
  ctx.beginPath();
  ctx.roundRect(-c.l / 2, -c.w / 2, c.l, c.w, 6);
  ctx.fill();
  ctx.fillStyle = 'rgba(20,26,34,0.9)';
  ctx.beginPath();
  ctx.roundRect(-6, -c.w / 2 + 3, 15, c.w - 6, 4);
  ctx.fill();
  ctx.fillStyle = 'rgba(180,220,255,0.5)';
  ctx.fillRect(2, -c.w / 2 + 4, 5, c.w - 8);
  ctx.fillStyle = '#151515';
  for (const [wx, wy] of [[-c.l / 2 + 7, -c.w / 2 - 2], [c.l / 2 - 7, -c.w / 2 - 2], [-c.l / 2 + 7, c.w / 2 - 3], [c.l / 2 - 7, c.w / 2 - 3]]) {
    ctx.fillRect(wx - 4, wy, 9, 4);
  }
  ctx.fillStyle = '#ffe9a8';
  ctx.fillRect(c.l / 2 - 2, -c.w / 2 + 2, 3, 5);
  ctx.fillRect(c.l / 2 - 2, c.w / 2 - 7, 3, 5);
  ctx.fillStyle = '#ff5f4f';
  ctx.fillRect(-c.l / 2 - 1, -c.w / 2 + 2, 3, 5);
  ctx.fillRect(-c.l / 2 - 1, c.w / 2 - 7, 3, 5);
  if (c.kind === 'police') {
    ctx.fillStyle = '#f2f4f6';
    ctx.fillRect(-c.l / 2 + 6, -c.w / 2, c.l - 12, c.w);
    ctx.fillStyle = '#101318';
    ctx.font = 'bold 8px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('POLICE', 0, 3);
    const phase = Math.sin(c.sirenPhase) > 0;
    ctx.fillStyle = phase ? '#ff4040' : '#4066ff';
    ctx.beginPath();
    ctx.arc(-2, 0, 4.4, 0, 6.29);
    ctx.fill();
    ctx.fillStyle = phase ? 'rgba(255,64,64,0.25)' : 'rgba(64,102,255,0.25)';
    ctx.beginPath();
    ctx.arc(-2, 0, 15, 0, 6.29);
    ctx.fill();
  }
  if (c.dead) {
    ctx.fillStyle = 'rgba(30,30,30,0.5)';
    ctx.beginPath();
    ctx.arc(0, 0, 13 + Math.sin(G.time * 3) * 2, 0, 6.29);
    ctx.fill();
  }
  ctx.restore();
  if (c.health < 55 && !c.dead) {
    ctx.fillStyle = 'rgba(200,200,200,0.5)';
    ctx.beginPath();
    ctx.arc(x + rand(-6, 6), y - 14, 4 + Math.random() * 3, 0, 6.29);
    ctx.fill();
  }
}

function drawPed(p, isPlayer = false) {
  const x = p.x - cam.x;
  const y = p.y - cam.y;
  if (x < -30 || x > W + 30 || y < -30 || y > H + 30) return;
  ctx.save();
  ctx.translate(x, y);
  if (p.state === 'fallen') {
    ctx.rotate(1.4);
    ctx.fillStyle = p.color;
    ctx.fillRect(-10, -4, 20, 8);
    ctx.fillStyle = p.skin;
    ctx.beginPath();
    ctx.arc(12, 0, 5, 0, 6.29);
    ctx.fill();
    ctx.restore();
    return;
  }
  const step = Math.sin(p.walkPhase) * 4;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(0, 6, 8, 3.4, 0, 0, 6.29);
  ctx.fill();
  ctx.strokeStyle = '#2c3242';
  ctx.lineWidth = 3.4;
  ctx.beginPath();
  ctx.moveTo(0, 2);
  ctx.lineTo(-3 + step * 0.4, 10);
  ctx.moveTo(0, 2);
  ctx.lineTo(3 - step * 0.4, 10);
  ctx.stroke();
  ctx.rotate(p.angle + Math.PI / 2);
  ctx.fillStyle = isPlayer ? '#ffd13f' : p.color;
  ctx.beginPath();
  ctx.roundRect(-5.4, -6, 10.8, 11, 4);
  ctx.fill();
  ctx.fillStyle = isPlayer ? '#f2c79b' : p.skin;
  ctx.beginPath();
  ctx.arc(0, -8.6, 4.6, 0, 6.29);
  ctx.fill();
  if (isPlayer) {
    // the gun, pointing the way he faces
    ctx.strokeStyle = '#15181d';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(3, -4);
    ctx.lineTo(3, -13);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHUD() {
  // health
  ctx.fillStyle = 'rgba(8,10,14,0.55)';
  ctx.beginPath();
  ctx.roundRect(16, 16, 264, 64, 8);
  ctx.fill();
  ctx.fillStyle = '#e8ecf2';
  ctx.font = 'bold 21px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`$${G.cash.toLocaleString()}`, 28, 44);
  ctx.fillStyle = '#3a4150';
  ctx.fillRect(28, 54, 180, 10);
  ctx.fillStyle = player.health > 30 ? '#57d977' : '#ff5f4f';
  ctx.fillRect(28, 54, 180 * clamp(player.health, 0, 100) / 100, 10);
  if (player.car) {
    ctx.fillStyle = '#3a4150';
    ctx.fillRect(28, 68, 180, 6);
    ctx.fillStyle = '#ffb84f';
    ctx.fillRect(28, 68, 180 * clamp(player.car.health, 0, 100) / 100, 6);
  }
  // ammo
  if (!player.car) {
    ctx.fillStyle = 'rgba(8,10,14,0.55)';
    ctx.beginPath();
    ctx.roundRect(16, H - 52, 128, 36, 8);
    ctx.fill();
    ctx.fillStyle = '#e8ecf2';
    ctx.font = 'bold 17px system-ui';
    ctx.fillText(player.reloadT > 0 ? 'RELOADING…' : `🔫 ${player.ammo} / ∞`, 28, H - 28);
  }
  // wanted stars
  const stars = Math.floor(G.wanted);
  ctx.save();
  ctx.translate(W - 216, 14);
  for (let s = 0; s < 5; s++) {
    ctx.fillStyle = s < stars ? '#ffd13f' : 'rgba(255,255,255,0.22)';
    ctx.font = '27px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText('★', s * 30, 26);
  }
  ctx.restore();
  if ((G.bustT ?? 0) > 0.15) {
    ctx.fillStyle = '#ff5f4f';
    ctx.font = 'bold 19px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('THE POLICE ARE ON YOU — RUN!', W / 2, 108);
  }
  // objective
  if (G.objective) {
    ctx.font = '600 16.5px system-ui, sans-serif';
    const tw = ctx.measureText(G.objective).width + 34;
    ctx.fillStyle = 'rgba(8,10,14,0.55)';
    ctx.beginPath();
    ctx.roundRect(W / 2 - tw / 2, 14, tw, 32, 8);
    ctx.fill();
    ctx.fillStyle = '#ffd13f';
    ctx.textAlign = 'center';
    ctx.fillText(`◆ ${G.objective}`, W / 2, 36);
  }
  // minimap
  const mw = 196;
  const mx = W - mw - 16;
  const my = 58;
  ctx.fillStyle = 'rgba(10,14,18,0.78)';
  ctx.beginPath();
  ctx.roundRect(mx, my, mw, mw, 8);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(mx, my, mw, mw, 8);
  ctx.clip();
  const sc = mw / WORLD;
  ctx.fillStyle = '#2c5230';
  ctx.fillRect(mx, my + BEACH_Y * sc, mw, (WORLD - BEACH_Y) * sc);
  ctx.fillStyle = '#4a4f55';
  for (const rx of roadV) ctx.fillRect(mx + rx * sc - 1, my, 2.4, mw);
  for (const ry of roadH) ctx.fillRect(mx, my + ry * sc - 1, mw, 2.4);
  ctx.fillStyle = '#7fb2d9';
  ctx.fillRect(mx, my + (BEACH_Y + 150) * sc, mw, mw);
  for (const c of cars) {
    if (c.dead) continue;
    ctx.fillStyle = c.kind === 'police' ? (Math.sin(c.sirenPhase) > 0 ? '#ff4040' : '#4066ff') : c === player.car ? '#ffffff' : 'rgba(230,230,230,0.55)';
    ctx.fillRect(mx + c.x * sc - 1.6, my + c.y * sc - 1.6, 3.2, 3.2);
  }
  if (mission?.marker) {
    ctx.fillStyle = '#ffd13f';
    ctx.beginPath();
    ctx.arc(mx + mission.marker.x * sc, my + mission.marker.y * sc, 4.4, 0, 6.29);
    ctx.fill();
  }
  ctx.fillStyle = '#ffd13f';
  ctx.save();
  ctx.translate(mx + player.x * sc, my + player.y * sc);
  ctx.rotate(player.angle);
  ctx.beginPath();
  ctx.moveTo(6, 0);
  ctx.lineTo(-4.4, -3.6);
  ctx.lineTo(-4.4, 3.6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.roundRect(mx, my, mw, mw, 8);
  ctx.stroke();
  // compass direction to the objective
  if (mission?.marker) {
    const a = Math.atan2(mission.marker.y - player.y, mission.marker.x - player.x);
    const d = Math.round(dist(player, mission.marker) / 10);
    ctx.fillStyle = '#ffd13f';
    ctx.font = 'bold 14px system-ui';
    ctx.textAlign = 'center';
    ctx.save();
    ctx.translate(W / 2, 64);
    ctx.rotate(a + Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5.4, 5);
    ctx.lineTo(-5.4, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillText(`${d}m`, W / 2, 92);
  }
  // message + dialogue
  if (G.msgT > 0) {
    ctx.fillStyle = 'rgba(8,10,14,0.6)';
    ctx.font = 'bold 19px system-ui';
    const tw = ctx.measureText(G.msg).width + 36;
    ctx.beginPath();
    ctx.roundRect(W / 2 - tw / 2, H - 118, tw, 36, 8);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(G.msg, W / 2, H - 94);
  }
  if (G.dialogue && G.dialogueT > 0) {
    ctx.fillStyle = 'rgba(8,10,14,0.78)';
    ctx.beginPath();
    ctx.roundRect(W / 2 - 330, H - 76, 660, 58, 9);
    ctx.fill();
    ctx.fillStyle = '#ffd13f';
    ctx.font = 'bold 14px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText(G.dialogue.who, W / 2 - 312, H - 54);
    ctx.fillStyle = '#f2f4f6';
    ctx.font = '15.5px system-ui';
    wrapText(G.dialogue.text, W / 2 - 312, H - 34, 624, 19);
  }
  // interact prompt
  if (!player.car && G.mode === 'play') {
    const nearCar = cars.some((c) => !c.dead && Math.hypot(c.x - player.x, c.y - player.y) < 52);
    if (nearCar) {
      ctx.fillStyle = 'rgba(8,10,14,0.6)';
      ctx.font = 'bold 15px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('E — get in', W / 2, H - 132);
    }
  } else if (player.car) {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '13.5px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('E — get out · SPACE — handbrake', W / 2, H - 12);
  }
}
function wrapText(text, x, y, maxW, lh) {
  const words = text.split(' ');
  let line = '';
  let yy = y;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, yy);
      line = w;
      yy += lh;
    } else line = test;
  }
  ctx.fillText(line, x, yy);
}

function drawTitle() {
  // a slow pan over the city behind the title
  cam.x = clamp(WORLD / 2 - W / 2 + Math.sin(G.time * 0.07) * 500, 0, WORLD - W);
  cam.y = clamp(WORLD / 2 - H / 2 + Math.cos(G.time * 0.05) * 400, 0, WORLD - H);
  drawWorld();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(10,8,24,0.55)');
  grad.addColorStop(0.55, 'rgba(10,8,24,0.25)');
  grad.addColorStop(1, 'rgba(10,8,24,0.72)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ff5da2';
  ctx.font = 'italic bold 30px system-ui, sans-serif';
  ctx.fillText('P O R T   A Z U R A', W / 2, 168);
  ctx.fillStyle = '#fff';
  ctx.font = '900 104px system-ui, sans-serif';
  ctx.shadowColor = '#ff2d78';
  ctx.shadowBlur = 34;
  ctx.fillText('VICE HARBOR', W / 2, 268);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffd13f';
  ctx.font = '600 21px system-ui';
  ctx.fillText('Steal it. Drive it. Outrun the law. Own the coast.', W / 2, 312);
  ctx.fillStyle = 'rgba(8,10,14,0.66)';
  ctx.beginPath();
  ctx.roundRect(W / 2 - 268, 356, 536, 168, 12);
  ctx.fill();
  ctx.fillStyle = '#f2f4f6';
  ctx.font = '16.5px system-ui';
  ctx.textAlign = 'left';
  const lines = [
    'WASD / arrows — move & drive      E — enter / exit car',
    'Mouse — aim · click — shoot       R — reload',
    'Shift — run · SPACE — handbrake',
    'Finish Rosa’s five jobs to own Port Azura.',
    save.mission > 0 ? `Saved game: $${save.cash.toLocaleString()} · job ${Math.min(save.mission + 1, 5)} of 5` : 'No saved game yet — a fresh start awaits.',
  ];
  lines.forEach((l, i) => ctx.fillText(l, W / 2 - 244, 392 + i * 27));
  ctx.textAlign = 'center';
  ctx.fillStyle = Math.sin(G.time * 3) > -0.2 ? '#ffd13f' : 'rgba(255,209,63,0.4)';
  ctx.font = 'bold 24px system-ui';
  ctx.fillText(save.mission > 0 ? 'CLICK or ENTER — CONTINUE · a fresh run resets the story' : 'CLICK or ENTER — START', W / 2, 596);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '13.5px system-ui';
  ctx.fillText('An original game: its own city, people, cars and story. Headphones on — the sirens are real.', W / 2, 668);
}

function drawEndCard(big, sub, hint) {
  ctx.fillStyle = 'rgba(8,6,16,0.72)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ff5da2';
  ctx.font = '900 74px system-ui';
  ctx.fillText(big, W / 2, 300);
  ctx.fillStyle = '#f2f4f6';
  ctx.font = '21px system-ui';
  ctx.fillText(sub, W / 2, 352);
  ctx.fillStyle = '#ffd13f';
  ctx.font = 'bold 18px system-ui';
  ctx.fillText(hint, W / 2, 430);
}

// ---------- main loop ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.033, (now - last) / 1000);
  last = now;
  G.time += dt;
  G.dayT = (G.dayT + dt / 240) % 1;
  if (G.msgT > 0) G.msgT -= dt;
  if (G.dialogueT > 0) {
    G.dialogueT -= dt;
    if (G.dialogueT <= 0 && mission?.introQueue.length) {
      const next = mission.introQueue.shift();
      if (next) say(next[0], next[1], 5);
    }
  }
  if (G.mode === 'play' && !SHOT) {
    updatePlayer(dt);
    updateCars(dt);
    updatePolice(dt);
    updatePeds(dt);
    updateBullets(dt);
    if (mission && !mission.failed) {
      mission.def.update(mission, dt);
      if (mission) G.objective = mission.objective;
    }
    if (player.health <= 0 && G.mode === 'play') G.mode = 'wasted';
    cam.x = clamp(player.x - W / 2 + (G.shake ? rand(-G.shake, G.shake) : 0), 0, WORLD - W);
    cam.y = clamp(player.y - H / 2 + (G.shake ? rand(-G.shake, G.shake) : 0), 0, WORLD - H);
    G.shake = Math.max(0, G.shake - dt * 14);
  }
  ctx.clearRect(0, 0, W, H);
  if (G.mode === 'title') {
    drawTitle();
  } else {
    if (G.mode !== 'play') {
      // frozen scene behind the end cards
      cam.x = clamp(player.x - W / 2, 0, WORLD - W);
      cam.y = clamp(player.y - H / 2, 0, WORLD - H);
    }
    drawWorld();
    for (const c of cars) drawCar(c);
    for (const p of peds) drawPed(p);
    if (player.car) drawCar(player.car);
    else drawPed(player, true);
    for (const b of bullets) {
      ctx.fillStyle = '#ffe9a8';
      ctx.fillRect(b.x - 2 - cam.x, b.y - 1 - cam.y, 5, 2.4);
    }
    for (const p of parts) {
      ctx.globalAlpha = 1 - p.t / p.life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x - cam.x, p.y - cam.y, p.r, 0, 6.29);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // dusk / night tint
    const dark = Math.max(0, Math.sin((G.dayT - 0.22) * Math.PI * 2)) * 0.34;
    if (dark > 0.01) {
      ctx.fillStyle = `rgba(10,14,44,${dark})`;
      ctx.fillRect(0, 0, W, H);
      for (const l of lamps) {
        const lx = l.x - cam.x;
        const ly = l.y - cam.y;
        if (lx < -40 || lx > W + 40 || ly < -40 || ly > H + 40) continue;
        ctx.fillStyle = 'rgba(255,214,120,0.10)';
        ctx.beginPath();
        ctx.arc(lx, ly, 30, 0, 6.29);
        ctx.fill();
      }
    }
    drawHUD();
    if (G.mode === 'busted') drawEndCard('BUSTED', 'The Port Azura PD thanks you for your cooperation. Bail: $150.', 'Press R to get back on the street');
    if (G.mode === 'wasted') drawEndCard('WASTED', 'You wake up outside Azura General. The city keeps your $150.', 'Press R to get back on the street');
    if (G.mode === 'ending') {
      drawWorld();
      drawEndCard('PORT AZURA IS YOURS', `Dante and Rosa vanish across the bay. Story complete — $${G.earned.toLocaleString()} earned across five jobs.`, 'Press ENTER to keep roaming Port Azura');
    }
  }
  requestAnimationFrame(frame);
}

// ---------- screenshot set-ups (the kit's shots.json drives these) ----------
if (SHOT === 'start') {
  G.mode = 'title';
} else if (SHOT === 'play') {
  spawnAmbient();
  G.mode = 'play';
  G.dayT = 0.04; // bright morning for the cover action shot
  const hero = makeCar(roadV[4], roadH[5], 0, 'traffic');
  hero.color = '#e8c33c';
  hero.driver = 'player';
  hero.speed = 190;
  player.car = hero;
  player.x = hero.x;
  player.y = hero.y;
  player.angle = 0;
  for (let k = 1; k <= 2; k++) {
    const cop = makeCar(hero.x - 120 * k - 60, hero.y + (k % 2 ? 26 : -26), 0, 'police');
    cop.speed = 200;
    cop.sirenPhase = k * 2;
  }
  G.wanted = 3;
  G.cash = 1750;
  G.objective = 'Lose the police!';
  mission = null;
  // bystanders on the sidewalks near the chase, mid-scamper
  for (let k = 0; k < 7; k++) {
    const p = makePed(hero.x + rand(-330, 330), hero.y + (k % 2 ? 74 : -74));
    p.state = 'flee';
    p.t = 99;
  }
  cam.x = clamp(player.x - W / 2, 0, WORLD - W);
  cam.y = clamp(player.y - H / 2, 0, WORLD - H);
} else if (SHOT === 'end') {
  spawnAmbient();
  G.mode = 'ending';
  G.earned = 10200;
  player.x = roadV[6];
  player.y = BEACH_Y - 60;
  cam.x = clamp(player.x - W / 2, 0, WORLD - W);
  cam.y = clamp(player.y - H / 2, 0, WORLD - H);
}
requestAnimationFrame(frame);
