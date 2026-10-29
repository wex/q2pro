// @ts-check
'use strict';

// CS_* configstring layout constants come from consts.js (loaded first in
// index.html); the values are verified against src/player-loadout.ts by
// test/browser-consts.test.ts.

const SSE_URL = '/events';
const MAP_URL = '/maps/';

const mapCanvas = /** @type {HTMLCanvasElement} */ (document.getElementById('map'));
const playersCanvas = /** @type {HTMLCanvasElement} */ (document.getElementById('players'));
const mapCtx = /** @type {CanvasRenderingContext2D} */ (mapCanvas.getContext('2d'));
const playersCtx = /** @type {CanvasRenderingContext2D} */ (playersCanvas.getContext('2d'));
const elConn = /** @type {HTMLElement} */ (document.getElementById('status-conn'));
const elStop = /** @type {HTMLElement} */ (document.getElementById('status-stop'));
const elModal = /** @type {HTMLElement} */ (document.getElementById('session-modal'));
const elConnectForm = /** @type {HTMLFormElement} */ (document.getElementById('connect-form'));
const elReplayForm = /** @type {HTMLFormElement} */ (document.getElementById('replay-form'));
const elConnectHost = /** @type {HTMLInputElement} */ (document.getElementById('connect-host'));
const elConnectPort = /** @type {HTMLInputElement} */ (document.getElementById('connect-port'));
const elConnectPassword = /** @type {HTMLInputElement} */ (document.getElementById('connect-password'));
const elDemoSelect = /** @type {HTMLSelectElement} */ (document.getElementById('demo-select'));
const elSessionError = /** @type {HTMLElement} */ (document.getElementById('session-error'));
const elTabs = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#session-modal .tab'));
const elTabPanels = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#session-modal .tab-panel'));
const elMap = /** @type {HTMLElement} */ (document.getElementById('status-map'));
const elTime = /** @type {HTMLElement} */ (document.getElementById('status-time'));
const elEntities = /** @type {HTMLElement} */ (document.getElementById('status-entities'));
const elScoreboardBody = /** @type {HTMLElement} */ (document.querySelector('#scoreboard tbody'));
const elStatsBody = /** @type {HTMLElement} */ (document.querySelector('#stats tbody'));
const elTeamScores = /** @type {HTMLElement} */ (document.getElementById('team-scores'));
const elKillfeed = /** @type {HTMLElement} */ (document.getElementById('killfeed'));
const elChat = /** @type {HTMLElement} */ (document.getElementById('chat'));
const elBtnTextures = /** @type {HTMLButtonElement} */ (document.getElementById('btn-textures'));
const elPanel = /** @type {HTMLElement} */ (document.getElementById('panel'));
const elReplayPause = /** @type {HTMLButtonElement} */ (document.getElementById('replay-pause'));
const elReplaySeek = /** @type {HTMLInputElement} */ (document.getElementById('replay-seek'));
const elReplaySpeed = /** @type {HTMLSelectElement} */ (document.getElementById('replay-speed'));

let texturesEnabled = true;      // toggled by Tex button / T hotkey
let lockedPlayerNum = null;      // null = free camera; integer = locked client slot
let mapBitmap = null;           // ImageBitmap or HTMLCanvasElement
let mapBitmapScale = 0;         // pixels per world unit used for current bitmap
let mapSvgBlobUrl = null;       // current SVG blob URL (for re-raster)
let mapBounds = null;
let currentMapname = '';
let players = [];
/** Sticky last-seen loadout per client slot (cleared on playerskin CS empty / map change). */
let loadoutCache = {};
let transform = { tx: 0, ty: 0, scale: 1 };
let configstrings = {};
let serverStatus = null;
let statusMaxclients = 0;
let dpr = window.devicePixelRatio || 1;

// Caches invalidated on configstring changes
let teamMapCache = null;
let playerInfoCache = {};
let maxclientsCache = 0;
// Client slot of the MVD observer dummy (from serverdata.clientNum, -1 when
// the stream has none). The dummy owns a playerskin configstring ("[MVDSPEC]")
// so configstring-derived rosters must skip it explicitly — the SSE `players`
// array is already filtered server-side.
let dummyNum = -1;

// Configstring layout of the current stream (from serverdata.extended).
// The EXT bases alias into the vanilla CS_MODELS range, so always pick one
// base set rather than probing both.
let csExtended = false;
const csB = () => (csExtended
    ? { models: CS_MODELS_EXT, playerskins: CS_PLAYERSKINS_EXT, maxclients: CS_MAXCLIENTS_EXT }
    : { models: CS_MODELS_OLD, playerskins: CS_PLAYERSKINS_OLD, maxclients: CS_MAXCLIENTS_OLD });

// ─── Configstring layout / colours ───────────────────────────────────────────

const TEAM_COLOURS = [
    { fill: 'rgba(220, 30, 30, 0.85)', stroke: 'rgba(255, 160, 160, 0.9)', cone: 'rgba(220, 30, 30, 0.3)', coneStroke: 'rgba(220, 30, 30, 0.6)' },
    { fill: 'rgba(30, 100, 220, 0.85)', stroke: 'rgba(160, 190, 255, 0.9)', cone: 'rgba(30, 100, 220, 0.3)', coneStroke: 'rgba(30, 100, 220, 0.6)' },
    { fill: 'rgba(30, 180, 60, 0.85)', stroke: 'rgba(160, 255, 170, 0.9)', cone: 'rgba(30, 180, 60, 0.3)', coneStroke: 'rgba(30, 180, 60, 0.6)' },
];
const DEFAULT_COLOUR = { fill: 'rgba(140, 140, 140, 0.85)', stroke: 'rgba(200, 200, 200, 0.9)', cone: 'rgba(140, 140, 140, 0.3)', coneStroke: 'rgba(140, 140, 140, 0.6)' };

// Scoreboard loadout icons under /assets/. Grapple has no icon by design.
const WEAPON_ICON = {
    MK23: 'w_mk23.png',
    MP5: 'w_mp5.png',
    M4: 'w_m4.png',
    M3: 'w_super90.png',
    HC: 'w_cannon.png',
    SSG: 'w_sniper.png',
    Dual: 'w_akimbo.png',
    Knife: 'w_knife.png',
    G: 'a_m61frag.png',
};
const ITEM_ICON = {
    Sil: 'p_silencer.png',
    Slip: 'slippers.png',
    Band: 'p_bandolier.png',
    Kev: 'i_jacketarmor.png',
    Helm: 'p_rebreather.png',
    Laser: 'p_laser.png',
};

function loadoutIconHtml(label, map) {
    if (!label) {
        return '<span class="sb-icon-slot sb-icon-empty" aria-hidden="true"></span>';
    }
    const safe = escapeHtml(label);
    const file = map[label];
    if (!file) {
        return `<span class="sb-icon-slot sb-icon-label" title="${safe}">${safe}</span>`;
    }
    // Missing asset files fall back to label text via the delegated error
    // listener registered below (no inline handler to escape into).
    return `<img class="sb-icon" src="/assets/${file}" alt="${safe}" title="${safe}">`;
}

// Delegated icon-fallback: <img> error events don't bubble, so a
// capture-phase listener on the document swaps a broken sb-icon for its
// label text regardless of which innerHTML batch inserted it.
document.addEventListener('error', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLImageElement) || !el.classList.contains('sb-icon')) return;
    const span = document.createElement('span');
    span.className = 'sb-icon-slot sb-icon-label';
    span.title = el.alt;
    span.textContent = el.alt;
    el.replaceWith(span);
}, true);

