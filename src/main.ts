import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './style.css';
import { World } from './world';
import { Effects } from './effects';
import { Office } from './office';
import { Director } from './director';
import { Hud } from './hud';
import { Sound } from './sound';
import { Demo } from './demo';
import type { OfficeEvent } from './types';
import { Emotes } from './emotes';
import { Tease, TOOLS, type Tool } from './tease';
import { setCamera } from './reactions';
import { Colliders } from './colliders';
import { Player, type CamMode } from './player';
import { Social } from './social';
import { Chat } from './chat';
import { mergeStatic, trimShadowCasters, AdaptiveResolution } from './perf';
import { AvatarPicker, savedAvatar } from './avatar';
import { Dispatch } from './dispatch';
import { APP_NAME, APP_TAGLINE } from './brand';
import { AnswerCard } from './answer';

document.title = APP_NAME;
document.getElementById('appname')!.textContent = APP_NAME;
document.getElementById('welcome')!.textContent = `Welcome to ${APP_NAME}`;
void APP_TAGLINE;

// ------------------------------------------------------------------ renderer / scene / camera
const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
const adaptive = new AdaptiveResolution(renderer);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf6eee2);
scene.fog = new THREE.Fog(0xf6eee2, 24, 42);

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 100);
const HOME_POS = new THREE.Vector3(3.6, 7.4, 10.2);
const HOME_TARGET = new THREE.Vector3(-0.9, 0.5, -0.5);
camera.position.copy(HOME_POS);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(HOME_TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 4;
controls.maxDistance = 24;
controls.minPolarAngle = 0.3;
controls.maxPolarAngle = 1.3;
controls.minAzimuthAngle = -1.2;
controls.maxAzimuthAngle = 1.2;
controls.screenSpacePanning = false;
controls.update();

// ------------------------------------------------------------------ the office
const world = new World(scene);
// bake static furniture into a few big meshes (hundreds of draw calls → a few dozen)
const merged = mergeStatic(scene, world.dynamicObjects());
for (const d of world.desks) mergeStatic(d.chair, []);
for (const o of world.dynamicObjects()) if (o.children.length > 3 && !world.desks.some((d) => d.chair === o || d.monitor === o)) mergeStatic(o, []);
console.info(`[office] merged ${merged.before} static meshes into ${merged.after}`);
trimShadowCasters(scene, 0.12);
const fx = new Effects(scene);
const sound = new Sound();
const office = new Office(scene, world, fx, sound);
const director = new Director(office);
const hud = new Hud();
const demo = new Demo((e) => ingest(e, true));
const emotes = new Emotes(scene);
office.emotes = emotes;
setCamera(camera.position);

// ------------------------------------------------------------------ teasing
let shakeAmt = 0;
const splatEl = document.getElementById('splat')!;
const tease = new Tease({
  scene,
  camera,
  canvas: renderer.domElement,
  controls,
  office,
  world,
  emotes,
  sound,
  shake: (a) => (shakeAmt = Math.max(shakeAmt, a)),
  splat: (kind) => {
    const el = document.createElement('div');
    el.className = `splat ${kind}`;
    el.style.left = `${30 + Math.random() * 40}%`;
    el.style.top = `${25 + Math.random() * 40}%`;
    el.style.rotate = `${Math.random() * 360}deg`;
    splatEl.appendChild(el);
    shakeAmt = Math.max(shakeAmt, kind === 'water' ? 0.12 : 0.25);
    if (kind === 'slap') el.textContent = '🖐️';
    setTimeout(() => el.classList.add('gone'), kind === 'water' ? 1400 : 900);
    setTimeout(() => el.remove(), 2600);
  },
});
const TOOL_INFO: Record<Tool, [string, string]> = {
  hand: ['👆', 'Poke · drag to pick up · click fast to tickle'],
  slap: ['🖐️', 'Slap them across the face'],
  smack: ['🤚', 'Smack the back of their head'],
  paper: ['🗞️', 'Throw a paper ball'],
  water: ['💦', 'Hold to squirt water'],
  power: ['⏻', 'Switch their monitor off'],
  mug: ['☕', 'Steal their coffee'],
  spin: ['🌀', 'Spin their chair (or right-click)'],
  chair: ['🪑', 'Pull their chair away'],
  duck: ['🦆', 'Throw a rubber duck (calms them down)'],
};
const toolbar = document.getElementById('tease')!;
TOOLS.forEach((t, i) => {
  const b = document.createElement('button');
  b.dataset.tool = t;
  b.innerHTML = `<span>${TOOL_INFO[t][0]}</span><kbd>${(i + 1) % 10}</kbd>`;
  b.title = TOOL_INFO[t][1];
  b.onclick = () => tease.setTool(t);
  toolbar.appendChild(b);
});
const tip = document.getElementById('teasetip')!;
tease.onToolChange = (t) => {
  toolbar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  tip.textContent = TOOL_INFO[t][1];
};
tease.setTool('hand');

// ------------------------------------------------------------------ your own character
const colliders = new Colliders(world);
const player = new Player(scene, colliders, office, sound, fx, renderer.domElement);
trimShadowCasters(player.agent.rig.root);
const social = new Social(office, player, tease);
const picker = new AvatarPicker();
const dispatch = new Dispatch(office, director, world, sound);
const answerCard = new AnswerCard();
answerCard.onAnswered = (a) => {
  a.react({ name: 'thanks', dur: 1.2, hold: false, pose: () => 'happy' });
};
hud.onAnswer = (id) => {
  const a = office.agents.get(id);
  if (!a?.pendingAsk) return;
  if (player.mode === 'orbit') hud.follow(id); // glide over to them
  answerCard.open(a);
};
let askHintUntil = 0;
office.onAsk = (a) => {
  askHintUntil = performance.now() + 8000;
  askHintText = `${a.name} has a question: walk over and press E${player.mode === 'orbit' ? ' (or click the ❓)' : ''}`;
};
let askHintText = '';
/** Nearest agent with an open question within reach (walk modes). */
function askTarget() {
  if (!player.spawned || player.mode === 'orbit') return null;
  let best = null as null | ReturnType<typeof office.agents.get>;
  let bd = 2.6;
  for (const a of office.agents.values()) {
    if (!a.pendingAsk || a.removed) continue;
    const d = a.position.distanceTo(player.position);
    if (d < bd) {
      bd = d;
      best = a;
    }
  }
  return best;
}
// tell the server whether the office is on screen: questions are only held for you while it is
const presence = () =>
  fetch('/api/presence', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-office': '1' }, body: JSON.stringify({ visible: !document.hidden }) }).catch(() => {});
presence();
setInterval(presence, 10_000);
document.addEventListener('visibilitychange', presence);
const hintEl = document.getElementById('hint')!;
document.getElementById('dispatchBtn')!.onclick = () => dispatch.toggle();
dispatch.onOpenChange = (open) => {
  if (open) chat.close();
};
player.onStandUp = () => dispatch.close();
const MANAGER_STAND = world.manager.seat.clone().add(new THREE.Vector3(0.8, 0, 0));
function nearManagerChair() {
  return player.spawned && player.mode !== 'orbit' && !player.seat && player.position.distanceTo(world.manager.seat) < 1.5;
}
const savedLook = savedAvatar();
if (savedLook) player.setLook(savedLook.gender, savedLook.name);
document.getElementById('who')!.onclick = async () => {
  const c = await picker.open(savedAvatar() ?? { gender: player.gender, name: player.playerName });
  player.releaseKeys();
  if (c) player.setLook(c.gender, c.name);
};
const chat = new Chat(office, player, sound, camera);
chat.agentIdOf = (id) => director.agentIdOf(id);
hud.onTalk = (id) => {
  const a = office.agents.get(id);
  if (a) chat.open(a);
};
chat.onOpenChange = (open) => {
  if (open) dispatch.close();
  // in the overview, glide over to the agent you are talking to
  if (open && chat.agent && player.mode === 'orbit') hud.follow(chat.agent.id);
};
let talkAcc = 0;
/** Nearest agent in front of you within talking distance (walk modes). */
function talkTarget() {
  if (!player.spawned || player.mode === 'orbit') return null;
  const p = player.position;
  const yaw = player.agent.yawAngle;
  const f = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  let best = null as null | (typeof office.agents extends Map<string, infer A> ? A : never);
  let bd = 2.5;
  for (const a of office.agents.values()) {
    if (a.removed || a.held || a.falling) continue;
    const to = a.position.clone().sub(p).setY(0);
    const d = to.length();
    if (d < bd && (d < 0.6 || to.normalize().dot(f) > 0.3)) {
      bd = d;
      best = a;
    }
  }
  return best;
}
let lastOrbit = { pos: HOME_POS.clone(), target: HOME_TARGET.clone() };
const viewBtn = document.getElementById('view') as HTMLButtonElement;
const crosshair = document.getElementById('crosshair')!;
const MODE_LABEL: Record<CamMode, string> = { orbit: '🚶 Walk', third: '🎥 3rd person', first: '👀 1st person' };
function spawnPlayer() {
  if (!player.spawned) player.spawn(world.doorIn.clone(), Math.PI / 2);
}
function setMode(m: CamMode) {
  // first time stepping in: choose a male or female character and a name
  if (!player.spawned && m !== 'orbit' && !savedAvatar()) {
    if (picker.isOpen) return;
    picker.open(null).then((c) => {
      player.releaseKeys();
      if (c) player.setLook(c.gender, c.name);
      setMode(m);
    });
    return;
  }
  spawnPlayer();
  if (player.mode === 'orbit' && m !== 'orbit') lastOrbit = { pos: camera.position.clone(), target: controls.target.clone() };
  player.setMode(m, camera);
}
player.onModeChange = (m) => {
  viewBtn.textContent = MODE_LABEL[m];
  controls.enabled = m === 'orbit';
  crosshair.classList.toggle('show', m === 'first');
  document.body.classList.toggle('fp', m === 'first');
  sound.setMusicFocus(m === 'first');
  if (m === 'orbit') {
    hud.follow(null);
    // fly back up to where the overview camera was
    const p = player.position;
    const off = lastOrbit.pos.clone().sub(lastOrbit.target);
    camGoal = { pos: p.clone().setY(0).add(off), target: p.clone().setY(0.6) };
    camera.fov = 38;
    camera.updateProjectionMatrix();
  }
};
viewBtn.onclick = () => (player.mode === 'orbit' ? setMode('third') : player.mode === 'third' ? setMode('first') : setMode('orbit'));
player.onFirstMove = () => setMode('third');
addEventListener('keyup', (e) => {
  if (e.key.toLowerCase() === 'r' && chat.isPushToTalk) chat.stopVoice(true);
});
addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'escape' && chat.isOpen) {
    chat.close();
    return;
  }
  if (k === 'escape' && answerCard.isOpen) {
    answerCard.close();
    return;
  }
  if (k === 'escape' && dispatch.isOpen) {
    dispatch.close();
    return;
  }
  // walkie-talkie: hold R near an agent (or with one followed / chatting), speak, release to send
  if (k === 'r' && chat.voice.canListen) {
    const a = chat.agent ?? talkTarget() ?? (hud.followId ? office.agents.get(hud.followId) : null);
    if (a) {
      e.preventDefault();
      if (!chat.isOpen || chat.agent !== a) chat.open(a, false);
      chat.startVoice(true);
    }
    return;
  }
  if (k === 't' || (k === 'enter' && !chat.isOpen)) {
    const a = talkTarget() ?? (hud.followId ? office.agents.get(hud.followId) : null);
    if (a) {
      e.preventDefault();
      chat.open(a);
    }
    return;
  }
  if (k === 'v') viewBtn.click();
  else if (k === 'e') {
    spawnPlayer();
    const asking = askTarget();
    if (asking) {
      answerCard.open(asking);
    } else if (player.seat) {
      player.standUp();
    } else if (nearManagerChair()) {
      // take the boss chair and open the dispatch panel
      player.sit(world.manager.seat, world.manager.seatYaw, MANAGER_STAND);
      player.agent.say('Let’s get some work done.', 'say', 2);
      dispatch.open();
    } else player.interact();
  } else if (k === 'm') musicBtn.click();
});