// ─── Combat FX ───────────────────────────────────────────────────────────────
//
// Three in-place effects replace the old shot-line traces:
//
//  1. Flash  — player's cone briefly glows when they fire (svc_muzzleflash).
//              Duration scales with weapon via FLASH_DURATION_MS_BY_MZ.
//  2. Damage — particle burst + expanding ring on the victim when a blood
//              or sparks TE lands on them. Yellow for sparks, red for blood.
//              Rate-limited to one burst per victim per DAMAGE_COOLDOWN_MS.
//  3. Death — skull glyph fading at the victim's death location, triggered
//              by STAT_HEALTH transitioning to <= 0 server-side (svc 'death').
//
// All FX use performance.now() clocks so fading is smooth independent of
// SSE delivery cadence. Every live FX keeps the players canvas ticking via
// scheduleRender(PLAYERS_DIRTY).

const FLASH_DURATION_DEFAULT_MS = 120;
// Indexed by MZ_* ids from inc/shared/shared.h. Unlisted ids use the default.
const FLASH_DURATION_MS_BY_MZ = {
    0: 120,  // MZ_BLASTER
    1: 120,  // MZ_MACHINEGUN
    2: 160,  // MZ_SHOTGUN
    3: 140,  // MZ_CHAINGUN1
    4: 140,  // MZ_CHAINGUN2
    5: 140,  // MZ_CHAINGUN3
    6: 260,  // MZ_RAILGUN
    7: 200,  // MZ_ROCKET
    8: 180,  // MZ_GRENADE
    12: 240, // MZ_BFG
    13: 180, // MZ_SSHOTGUN (super shotgun / AQ2 M3+HC)
    14: 120, // MZ_HYPERBLASTER
    30: 200, // MZ_ETF_RIFLE
    32: 260, // MZ_SHOTGUN2 / AQ2 sniper family
    34: 120, // MZ_BLASTER2
    36: 220, // MZ_NUKE1
    37: 240, // MZ_NUKE2
};

const PARTICLE_COUNT = 8;
const PARTICLE_TTL_MS = 600;
const PARTICLE_MIN_SPEED = 20;   // px/s (SVG space)
const PARTICLE_MAX_SPEED = 60;
const PARTICLE_MIN_RADIUS = 1.2;
const PARTICLE_MAX_RADIUS = 2.8;

const RING_TTL_MS = 300;
const RING_START_PX = 20;
const RING_EXPAND_PX = 22;

const DAMAGE_COOLDOWN_MS = 80;

const DEATH_ICON_TTL_MS = 1500;

const COLOUR_BLOOD = [220, 40, 40];    // r,g,b
const COLOUR_SPARKS = [255, 210, 40];
const COLOUR_DEATH = [240, 240, 240];
// Muzzle-flash hilite: whole cone is repainted in this hue while a flash is
// active, so shooting reads at a glance regardless of the shooter's team.
const COLOUR_FLASH = [255, 220, 80];

// Active FX state.
// flashes: Map<clientNum, { until, weapon }>
const flashes = new Map();
// bursts: [{ victim, kind, t0 }]  — one per accepted damage event.
const bursts = [];
// particles: [{ victim, kind, t0, dx, dy, vx, vy, r }]  — flat array for efficient GC.
const particles = [];
// deaths: [{ x, y, t0 }] in world coords. One entry per server-side
// STAT_HEALTH →0 transition; rendered as a fading skull glyph.
const deaths = [];
// soundPings: [{ x, y, t0, vol }] in world coords — positional svc_sound
// events rendered as an expanding ring (see doc/sound-events.md).
const soundPings = [];
// Rate-limit bookkeeping: clientNum → { t, kind }.
const lastDamageByVictim = new Map();

const SOUND_PING_TTL_MS = 700;
const SOUND_PING_MAX = 64;
const COLOUR_SOUND = [90, 200, 255]; // cyan — neutral, reads on both teams

function playerOrigin(num) {
    for (const ent of players) {
        if (ent.number === num) return ent.origin;
    }
    return null;
}

function flashDurationMs(weapon) {
    if (weapon == null) return FLASH_DURATION_DEFAULT_MS;
    return FLASH_DURATION_MS_BY_MZ[weapon] ?? FLASH_DURATION_DEFAULT_MS;
}

function handleFlash(ev) {
    if (!ev || typeof ev.shooter !== 'number') return;
    const now = performance.now();
    const dur = flashDurationMs(ev.weapon);
    const existing = flashes.get(ev.shooter);
    // Stack by extending until the longest of the existing and new shot.
    const until = Math.max(existing ? existing.until : 0, now + dur);
    flashes.set(ev.shooter, { until, weapon: ev.weapon });
    scheduleRender(PLAYERS_DIRTY);
}

function handleDamage(ev) {
    if (!ev || typeof ev.victim !== 'number' || (ev.kind !== 'blood' && ev.kind !== 'sparks')) return;
    const now = performance.now();
    // Rate limit: one burst per victim per DAMAGE_COOLDOWN_MS. Blood upgrades
    // an in-window sparks; otherwise keep the existing burst.
    const last = lastDamageByVictim.get(ev.victim);
    if (last && (now - last.t) < DAMAGE_COOLDOWN_MS) {
        if (!(ev.kind === 'blood' && last.kind === 'sparks')) return;
    }
    lastDamageByVictim.set(ev.victim, { t: now, kind: ev.kind });

    bursts.push({ victim: ev.victim, kind: ev.kind, t0: now });

    // Spawn particles. Offsets are in SVG pixel space around the victim's
    // icon; we re-anchor to the victim's live origin each frame.
    for (let i = 0; i < PARTICLE_COUNT; i++) {
        const ang = Math.random() * Math.PI * 2;
        const speed = PARTICLE_MIN_SPEED + Math.random() * (PARTICLE_MAX_SPEED - PARTICLE_MIN_SPEED);
        const r = PARTICLE_MIN_RADIUS + Math.random() * (PARTICLE_MAX_RADIUS - PARTICLE_MIN_RADIUS);
        particles.push({
            victim: ev.victim,
            kind: ev.kind,
            t0: now,
            dx: Math.cos(ang) * 6,  // start just off the icon
            dy: Math.sin(ang) * 6,
            vx: Math.cos(ang) * speed,
            vy: Math.sin(ang) * speed,
            r,
        });
    }
    scheduleRender(PLAYERS_DIRTY);
}

function handleDeath(ev) {
    if (!ev || !Array.isArray(ev.origin)) return;
    deaths.push({ x: ev.origin[0], y: ev.origin[1], t0: performance.now() });
    scheduleRender(PLAYERS_DIRTY);
}

function handleSound(ev) {
    if (!ev || !Array.isArray(ev.position)) return;
    soundPings.push({
        x: ev.position[0],
        y: ev.position[1],
        t0: performance.now(),
        vol: typeof ev.volume === 'number' ? ev.volume : 1,
        derived: !!ev.posDerived,
    });
    if (soundPings.length > SOUND_PING_MAX) soundPings.shift();
    scheduleRender(PLAYERS_DIRTY);
}

function rgba(colour, alpha) {
    return `rgba(${colour[0]}, ${colour[1]}, ${colour[2]}, ${alpha})`;
}

// ─── Dirty-flag render scheduling ────────────────────────────────────────────

const MAP_DIRTY = 1;
const PLAYERS_DIRTY = 2;
let dirty = 0;
let rafScheduled = false;

function scheduleRender(flags) {
    dirty |= flags;
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(renderFrame);
}

function renderFrame() {
    rafScheduled = false;
    applyLockCamera();
    // When locked the camera may have moved: always re-render both layers so
    // the map canvas doesn't lag behind the players canvas.
    const flags = lockedPlayerNum !== null ? dirty | MAP_DIRTY | PLAYERS_DIRTY : dirty;
    dirty = 0;
    if (flags & MAP_DIRTY) renderMap();
    if (flags & PLAYERS_DIRTY) renderPlayers();
    maybeScheduleRaster();
}

// ─── Player camera lock ──────────────────────────────────────────────────────

function cssToSvg(cx, cy) {
    return [(cx - transform.tx) / transform.scale,
    (cy - transform.ty) / transform.scale];
}

function hitTestPlayer(cx, cy) {
    if (!mapBounds) return null;
    const [sx, sy] = cssToSvg(cx, cy);
    const r = 24;   // larger than the drawn radius (16) for easier clicking
    for (const ent of players) {
        if (ent.number < 0 || ent.number >= maxclientsCache) continue;
        const [ex, ey] = worldToSvg(ent.origin[0], ent.origin[1]);
        if ((sx - ex) ** 2 + (sy - ey) ** 2 <= r * r) return ent;
    }
    return null;
}

function setLock(num) {
    lockedPlayerNum = num;
    elScoreboardBody.querySelectorAll('tr.locked').forEach(r => r.classList.remove('locked'));
    if (num !== null) {
        const row = elScoreboardBody.querySelector(`tr[data-num="${num}"]`);
        if (row) row.classList.add('locked');
    }
    updateFollowUi();
    renderScoreboard();
}

/** True when locked onto a player who is currently alive (live or sticky). */
function isFollowTargetAlive() {
    if (lockedPlayerNum === null) return false;
    const live = players.find((p) => p.number === lockedPlayerNum);
    if (live) return !!live.alive;
    const sticky = loadoutCache[lockedPlayerNum];
    return !!(sticky && sticky.alive);
}

/** Hide kill feed + chat while camera-locked (`#panel.follow-mode`). */
function updateFollowUi() {
    if (!elPanel) return;
    elPanel.classList.toggle('follow-mode', lockedPlayerNum !== null);
}

/** Keep the map rectangle inside the CSS viewport (no off-map void). */
function clampTransformToViewport(t) {
    if (!mapBounds) return t;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { svgW, svgH } = mapBounds;
    const mapW = svgW * t.scale;
    const mapH = svgH * t.scale;
    let { tx, ty } = t;
    if (mapW >= vw) tx = Math.min(0, Math.max(vw - mapW, tx));
    else tx = Math.min(vw - mapW, Math.max(0, tx));
    if (mapH >= vh) ty = Math.min(0, Math.max(vh - mapH, ty));
    else ty = Math.min(vh - mapH, Math.max(0, ty));
    return { ...t, tx, ty };
}

function applyLockCamera() {
    if (lockedPlayerNum === null || !mapBounds) return;
    const ent = players.find(p => p.number === lockedPlayerNum);
    if (!ent) return;
    const [sx, sy] = worldToSvg(ent.origin[0], ent.origin[1]);
    transform = clampTransformToViewport({
        ...transform,
        tx: window.innerWidth / 2 - sx * transform.scale,
        ty: window.innerHeight / 2 - sy * transform.scale,
    });
}

// ─── Canvas sizing ───────────────────────────────────────────────────────────

function resizeCanvas() {
    dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const c of [mapCanvas, playersCanvas]) {
        c.width = Math.max(1, Math.round(w * dpr));
        c.height = Math.max(1, Math.round(h * dpr));
        c.style.width = w + 'px';
        c.style.height = h + 'px';
    }
    if (mapBounds) fitToScreen();
    scheduleRender(MAP_DIRTY | PLAYERS_DIRTY);
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// React to devicePixelRatio changes (zoom, moving between monitors).
function watchDpr() {
    const mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onChange = () => {
        resizeCanvas();
        // Effective scale changed → may need re-raster.
        maybeScheduleRaster();
        watchDpr();
    };
    if (mql.addEventListener) mql.addEventListener('change', onChange, { once: true });
    else if (mql.addListener) mql.addListener(onChange);
}
watchDpr();

// ─── Fit to screen ──────────────────────────────────────────────────────────

function fitToScreen() {
    if (!mapBounds) return;
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    const { svgW, svgH } = mapBounds;
    const scale = Math.min(cssW / svgW, cssH / svgH) * 0.95;
    const tx = (cssW - svgW * scale) / 2;
    const ty = (cssH - svgH * scale) / 2;
    transform = { tx, ty, scale };
}

// ─── Coordinate conversion ───────────────────────────────────────────────────

function worldToSvg(wx, wy) {
    const { minsX, maxsY, margin, labelHeight } = mapBounds;
    return [
        margin + (wx - minsX),
        labelHeight + margin + (maxsY - wy),
    ];
}

// ─── Shared transform ───────────────────────────────────────────────────────

function applyWorldTransform(ctx) {
    const { tx, ty, scale } = transform;
    // Combine DPR with pan/zoom in one setTransform: device_px = (css_px) * dpr,
    // where css_px = world * scale + (tx, ty).
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * tx, dpr * ty);
}

// ─── Map layer render ────────────────────────────────────────────────────────

function renderMap() {
    mapCtx.setTransform(1, 0, 0, 1, 0, 0);
    mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
    if (!mapBitmap || !mapBounds) return;
    applyWorldTransform(mapCtx);
    mapCtx.drawImage(mapBitmap, 0, 0, mapBounds.svgW, mapBounds.svgH);
}

// ─── Players layer render ────────────────────────────────────────────────────