let panelDirty = true;
office.onChange = () => (panelDirty = true);
director.onChange = () => (panelDirty = true);

function ingest(e: OfficeEvent, isDemo = false) {
  director.handle(e);
  hud.log(e, isDemo);
  chat?.track(e, director.officeIdFor(e));
  dispatch?.onEvent(e);
}

// ------------------------------------------------------------------ live connection
let liveEvents = 0;
function connect() {
  hud.setConn('connecting');
  const es = new EventSource('/api/stream');
  es.addEventListener('replay', (m) => {
    const events = JSON.parse((m as MessageEvent).data) as OfficeEvent[];
    director.replay(events);
    // questions older than the replay window are still waiting: put those raised hands back too
    fetch('/api/asks', { headers: { 'x-agent-office': '1' } })
      .then((r) => r.json())
      .then((j) => {
        for (const q of j.asks ?? []) {
          const known = [...office.agents.values()].some((a) => a.pendingAsk?.id === q.id);
          if (!known) director.handle({ id: 0, t: Date.now(), kind: 'Ask', session: q.session, agentId: q.agentId, project: '', detail: q.summary, ask: q });
        }
      })
      .catch(() => {});
    events.slice(-25).forEach((e) => hud.log(e));
    hud.setConn('live');
  });
  es.onmessage = (m) => {
    liveEvents++;
    ingest(JSON.parse(m.data));
    hud.setConn('live', ` · ${liveEvents} event${liveEvents === 1 ? '' : 's'}`);
  };
  es.onopen = () => hud.setConn('live');
  es.onerror = () => hud.setConn(es.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
}
connect();

// ------------------------------------------------------------------ controls
const demoBtn = document.getElementById('demo') as HTMLButtonElement;
demoBtn.onclick = () => {
  if (demo.running) {
    demo.stop();
    demoBtn.textContent = '▶ Demo';
    return;
  }
  demoBtn.textContent = '■ Stop demo';
  demo.start(() => (demoBtn.textContent = '▶ Demo'));
};
const soundBtn = document.getElementById('sound') as HTMLButtonElement;
const musicBtn = document.getElementById('music') as HTMLButtonElement;
const syncSoundButtons = () => {
  soundBtn.textContent = sound.enabled ? '🔊' : '🔈';
  musicBtn.textContent = '🎵';
  musicBtn.classList.toggle('off', !sound.musicOn);
  soundBtn.title = sound.enabled ? (sound.running ? 'Sound on (click to mute)' : 'Sound starts on your first click or key press') : 'Sound off';
};
sound.onStateChange = syncSoundButtons;
syncSoundButtons();
soundBtn.onclick = () => sound.toggle();
musicBtn.onclick = () => sound.toggleMusic();
document.getElementById('reset')!.onclick = () => {
  hud.follow(null);
  if (player.mode !== 'orbit') setMode('orbit');
  camGoal = { pos: HOME_POS.clone(), target: HOME_TARGET.clone() };
};
document.getElementById('help')!.onclick = () => document.getElementById('helpbox')!.classList.toggle('open');
document.getElementById('helpclose')!.onclick = () => document.getElementById('helpbox')!.classList.remove('open');

// camera follow: ease the orbit target toward the followed character
let camGoal: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
hud.onFollow = (id) => {
  if (!id) return;
  const a = office.agents.get(id);
  if (!a) return;
  const off = camera.position.clone().sub(controls.target).setLength(7);
  camGoal = { pos: a.position.clone().add(off), target: a.position.clone().setY(0.9) };
};
office.onFollowRemoved = (id) => {
  if (hud.followId === id) hud.follow(null);
};
controls.addEventListener('start', () => (camGoal = null));

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ------------------------------------------------------------------ loop
let last = performance.now();
let g = 0;
let tickAcc = 0;
let panelAcc = 0;
let lastFrame = performance.now();
let loggedLayerError = false;
let crossAcc = 0;

/** Advance the simulation by real elapsed time, in small steps so walks stay smooth. */
function simulate() {
  const now = performance.now();
  let elapsed = Math.min((now - last) / 1000, 5);
  last = now;
  let dt = 0;
  while (elapsed > 1e-4) {
    dt = Math.min(elapsed, 1 / 30);
    elapsed -= dt;
    g += dt;
    office.update(dt, g);
    // a bug in a cosmetic layer must never freeze the live office
    try {
      player.update(dt, g, camera);
      tease.update(dt);
      social.update();
      chat.update();
      emotes.update(dt);
    } catch (err) {
      if (!loggedLayerError) console.error('tease/emote update failed', err);
      loggedLayerError = true;
    }
  }
  return dt;
}

// Background tabs (and embedded previews) pause requestAnimationFrame. Keep the office
// living in real time anyway, so agents are where they should be when you look again.
setInterval(() => {
  if (performance.now() - lastFrame > 300) {
    simulate();
    frame(0.1);
  }
}, 200);

renderer.setAnimationLoop(() => {
  const now = performance.now();
  adaptive.tick((now - lastFrame) / 1000);
  lastFrame = now;
  frame(simulate());
});

function frame(dt: number) {

  tickAcc += dt;
  if (tickAcc > 1) {
    tickAcc = 0;
    director.tick();
  }
  panelAcc += dt;
  if (panelAcc > 0.5 && panelDirty) {
    panelAcc = 0;
    panelDirty = false;
    hud.renderPanel([...office.agents.values()], director.stats());
    chat.refresh();
    world.drawBoard(office.boardItems());
  }

  if (hud.followId) {
    const a = office.agents.get(hud.followId);
    if (a) {
      const k = 1 - Math.exp(-dt / 0.35);
      const tgt = a.position.clone().setY(0.9);
      const delta = tgt.sub(controls.target).multiplyScalar(k);
      controls.target.add(delta);
      camera.position.add(delta);
    }
  }
  if (player.mode === 'orbit') {
    if (camGoal) {
      const k = 1 - Math.exp(-dt / 0.3);
      camera.position.lerp(camGoal.pos, k);
      controls.target.lerp(camGoal.target, k);
      if (camera.position.distanceTo(camGoal.pos) < 0.01) camGoal = null;
    }
    controls.update();
    // arrow keys in the overview move you relative to what you are looking at
    const look = controls.target.clone().sub(camera.position);
    player.orbitYaw = Math.atan2(look.x, look.z);
  }
  sound.setListener(camera);
  sound.update();
  talkAcc += dt;
  if (talkAcc > 0.1) {
    talkAcc = 0;
    const near = askTarget();
    const hint = near
      ? `Press E to answer ${near.name}`
      : performance.now() < askHintUntil
        ? askHintText
        : nearManagerChair()
          ? 'Press E to sit at the manager desk'
          : player.seat
            ? 'Move to stand up · E to leave the desk'
            : '';
    answerCard.update();
    hintEl.textContent = hint;
    hintEl.classList.toggle('show', !!hint);
    const t = chat.isOpen ? null : talkTarget();
    hud.talkableId = t ? t.id : null;
  }
  if (player.mode === 'first') {
    crossAcc += dt;
    if (crossAcc > 0.1) {
      crossAcc = 0;
      crosshair.classList.toggle('hot', !!tease.aimAgentAtCenter());
    }
  }
  // camera shake (screen splats, hard landings)
  const shake = new THREE.Vector3();
  if (shakeAmt > 0.001) {
    shake.set((Math.random() - 0.5) * shakeAmt, (Math.random() - 0.5) * shakeAmt, 0).applyQuaternion(camera.quaternion);
    camera.position.add(shake);
    shakeAmt *= Math.exp(-dt * 9);
  }
  renderer.render(scene, camera);
  camera.position.sub(shake);
  const tagged = [...office.agents.values()];
  if (player.spawned && player.mode !== 'first') tagged.push(player.agent);
  hud.update(tagged, camera, innerWidth, innerHeight);
}

// handy for debugging from the console
Object.assign(window, { office, director, world, ingest, camera, controls, demo, tease, emotes, player, sound, social, chat, dispatch });