function renderPlayers() {
    playersCtx.setTransform(1, 0, 0, 1, 0, 0);
    playersCtx.clearRect(0, 0, playersCanvas.width, playersCanvas.height);
    if (!mapBounds) return;
    applyWorldTransform(playersCtx);

    const ctx = playersCtx;
    const now = performance.now();

    // ── Damage ring pulse (under player icons) ──────────────────────────
    let aliveBursts = 0;
    for (let i = 0; i < bursts.length; i++) {
        const b = bursts[i];
        const age = now - b.t0;
        if (age >= RING_TTL_MS) continue;
        if (aliveBursts !== i) bursts[aliveBursts] = b;
        aliveBursts++;
        // Re-anchor to the victim's current origin each frame.
        const origin = playerOrigin(b.victim);
        if (!origin) continue;
        const [cx, cy] = worldToSvg(origin[0], origin[1]);
        const t = age / RING_TTL_MS;         // 0..1
        const alpha = 1 - t;
        const radius = RING_START_PX + t * RING_EXPAND_PX;
        const col = b.kind === 'blood' ? COLOUR_BLOOD : COLOUR_SPARKS;
        // Outer bold ring — the "border" the user wants widened.
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(col, alpha * 0.95);
        ctx.lineWidth = 4 / transform.scale;
        ctx.stroke();
        // Soft inner halo for a fatter read without obscuring the icon.
        if (radius > 6) {
            ctx.beginPath();
            ctx.arc(cx, cy, radius - 4, 0, Math.PI * 2);
            ctx.strokeStyle = rgba(col, alpha * 0.35);
            ctx.lineWidth = 2 / transform.scale;
            ctx.stroke();
        }
    }
    bursts.length = aliveBursts;

    // ── Damage particles (above rings, under icons) ─────────────────────
    let aliveParticles = 0;
    for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const age = now - p.t0;
        if (age >= PARTICLE_TTL_MS) continue;
        if (aliveParticles !== i) particles[aliveParticles] = p;
        aliveParticles++;
        const origin = playerOrigin(p.victim);
        if (!origin) continue;
        const [cx, cy] = worldToSvg(origin[0], origin[1]);
        const tSec = age / 1000;
        const x = cx + p.dx + p.vx * tSec;
        const y = cy + p.dy + p.vy * tSec;
        const alpha = 1 - age / PARTICLE_TTL_MS;
        const col = p.kind === 'blood' ? COLOUR_BLOOD : COLOUR_SPARKS;
        ctx.beginPath();
        ctx.arc(x, y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = rgba(col, alpha);
        ctx.fill();
    }
    particles.length = aliveParticles;

    // ── Sound pings — expanding ring at the packet's world position ─────
    let alivePings = 0;
    for (let i = 0; i < soundPings.length; i++) {
        const p = soundPings[i];
        const age = now - p.t0;
        if (age >= SOUND_PING_TTL_MS) continue;
        if (alivePings !== i) soundPings[alivePings] = p;
        alivePings++;
        const [cx, cy] = worldToSvg(p.x, p.y);
        const t = age / SOUND_PING_TTL_MS;
        // Entity-attached sounds (footsteps, pain) ping at the emitting
        // player's position — render a smaller, dimmer pulse so they read as
        // "noise" rather than a positional impact.
        const alpha = (1 - t) * (p.derived ? 0.55 : 1);
        const radius = (8 + t * (p.derived ? 18 : 32)) * (0.7 + p.vol * 0.6);
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(COLOUR_SOUND, alpha * 0.85);
        ctx.lineWidth = 2.5 / transform.scale;
        ctx.stroke();
    }
    soundPings.length = alivePings;

    ctx.globalAlpha = 1;

    const r = 16;
    const fontSize = Math.max(8, r * 1.4);
    const nameFontSize = Math.max(10, r * 1.6);
    const playerFont = `bold ${fontSize}px monospace`;
    const nameFont = `bold ${nameFontSize}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = playerFont;

    const maxclients = maxclientsCache;
    const teamMap = getTeamMap();

    for (const ent of players) {
        if (ent.number < 0 || ent.number >= maxclients) continue;
        const [sx, sy] = worldToSvg(ent.origin[0], ent.origin[1]);
        const teamIdx = teamMap[ent.number];
        const col = (teamIdx !== undefined && teamIdx < TEAM_COLOURS.length) ? TEAM_COLOURS[teamIdx] : DEFAULT_COLOUR;

        if (ent.number === lockedPlayerNum) {
            ctx.beginPath();
            ctx.arc(sx, sy, r + 6, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
            ctx.lineWidth = 2 / transform.scale;
            ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fillStyle = col.fill;
        ctx.fill();
        ctx.strokeStyle = col.stroke;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        const info = getPlayerInfo(ent.number);
        if (info.name) {
            ctx.font = nameFont;
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 3;
            ctx.strokeText(info.name, sx, sy - r - 10);
            ctx.fillText(info.name, sx, sy - r - 10);
            ctx.font = playerFont;
        }

        // ── Health bar above the name ───────────────────────────────────
        if (typeof ent.health === 'number') {
            const hp = Math.max(0, Math.min(100, ent.health));
            const barW = r * 2.2;
            const barH = Math.max(3, 4 / transform.scale);
            const barX = sx - barW / 2;
            const barY = sy - r - 10 - nameFontSize - 2;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
            ctx.fillRect(barX, barY, barW, barH);
            const fillW = barW * (hp / 100);
            let hpColour;
            if (hp >= 66) hpColour = 'rgba(40, 200, 70, 0.95)';
            else if (hp >= 33) hpColour = 'rgba(230, 200, 50, 0.95)';
            else hpColour = 'rgba(220, 50, 50, 0.95)';
            ctx.fillStyle = hpColour;
            ctx.fillRect(barX, barY, fillW, barH);
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
            ctx.lineWidth = 1;
            ctx.strokeRect(barX, barY, barW, barH);
        }

        const yaw = ent.viewangles[1];
        const ca = -yaw * (Math.PI / 180);
        const coneLen = r * 4;
        const coneHalf = 0.35;
        const tipX = sx + Math.cos(ca) * coneLen;
        const tipY = sy + Math.sin(ca) * coneLen;
        const leftX = sx + Math.cos(ca - coneHalf) * coneLen;
        const leftY = sy + Math.sin(ca - coneHalf) * coneLen;
        const rightX = sx + Math.cos(ca + coneHalf) * coneLen;
        const rightY = sy + Math.sin(ca + coneHalf) * coneLen;

        // Flash boost: while a recent muzzleflash is active, repaint the whole
        // cone in muzzle-flash yellow so shooting reads at a glance regardless
        // of the shooter's team palette.
        const flash = flashes.get(ent.number);
        let coneFill = col.cone;
        let coneStroke = col.coneStroke;
        let coneLineWidth = 1.5;
        if (flash && flash.until > now) {
            // 0 at end-of-flash, 1 at peak (now).
            // We don't know the exact start, so approximate from remaining time.
            const remaining = flash.until - now;
            const dur = flashDurationMs(flash.weapon);
            const intensity = Math.min(1, remaining / dur);
            coneFill = rgba(COLOUR_FLASH, 0.35 + intensity * 0.55);
            coneStroke = rgba(COLOUR_FLASH, 0.85 + intensity * 0.15);
            coneLineWidth = 2.0 + intensity * 2.5;
        }

        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(leftX, leftY);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo(rightX, rightY);
        ctx.closePath();
        ctx.fillStyle = coneFill;
        ctx.fill();
        ctx.strokeStyle = coneStroke;
        ctx.lineWidth = coneLineWidth;
        ctx.stroke();
    }

    // ── Death icons (skull glyph painted last, on top of player icons) ──
    let aliveDeaths = 0;
    for (let i = 0; i < deaths.length; i++) {
        const d = deaths[i];
        const age = now - d.t0;
        if (age >= DEATH_ICON_TTL_MS) continue;
        if (aliveDeaths !== i) deaths[aliveDeaths] = d;
        aliveDeaths++;
        const t = age / DEATH_ICON_TTL_MS;
        const alpha = 1 - t;
        // Slight grow-then-settle: 1.0 → 1.25 over the lifetime.
        const size = 28 * (1 + t * 0.25);
        const [cx, cy] = worldToSvg(d.x, d.y);
        ctx.save();
        ctx.font = `bold ${size}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3 / transform.scale;
        ctx.strokeStyle = `rgba(0, 0, 0, ${alpha})`;
        ctx.fillStyle = rgba(COLOUR_DEATH, alpha);
        const glyph = '\u2620'; // ☠ SKULL AND CROSSBONES
        ctx.strokeText(glyph, cx, cy);
        ctx.fillText(glyph, cx, cy);
        ctx.restore();
    }
    deaths.length = aliveDeaths;

    // Evict flashes that have fully expired so we don't keep the render loop
    // alive indefinitely.
    for (const [num, f] of flashes) {
        if (f.until <= now) flashes.delete(num);
    }

    // Keep the render loop ticking while any FX is still alive.
    if (flashes.size > 0 || bursts.length > 0 || particles.length > 0 || deaths.length > 0) {
        scheduleRender(PLAYERS_DIRTY);
    }
}

// ─── Caches ──────────────────────────────────────────────────────────────────

function parsePlayerInfo(playerNumber) {
    const cs = configstrings[csB().playerskins + playerNumber] || '';
    const sep = cs.indexOf('\\');
    if (sep === -1) return { name: '', skin: cs };
    return { name: cs.substring(0, sep), skin: cs.substring(sep + 1) };
}

function getPlayerInfo(n) {
    if (n in playerInfoCache) return playerInfoCache[n];
    const info = parsePlayerInfo(n);
    playerInfoCache[n] = info;
    return info;
}

const CTF_SKIN_INDEX = { ctf_r: 0, ctf_b: 1, ctf_g: 2 };

function ctfIndexForSkin(skin) {
    const slash = skin.lastIndexOf('/');
    const suffix = (slash === -1 ? skin : skin.substring(slash + 1)).toLowerCase();
    return CTF_SKIN_INDEX[suffix];
}

function getTeamMap() {
    if (teamMapCache) return teamMapCache;
    const skinToTeam = {};
    const teamMap = {};
    const used = new Set();

    // First pass: assign fixed indices for CTF skins.
    for (const ent of players) {
        const info = getPlayerInfo(ent.number);
        if (!info.skin || info.skin in skinToTeam) continue;
        const ctfIdx = ctfIndexForSkin(info.skin);
        if (ctfIdx !== undefined) {
            skinToTeam[info.skin] = ctfIdx;
            used.add(ctfIdx);
        }
    }

    // Second pass: assign remaining skins to the next available colour index.
    let nextTeam = 0;
    for (const ent of players) {
        const info = getPlayerInfo(ent.number);
        if (!info.skin || info.skin in skinToTeam) continue;
        while (used.has(nextTeam)) nextTeam++;
        skinToTeam[info.skin] = nextTeam;
        used.add(nextTeam);
        nextTeam++;
    }

    for (const ent of players) {
        const info = getPlayerInfo(ent.number);
        if (!info.skin) continue;
        teamMap[ent.number] = skinToTeam[info.skin];
    }
    teamMapCache = teamMap;
    return teamMap;
}

function recomputeMaxclients() {
    maxclientsCache = statusMaxclients ||
        parseInt(configstrings[csB().maxclients] || '0', 10) ||
        0;
}

function invalidateConfigCaches() {
    teamMapCache = null;
    playerInfoCache = {};
    recomputeMaxclients();
}

function updatePlayerCount() {
    // Strict §2 stream roster length (dummy already filtered server-side).
    // Do not count sticky-only / configstring-only rows.
    elEntities.textContent = `${players.length} player(s)`;
}

function cacheLoadoutFromPlayer(p) {
    const prev = loadoutCache[p.number];
    // Keep last known weapon while alive when VWEP/gunindex resolve fails
    // (e.g. scoped sniper zeroes gunindex). Clear on death.
    let weapon = p.weapon;
    if (p.alive) {
        if (!weapon && prev && prev.alive && prev.weapon) weapon = prev.weapon;
    } else {
        weapon = undefined;
    }
    loadoutCache[p.number] = {
        health: p.health,
        weapon,
        item: p.item,
        ammo: p.ammo,
        clips: p.clips,
        grenades: p.grenades,
        alive: !!p.alive,
        scoped: !!p.scoped,
    };
}

function formatAmmo(lo) {
    if (!lo || !lo.alive) return '-';
    if (typeof lo.ammo !== 'number') return '-';
    const spare = typeof lo.clips === 'number' ? lo.clips : 0;
    return `${lo.ammo}/${spare}`;
}

function extractMapname() {
    const re = /^maps\/(.+)\.bsp$/;
    const m = (configstrings[csB().models + 1] || '').match(re);
    return m ? m[1] : '';
}

function checkMapChange() {
    const mapname = extractMapname();
    if (mapname && mapname !== currentMapname) {
        currentMapname = mapname;
        loadMap(currentMapname);
    }
}

// ─── SVG → bitmap rasterization (zoom-aware, debounced) ─────────────────────

const RASTER_UPSCALE_TRIGGER = 1.5;           // re-raster when effScale > rasterScale * 1.5
const RASTER_HEADROOM = 1.25;                 // raster slightly above current effScale
const RASTER_MAX_AREA = 16 * 1024 * 1024;     // 16M px cap
const RASTER_DEBOUNCE_MS = 140;

let rasterInFlight = false;
let rasterTimer = 0;
let pendingRasterScale = 0;

function effectiveScale() {
    return transform.scale * dpr;
}

function clampRasterScale(s) {
    if (!mapBounds) return s;
    const { svgW, svgH } = mapBounds;
    const maxScale = Math.sqrt(RASTER_MAX_AREA / Math.max(1, svgW * svgH));
    return Math.min(s, maxScale);
}

function maybeScheduleRaster() {
    if (!mapSvgBlobUrl || !mapBounds) return;
    const eff = effectiveScale();
    if (eff <= mapBitmapScale * RASTER_UPSCALE_TRIGGER) return;
    const target = clampRasterScale(eff * RASTER_HEADROOM);
    if (target <= mapBitmapScale * 1.01) return; // already at cap
    pendingRasterScale = target;
    if (rasterTimer) clearTimeout(rasterTimer);
    rasterTimer = setTimeout(runRaster, RASTER_DEBOUNCE_MS);
}

async function runRaster() {
    rasterTimer = 0;
    if (rasterInFlight) return;
    if (!mapSvgBlobUrl || !mapBounds) return;
    const scale = pendingRasterScale;
    if (scale <= mapBitmapScale * 1.01) return;

    rasterInFlight = true;
    const blobUrl = mapSvgBlobUrl;
    const bounds = mapBounds;
    try {
        const bmp = await rasterizeSvg(blobUrl, bounds, scale);
        // Guard: map may have changed during raster
        if (bmp && mapSvgBlobUrl === blobUrl && mapBounds === bounds) {
            if (mapBitmap && typeof mapBitmap.close === 'function') mapBitmap.close();
            mapBitmap = bmp;
            mapBitmapScale = scale;
            scheduleRender(MAP_DIRTY);
        } else if (bmp && typeof bmp.close === 'function') {
            bmp.close();
        }
    } catch (err) {
        console.error('[RASTER] failed:', err);
    } finally {
        rasterInFlight = false;
        maybeScheduleRaster();
    }
}

function rasterizeSvg(blobUrl, bounds, scale) {
    const w = Math.max(1, Math.round(bounds.svgW * scale));
    const h = Math.max(1, Math.round(bounds.svgH * scale));
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = async () => {
            try {
                if (typeof createImageBitmap === 'function') {
                    try {
                        const bmp = await createImageBitmap(img, {
                            resizeWidth: w,
                            resizeHeight: h,
                            resizeQuality: 'high',
                        });
                        resolve(bmp);
                        return;
                    } catch (_) { /* fall through to canvas path */ }
                }
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const cctx = canvas.getContext('2d');
                cctx.drawImage(img, 0, 0, w, h);
                resolve(canvas);
            } catch (e) { reject(e); }
        };
        img.onerror = () => reject(new Error('SVG image load failed'));
        img.src = blobUrl;
    });
}

// ─── Map loading ─────────────────────────────────────────────────────────────

async function loadMap(levelname) {
    elMap.textContent = `${levelname} (loading...)`;
    try {
        const mapQuery = texturesEnabled ? '' : '?notextures';
        const res = await fetch(MAP_URL + encodeURIComponent(levelname) + mapQuery);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const svgText = await res.text();

        const parser = new DOMParser();
        const doc = parser.parseFromString(svgText, 'image/svg+xml');
        const svgEl = doc.documentElement;

        const minsX = parseFloat(svgEl.getAttribute('data-mins-x') ?? '0');
        const minsY = parseFloat(svgEl.getAttribute('data-mins-y') ?? '0');
        const maxsX = parseFloat(svgEl.getAttribute('data-maxs-x') ?? '0');
        const maxsY = parseFloat(svgEl.getAttribute('data-maxs-y') ?? '0');
        const margin = parseFloat(svgEl.getAttribute('data-margin') ?? '80');
        const labelHeight = parseFloat(svgEl.getAttribute('data-label-height') ?? '40');
        const svgW = parseFloat(svgEl.getAttribute('width') ?? '0');
        const svgH = parseFloat(svgEl.getAttribute('height') ?? '0');

        mapBounds = { minsX, minsY, maxsX, maxsY, margin, labelHeight, svgW, svgH };

        // Release previous bitmap + blob
        if (mapBitmap && typeof mapBitmap.close === 'function') mapBitmap.close();
        mapBitmap = null;
        mapBitmapScale = 0;
        if (mapSvgBlobUrl) URL.revokeObjectURL(mapSvgBlobUrl);

        const blob = new Blob([svgText], { type: 'image/svg+xml' });
        mapSvgBlobUrl = URL.createObjectURL(blob);

        fitToScreen();

        // Initial raster at current effective scale (with headroom), capped.
        pendingRasterScale = clampRasterScale(Math.max(effectiveScale(), 1) * RASTER_HEADROOM);
        await runRaster();

        elMap.textContent = levelname;
        scheduleRender(MAP_DIRTY | PLAYERS_DIRTY);
    } catch (err) {
        console.error('[MAP] Failed to load:', err);
        elMap.textContent = `${levelname} (error)`;
    }
}

// ─── Scoreboard / killfeed / chat state ─────────────────────────────────────

let scoreboardState = { teamScores: { team1: 0, team2: 0, team3: 0 }, layoutsFlags: 0, layoutText: '', players: {} };

const KILL_FEED_VISIBLE = 30;
const CHAT_VISIBLE = 60;

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function renderTeamScores() {
    const t = scoreboardState.teamScores || { team1: 0, team2: 0, team3: 0 };
    const has3 = t.team3 !== 0;
    // Show team scores only if any is non-zero.
    if (!t.team1 && !t.team2 && !t.team3) {
        elTeamScores.innerHTML = '';
        return;
    }
    let html = `<span class="team team1">T1: ${t.team1}</span><span class="team team2">T2: ${t.team2}</span>`;
    if (has3) html += `<span class="team team3">T3: ${t.team3}</span>`;
    elTeamScores.innerHTML = html;
}

/** Match-stats panel fed by the 'stats' SSE snapshot (see doc/session-stats.md). */
const elRoundScores = document.querySelector('#round-scores');

function renderStats(snap) {
    if (!elStatsBody || !snap || !snap.totals) return;
    if (elRoundScores) {
        const chips = (snap.rounds || [])
            .filter((r) => r.teamScores)
            .map((r) => {
                const s = r.teamScores;
                const parts = [`T1 ${s.team1}`, `T2 ${s.team2}`];
                if (s.team3) parts.push(`T3 ${s.team3}`);
                const cls = r.winner ? `round-score ${r.winner}` : 'round-score';
                return `<span class="${cls}">R${r.index}: ${parts.join('–')}</span>`;
            });
        elRoundScores.innerHTML = chips.join(' ');
    }
    const rows = Object.entries(snap.totals.players || {})
        .map(([name, p]) => ({ name, ...p }))
        .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name));
    elStatsBody.innerHTML = rows.map((p) => {
        const locs = Object.entries(p.hitsByLocation || {})
            .sort((a, b) => b[1] - a[1])
            .map(([loc, n]) => `${loc}:${n}`)
            .join(' ');
        return `<tr><td>${escapeHtml(p.name)}</td>`
            + `<td class="num">${p.kills}</td>`
            + `<td class="num">${p.deaths}</td>`
            + `<td class="num">${p.hits}</td>`
            + `<td class="num">${p.damageDealt ?? 0}</td>`
            + `<td>${escapeHtml(locs)}</td></tr>`;
    }).join('');
}

function renderScoreboard() {
    renderTeamScores();

    const liveByNum = {};
    for (const p of players) {
        liveByNum[p.number] = p;
        cacheLoadoutFromPlayer(p);
    }

    const rows = [];
    const seen = new Set();
    for (const [numStr, sbp] of Object.entries(scoreboardState.players || {})) {
        const num = +numStr;
        if (num === dummyNum) continue;
        seen.add(num);
        const info = getPlayerInfo(num);
        if (!info.name) continue;
        rows.push({ number: num, name: info.name, frags: sbp.frags || 0 });
    }
    // Also include anyone present via status/configstrings but not yet in a stats delta.
    if (maxclientsCache > 0) {
        for (let i = 0; i < maxclientsCache; i++) {
            if (i === dummyNum || seen.has(i)) continue;
            const info = getPlayerInfo(i);
            if (!info.name) continue;
            rows.push({ number: i, name: info.name, frags: 0 });
        }
    }

    rows.sort((a, b) => b.frags - a.frags || a.name.localeCompare(b.name));

    // Follow mode: while the locked player is alive, show only their row.
    // On death (or unknown alive), restore the full scoreboard.
    let displayRows = rows;
    if (lockedPlayerNum !== null && isFollowTargetAlive()) {
        displayRows = rows.filter((r) => r.number === lockedPlayerNum);
        if (displayRows.length === 0) {
            const info = getPlayerInfo(lockedPlayerNum);
            const sbp = (scoreboardState.players || {})[lockedPlayerNum];
            displayRows = [{
                number: lockedPlayerNum,
                name: info.name || `#${lockedPlayerNum}`,
                frags: (sbp && sbp.frags) || 0,
            }];
        }
    }

    // Apply team colouring only when there are >= 2 distinct teams. Pure FFA
    // (every player on a unique team index) renders as plain white.
    const teamMap = getTeamMap();
    const distinctTeams = new Set(Object.values(teamMap));
    const colourByTeam = distinctTeams.size >= 2 && distinctTeams.size < Object.keys(teamMap).length;

    elScoreboardBody.innerHTML = displayRows.map((r) => {
        const teamIdx = teamMap[r.number];
        const teamCls = colourByTeam && teamIdx !== undefined && teamIdx < TEAM_COLOURS.length
            ? ` team-${teamIdx}` : '';
        const nameHtml = `<span class="player-name${teamCls}">${escapeHtml(r.name)}</span>`;
        const lockedCls = r.number === lockedPlayerNum ? ' locked' : '';

        const live = liveByNum[r.number];
        const sticky = loadoutCache[r.number];
        let rowCls = lockedCls ? 'locked' : '';
        let hp = '-';
        let wpnLabel = '';
        let itemLabel = '';
        let ammo = '-';

        if (live) {
            if (live.alive) {
                rowCls = (rowCls ? rowCls + ' ' : '') + 'in-stream';
                hp = typeof live.health === 'number' ? String(live.health) : '-';
                wpnLabel = live.weapon || (sticky && sticky.weapon) || '';
                itemLabel = live.item || '';
                ammo = formatAmmo(live);
            } else {
                rowCls = (rowCls ? rowCls + ' ' : '') + 'dead';
            }
        } else if (sticky) {
            rowCls = (rowCls ? rowCls + ' ' : '') + 'away';
            if (sticky.alive) {
                hp = typeof sticky.health === 'number' ? String(sticky.health) : '-';
                wpnLabel = sticky.weapon || '';
                itemLabel = sticky.item || '';
                ammo = formatAmmo(sticky);
            }
        }

        const wpn = loadoutIconHtml(wpnLabel, WEAPON_ICON);
        const item = loadoutIconHtml(itemLabel, ITEM_ICON);

        const clsAttr = rowCls ? ` class="${rowCls}"` : '';
        const nameCell = `<td class="name-cell"><span class="loadout-icons">${wpn}${item}</span>${nameHtml}</td>`;
        return `<tr data-num="${r.number}"${clsAttr}>${nameCell}<td class="num">${hp}</td><td class="num">${ammo}</td><td class="num">${r.frags}</td></tr>`;
    }).join('');

    updateFollowUi();
}

function formatGametime(frameNumber) {
    if (typeof frameNumber !== 'number' || frameNumber < 0) return '';
    const totalSec = Math.floor(frameNumber / 10); // Q2 server runs at 10 Hz.
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function updateGametime(frameNumber) {
    elTime.textContent = formatGametime(frameNumber);
}

elScoreboardBody.addEventListener('mousedown', (e) => {
    const row = /** @type {HTMLElement} */ (e.target).closest('tr[data-num]');
    if (!row) return;
    const num = parseInt(/** @type {HTMLElement} */ (row).dataset.num || '', 10);
    setLock(lockedPlayerNum === num ? null : num);
    scheduleRender(MAP_DIRTY | PLAYERS_DIRTY);
});

function flashScoreboardRow(num, cls) {
    const row = /** @type {HTMLElement | null} */ (elScoreboardBody.querySelector(`tr[data-num="${num}"]`));
    if (!row) return;
    row.classList.remove(cls);
    // Force reflow to restart the animation.
    void row.offsetWidth;
    row.classList.add(cls);
    setTimeout(() => row.classList.remove(cls), 600);
}

function appendKillfeed(ev) {
    const li = document.createElement('li');
    if (ev.kind === 'info') li.classList.add('info');
    if (ev.attacker) {
        const wep = ev.weapon ? ` <span class="weapon">[${escapeHtml(ev.weapon)}]</span>` : '';
        li.innerHTML = `<span class="attacker">${escapeHtml(ev.attacker)}</span> \u2192 <span class="victim">${escapeHtml(ev.victim)}</span>${wep}`;
    } else if (ev.victim) {
        li.innerHTML = `<span class="victim">${escapeHtml(ev.victim)}</span> <span class="world">${escapeHtml(ev.weapon || 'died')}</span>`;
    } else {
        // Raw-only fallback for unknown obituary templates (AQ2/Action mods).
        li.innerHTML = `<span class="world">${escapeHtml(ev.raw || '')}</span>`;
    }
    elKillfeed.appendChild(li);
    while (elKillfeed.children.length > KILL_FEED_VISIBLE) {
        elKillfeed.removeChild(elKillfeed.firstChild);
    }
    elKillfeed.scrollTop = elKillfeed.scrollHeight;
}

function appendChat(ev) {
    const li = document.createElement('li');
    if (ev.name) {
        li.innerHTML = `<span class="name">${escapeHtml(ev.name)}</span>${escapeHtml(ev.text)}`;
    } else {
        li.innerHTML = `<span class="sys">${escapeHtml(ev.raw || ev.text)}</span>`;
    }
    elChat.appendChild(li);
    while (elChat.children.length > CHAT_VISIBLE) {
        elChat.removeChild(elChat.firstChild);
    }
    elChat.scrollTop = elChat.scrollHeight;
}

// ─── SSE connection ──────────────────────────────────────────────────────────

function connectSSE() {
    const es = new EventSource(SSE_URL);

    es.addEventListener('open', () => {
        // SSE is always-on; session state is shown separately.
        refreshSessionState();
    });

    es.addEventListener('replayStart', () => {
        replayState = { paused: false, speed: 1, position: 0, messageCount: 0 };
        refreshSessionState();
        updateReplayBar();
    });

    es.addEventListener('replayState', (e) => {
        replayState = JSON.parse(e.data);
        updateReplayBar();
    });

    es.addEventListener('replayEnd', () => {
        refreshSessionState({ reopen: true });
    });

    es.addEventListener('liveStop', () => {
        refreshSessionState({ reopen: true });
    });

    es.addEventListener('replayError', (e) => {
        try {
            const ev = JSON.parse(e.data);
            showSessionError(`Replay error: ${ev.message || 'unknown'}`);
        } catch { }
        refreshSessionState({ reopen: true });
    });

    es.addEventListener('snapshot', (e) => {
        const data = JSON.parse(e.data);
        csExtended = !!data.extended;
        dummyNum = typeof data.clientNum === 'number' ? data.clientNum : -1;
        configstrings = data.configstrings || {};
        players = data.players || [];
        loadoutCache = {};
        for (const p of players) cacheLoadoutFromPlayer(p);
        if (data.status) {
            serverStatus = data.status;
            if (serverStatus.serverinfo && serverStatus.serverinfo.maxclients) {
                statusMaxclients = parseInt(serverStatus.serverinfo.maxclients, 10) || 0;
            }
        }
        if (data.scoreboard) scoreboardState = data.scoreboard;
        if (data.replay) {
            replayState = data.replay;
            updateReplayBar();
        }
        if (data.stats) renderStats(data.stats);
        invalidateConfigCaches();
        updatePlayerCount();
        checkMapChange();
        // Rehydrate killfeed + chat from snapshot.
        elKillfeed.innerHTML = '';
        for (const k of (data.killFeed || [])) appendKillfeed(k);
        elChat.innerHTML = '';
        for (const c of (data.chatLog || [])) appendChat(c);
        renderScoreboard();
        scheduleRender(PLAYERS_DIRTY);
    });

    es.addEventListener('serverdata', (e) => {
        const data = JSON.parse(e.data);
        csExtended = !!data.extended;
        dummyNum = typeof data.clientNum === 'number' ? data.clientNum : -1;
        configstrings = data.configstrings || {};
        invalidateConfigCaches();
        checkMapChange();
        // Map/gamestate changed: clear transient feeds.
        elKillfeed.innerHTML = '';
        elChat.innerHTML = '';
        scoreboardState = { teamScores: { team1: 0, team2: 0, team3: 0 }, layoutsFlags: 0, layoutText: '', players: {} };
        loadoutCache = {};
        players = [];
        updatePlayerCount();
        // Map change: reset elapsed gametime; the next frame event will start it.
        updateGametime(0);
        renderScoreboard();
        scheduleRender(PLAYERS_DIRTY);
    });

    es.addEventListener('configstring', (e) => {
        const { index, value } = JSON.parse(e.data);
        configstrings[index] = value;
        invalidateConfigCaches();
        checkMapChange();
        // A cleared playerskin configstring signals client disconnect; drop
        // their scoreboard row so leavers don't linger with stale frags.
        if (value === '') {
            const base = csB().playerskins;
            const cap = maxclientsCache > 0 && maxclientsCache <= 256 ? maxclientsCache : 256;
            if (index >= base && index < base + cap) {
                const num = index - base;
                delete scoreboardState.players[num];
                delete loadoutCache[num];
            }
        }
        renderScoreboard();
        scheduleRender(PLAYERS_DIRTY);
    });

    es.addEventListener('frame', (e) => {
        const data = JSON.parse(e.data);
        players = data.players || [];
        teamMapCache = null; // player set may have changed
        updatePlayerCount();
        if (typeof data.frameNumber === 'number') updateGametime(data.frameNumber);

        // One MVD message ≈ one server frame, so the scrubber can advance
        // locally between sparse replayState updates.
        if (currentMode === 'replay' && replayState && !replayState.paused
            && replayState.position < replayState.messageCount) {
            replayState.position++;
            updateReplayBar();
        }

        // Update scoreboard from frame-level stats. Merge so that a player
        // who briefly drops out of `data.players` (PPS_REMOVE on death /
        // respawn) keeps their accumulated frag count. Entries are cleared
        // on serverdata (map change) and on the configstring listener below
        // when their playerskin slot is emptied.
        if (data.teamScores) scoreboardState.teamScores = data.teamScores;
        if (typeof data.layoutsFlags === 'number') scoreboardState.layoutsFlags = data.layoutsFlags;
        for (const p of data.players || []) {
            scoreboardState.players[p.number] = { number: p.number, frags: p.frags || 0 };
        }
        renderScoreboard();

        scheduleRender(PLAYERS_DIRTY);
    });

    es.addEventListener('status', (e) => {
        serverStatus = JSON.parse(e.data);
        if (serverStatus.serverinfo && serverStatus.serverinfo.maxclients) {
            statusMaxclients = parseInt(serverStatus.serverinfo.maxclients, 10) || 0;
            recomputeMaxclients();
        }
        renderScoreboard();
    });

    es.addEventListener('chat', (e) => {
        appendChat(JSON.parse(e.data));
    });

    es.addEventListener('kill', (e) => {
        const entry = JSON.parse(e.data);
        appendKillfeed(entry);
    });

    es.addEventListener('death', (e) => {
        handleDeath(JSON.parse(e.data));
    });

    es.addEventListener('hit', (e) => {
        const ev = JSON.parse(e.data);
        if (ev.kind === 'dealt' && typeof ev.attacker === 'number') {
            flashScoreboardRow(ev.attacker, 'hit-dealt');
        } else if (ev.kind === 'taken' && typeof ev.victim === 'number') {
            flashScoreboardRow(ev.victim, 'hit-taken');
        }
    });

    es.addEventListener('layout', (e) => {
        const ev = JSON.parse(e.data);
        scoreboardState.layoutText = ev.text;
    });

    es.addEventListener('flash', (e) => {
        handleFlash(JSON.parse(e.data));
    });

    es.addEventListener('damage', (e) => {
        handleDamage(JSON.parse(e.data));
    });

    es.addEventListener('sound', (e) => {
        handleSound(JSON.parse(e.data));
    });

    es.addEventListener('stats', (e) => {
        renderStats(JSON.parse(e.data));
    });

    es.addEventListener('error', () => {
        // SSE transport error; state UI is driven by /state polling.
    });
}

connectSSE();

// ─── Zoom / Pan ──────────────────────────────────────────────────────────────

const MIN_SCALE = 0.05;
const MAX_SCALE = 10;

playersCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const rect = playersCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, transform.scale * factor));
    const ratio = newScale / transform.scale;
    transform = {
        tx: mx - (mx - transform.tx) * ratio,
        ty: my - (my - transform.ty) * ratio,
        scale: newScale,
    };
    scheduleRender(MAP_DIRTY | PLAYERS_DIRTY);
}, { passive: false });

let drag = null;
let dragStart = null;   // { x, y } CSS px recorded on mousedown for travel detection

playersCanvas.addEventListener('mousedown', (e) => {
    drag = { x: e.clientX - transform.tx, y: e.clientY - transform.ty };
    dragStart = { x: e.clientX, y: e.clientY };
    playersCanvas.classList.add('dragging');
});

window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    if (lockedPlayerNum !== null && dragStart) {
        const dx = e.clientX - dragStart.x;
        const dy = e.clientY - dragStart.y;
        if (dx * dx + dy * dy > 16) {   // 4 px travel threshold
            setLock(null);
        }
    }
    transform = { ...transform, tx: e.clientX - drag.x, ty: e.clientY - drag.y };
    scheduleRender(MAP_DIRTY | PLAYERS_DIRTY);
});

window.addEventListener('mouseup', (e) => {
    if (!dragStart) {
        // mousedown didn't come from the canvas; ignore for lock purposes
        drag = null;
        return;
    }
    const wasDrag = (e.clientX - dragStart.x) ** 2 + (e.clientY - dragStart.y) ** 2 > 16;
    if (!wasDrag) {
        const hit = hitTestPlayer(e.clientX, e.clientY);
        setLock(hit ? hit.number : null);
        scheduleRender(PLAYERS_DIRTY);
    }
    drag = null;
    dragStart = null;
    playersCanvas.classList.remove('dragging');
});

playersCanvas.addEventListener('dblclick', () => {
    setLock(null);
    fitToScreen();
    scheduleRender(MAP_DIRTY | PLAYERS_DIRTY);
});

// ─── Session chooser ─────────────────────────────────────────────────────────

let currentMode = 'idle'; // 'idle' | 'live' | 'replay'
// Server-authoritative playback state for the active replay, mirrored from
// /state and replayState SSE events. Drives the minimal replay control bar.
let replayState = null;

function showSessionError(msg) {
    elSessionError.textContent = msg;
    elSessionError.hidden = false;
}

function clearSessionError() {
    elSessionError.hidden = true;
    elSessionError.textContent = '';
}

function openModal() {
    elModal.hidden = false;
    clearSessionError();
}

function closeModal() {
    elModal.hidden = true;
}

function setMode(mode) {
    currentMode = mode;
    if (mode === 'idle') {
        elConn.textContent = 'Idle';
        elConn.classList.remove('connected');
        elStop.hidden = true;
    } else if (mode === 'live') {
        elConn.textContent = 'Live';
        elConn.classList.add('connected');
        elStop.hidden = false;
    } else if (mode === 'replay') {
        elConn.textContent = 'Replay';
        elConn.classList.add('connected');
        elStop.hidden = false;
    }
    const showReplayBar = mode === 'replay';
    elReplayPause.hidden = !showReplayBar;
    elReplaySeek.hidden = !showReplayBar;
    elReplaySpeed.hidden = !showReplayBar;
    if (!showReplayBar) replayState = null;
}

function updateReplayBar() {
    if (!replayState || currentMode !== 'replay') return;
    elReplayPause.textContent = replayState.paused ? 'Resume' : 'Pause';
    elReplaySeek.max = String(Math.max(0, (replayState.messageCount || 0) - 1));
    // Don't fight the user mid-drag — only sync the slider while unfocused.
    if (document.activeElement !== elReplaySeek) {
        elReplaySeek.value = String(replayState.position || 0);
    }
    const want = String(replayState.speed ?? 1);
    if (elReplaySpeed.value !== want) {
        // Snap to the nearest offered option (server clamps to [0.25, 8]).
        const options = Array.from(elReplaySpeed.options).map((o) => o.value);
        elReplaySpeed.value = options.includes(want) ? want : '1';
    }
}

async function postReplayControl(body) {
    try {
        const res = await fetch('/replay/control', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        replayState = await res.json();
        updateReplayBar();
    } catch (err) {
        console.error('[replay/control]', err);
    }
}

elReplayPause.addEventListener('click', () => {
    if (replayState) postReplayControl({ pause: !replayState.paused });
});

elReplaySeek.addEventListener('change', () => {
    postReplayControl({ seek: parseInt(elReplaySeek.value, 10) });
});

elReplaySpeed.addEventListener('change', () => {
    postReplayControl({ speed: parseFloat(elReplaySpeed.value) });
});

async function refreshSessionState(opts = {}) {
    try {
        const res = await fetch('/state');
        if (!res.ok) return;
        const data = await res.json();
        setMode(data.mode || 'idle');
        if (data.mode === 'idle' && opts.reopen) {
            openModal();
        } else if (data.mode !== 'idle') {
            closeModal();
        }
    } catch (err) {
        console.error('[state]', err);
    }
}

async function loadDemos() {
    try {
        const res = await fetch('/demos');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        elDemoSelect.innerHTML = '';
        const demos = data.demos || [];
        if (demos.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '(no demos found)';
            opt.disabled = true;
            elDemoSelect.appendChild(opt);
            /** @type {HTMLButtonElement} */ (elReplayForm.querySelector('button[type="submit"]')).disabled = true;
        } else {
            for (const name of demos) {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                elDemoSelect.appendChild(opt);
            }
            /** @type {HTMLButtonElement} */ (elReplayForm.querySelector('button[type="submit"]')).disabled = false;
        }
    } catch (err) {
        showSessionError(`Failed to load demo list: ${err.message}`);
    }
}

elTabs.forEach((btn) => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        elTabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
        elTabPanels.forEach((p) => p.classList.toggle('active', p.dataset.tab === tab));
        clearSessionError();
    });
});

elConnectForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearSessionError();
    const submitBtn = /** @type {HTMLButtonElement} */ (elConnectForm.querySelector('button[type="submit"]'));
    submitBtn.disabled = true;
    try {
        const host = elConnectHost.value.trim();
        const port = parseInt(elConnectPort.value, 10);
        const password = elConnectPassword.value;
        const res = await fetch('/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host, port, password }),
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            showSessionError(`Connect failed: ${body.error || res.status}`);
            return;
        }
        await refreshSessionState();
    } catch (err) {
        showSessionError(`Connect failed: ${err.message}`);
    } finally {
        submitBtn.disabled = false;
    }
});

elReplayForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearSessionError();
    const submitBtn = /** @type {HTMLButtonElement} */ (elReplayForm.querySelector('button[type="submit"]'));
    submitBtn.disabled = true;
    try {
        const file = elDemoSelect.value;
        if (!file) {
            showSessionError('Select a demo first.');
            return;
        }
        const res = await fetch(`/replay?file=${encodeURIComponent(file)}`, { method: 'POST' });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            showSessionError(`Replay failed: ${body.error || res.status}`);
            return;
        }
        await refreshSessionState();
    } catch (err) {
        showSessionError(`Replay failed: ${err.message}`);
    } finally {
        submitBtn.disabled = false;
    }
});

function toggleTextures() {
    texturesEnabled = !texturesEnabled;
    elBtnTextures.textContent = texturesEnabled ? 'Tex \u2713' : 'Tex \u2717';
    elBtnTextures.classList.toggle('tex-off', !texturesEnabled);
    if (currentMapname) loadMap(currentMapname);
}

elBtnTextures.addEventListener('click', toggleTextures);

document.addEventListener('keydown', (e) => {
    if (e.key === 't' || e.key === 'T') {
        const tag = document.activeElement ? document.activeElement.tagName : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        toggleTextures();
    }
});

elStop.addEventListener('click', async () => {
    try {
        if (currentMode === 'replay') {
            await fetch('/replay', { method: 'DELETE' });
        } else if (currentMode === 'live') {
            await fetch('/disconnect', { method: 'POST' });
        }
    } catch (err) {
        console.error('[stop]', err);
    }
    await refreshSessionState();
    openModal();
});

// Bootstrap: determine whether to show the modal and populate demos.
loadDemos();
refreshSessionState().then(() => {
    if (currentMode === 'idle') openModal();
});
