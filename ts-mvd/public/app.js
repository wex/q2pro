'use strict';

const SSE_URL = '/events';
const MAP_URL = '/maps/';

const mapCanvas = document.getElementById('map');
const playersCanvas = document.getElementById('players');
const mapCtx = mapCanvas.getContext('2d');
const playersCtx = playersCanvas.getContext('2d');
const elConn = document.getElementById('status-conn');
const elStop = document.getElementById('status-stop');
const elModal = document.getElementById('session-modal');
const elConnectForm = document.getElementById('connect-form');
const elReplayForm = document.getElementById('replay-form');
const elConnectHost = document.getElementById('connect-host');
const elConnectPort = document.getElementById('connect-port');
const elDemoSelect = document.getElementById('demo-select');
const elSessionError = document.getElementById('session-error');
const elTabs = document.querySelectorAll('#session-modal .tab');
const elTabPanels = document.querySelectorAll('#session-modal .tab-panel');
const elMap = document.getElementById('status-map');
const elEntities = document.getElementById('status-entities');
const elScoreboardBody = document.querySelector('#scoreboard tbody');
const elTeamScores = document.getElementById('team-scores');
const elKillfeed = document.getElementById('killfeed');
const elChat = document.getElementById('chat');

let mapBitmap = null;           // ImageBitmap or HTMLCanvasElement
let mapBitmapScale = 0;         // pixels per world unit used for current bitmap
let mapSvgBlobUrl = null;       // current SVG blob URL (for re-raster)
let mapBounds = null;
let currentMapname = '';
let players = [];
let transform = { tx: 0, ty: 0, scale: 1 };
let configstrings = {};
let serverStatus = null;
let statusMaxclients = 0;
let dpr = window.devicePixelRatio || 1;

// Caches invalidated on configstring changes
let teamMapCache = null;
let playerInfoCache = {};
let maxclientsCache = 0;

// ─── Configstring constants / colours ────────────────────────────────────────

const CS_MAXCLIENTS_OLD = 30;
const CS_MAXCLIENTS_EXT = 60;
const CS_MODELS_OLD = 32;
const CS_MODELS_EXT = 62;
const CS_PLAYERSKINS_OLD = 1312;
const CS_PLAYERSKINS_EXT = 12862;

const TEAM_COLOURS = [
    { fill: 'rgba(220, 30, 30, 0.85)', stroke: 'rgba(255, 160, 160, 0.9)', cone: 'rgba(220, 30, 30, 0.3)', coneStroke: 'rgba(220, 30, 30, 0.6)' },
    { fill: 'rgba(30, 100, 220, 0.85)', stroke: 'rgba(160, 190, 255, 0.9)', cone: 'rgba(30, 100, 220, 0.3)', coneStroke: 'rgba(30, 100, 220, 0.6)' },
    { fill: 'rgba(30, 180, 60, 0.85)', stroke: 'rgba(160, 255, 170, 0.9)', cone: 'rgba(30, 180, 60, 0.3)', coneStroke: 'rgba(30, 180, 60, 0.6)' },
];
const DEFAULT_COLOUR = { fill: 'rgba(140, 140, 140, 0.85)', stroke: 'rgba(200, 200, 200, 0.9)', cone: 'rgba(140, 140, 140, 0.3)', coneStroke: 'rgba(140, 140, 140, 0.6)' };

// ─── Combat FX ───────────────────────────────────────────────────────────────
//
// Three in-place effects replace the old shot-line traces:
//
//  1. Flash  — player's cone briefly glows when they fire (svc_muzzleflash).
//              Duration scales with weapon via FLASH_DURATION_MS_BY_MZ.
//  2. Damage — particle burst + expanding ring on the victim when a blood
//              or sparks TE lands on them. Yellow for sparks, red for blood.
//              Rate-limited to one burst per victim per DAMAGE_COOLDOWN_MS.
//  3. Kill X — fading red cross on the victim's last-known origin when an
//              obituary fires.
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
const RING_EXPAND_PX = 14;

const DAMAGE_COOLDOWN_MS = 80;

const KILL_X_TTL_MS = 800;

const COLOUR_BLOOD = [220, 40, 40];    // r,g,b
const COLOUR_SPARKS = [255, 210, 40];
const COLOUR_KILL = [255, 80, 80];

// Active FX state.
// flashes: Map<clientNum, { until, weapon }>
const flashes = new Map();
// bursts: [{ victim, kind, t0 }]  — one per accepted damage event.
const bursts = [];
// particles: [{ victim, kind, t0, dx, dy, vx, vy, r }]  — flat array for efficient GC.
const particles = [];
// killXs: [{ x, y, t0 }] in world coords.
const killXs = [];
// Rate-limit bookkeeping: clientNum → { t, kind }.
const lastDamageByVictim = new Map();

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

function handleKill(killEntry) {
    // appendKillfeed is also invoked from the same SSE event; we add the X
    // here. Resolve the victim clientNum by name.
    if (!killEntry || !killEntry.victim) return;
    const maxclients = maxclientsCache;
    for (let i = 0; i < maxclients; i++) {
        const info = getPlayerInfo(i);
        if (info.name === killEntry.victim) {
            const origin = playerOrigin(i);
            if (origin) {
                killXs.push({ x: origin[0], y: origin[1], t0: performance.now() });
                scheduleRender(PLAYERS_DIRTY);
            }
            return;
        }
    }
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
    const flags = dirty;
    dirty = 0;
    if (flags & MAP_DIRTY) renderMap();
    if (flags & PLAYERS_DIRTY) renderPlayers();
    maybeScheduleRaster();
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
        const radius = 16 + t * RING_EXPAND_PX;
        const col = b.kind === 'blood' ? COLOUR_BLOOD : COLOUR_SPARKS;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(col, alpha * 0.9);
        ctx.lineWidth = 2 / transform.scale;
        ctx.stroke();
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

    // ── Kill X marks (above everything, under the icons we're about to draw) ──
    let aliveKills = 0;
    for (let i = 0; i < killXs.length; i++) {
        const k = killXs[i];
        const age = now - k.t0;
        if (age >= KILL_X_TTL_MS) continue;
        if (aliveKills !== i) killXs[aliveKills] = k;
        aliveKills++;
        const t = age / KILL_X_TTL_MS;
        const alpha = 1 - t;
        const size = 14 + t * 10;
        const [cx, cy] = worldToSvg(k.x, k.y);
        ctx.strokeStyle = rgba(COLOUR_KILL, alpha);
        ctx.lineWidth = 3 / transform.scale;
        ctx.beginPath();
        ctx.moveTo(cx - size, cy - size);
        ctx.lineTo(cx + size, cy + size);
        ctx.moveTo(cx + size, cy - size);
        ctx.lineTo(cx - size, cy + size);
        ctx.stroke();
    }
    killXs.length = aliveKills;

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

        // Flash boost: while a recent muzzleflash is active, brighten the
        // cone fill+stroke and extend slightly beyond the team palette.
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
            // Replace cone palette with a team-tinted bright version.
            const baseFill = col.fill; // already has team colour at 0.85
            coneFill = baseFill.replace(/[\d.]+\)$/, `${0.35 + intensity * 0.45})`);
            coneStroke = col.stroke.replace(/[\d.]+\)$/, `${0.6 + intensity * 0.4})`);
            coneLineWidth = 1.5 + intensity * 1.5;
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

    // Evict flashes that have fully expired so we don't keep the render loop
    // alive indefinitely.
    for (const [num, f] of flashes) {
        if (f.until <= now) flashes.delete(num);
    }

    // Keep the render loop ticking while any FX is still alive.
    if (flashes.size > 0 || bursts.length > 0 || particles.length > 0 || killXs.length > 0) {
        scheduleRender(PLAYERS_DIRTY);
    }
}

// ─── Caches ──────────────────────────────────────────────────────────────────

function parsePlayerInfo(playerNumber) {
    const cs =
        configstrings[CS_PLAYERSKINS_EXT + playerNumber] ||
        configstrings[CS_PLAYERSKINS_OLD + playerNumber] ||
        '';
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
        parseInt(configstrings[CS_MAXCLIENTS_EXT] || configstrings[CS_MAXCLIENTS_OLD] || '0', 10);
}

function invalidateConfigCaches() {
    teamMapCache = null;
    playerInfoCache = {};
    recomputeMaxclients();
}

function countActiveSkins() {
    let count = 0;
    for (let i = 0; i < maxclientsCache; i++) {
        const cs = configstrings[CS_PLAYERSKINS_EXT + i] || configstrings[CS_PLAYERSKINS_OLD + i] || '';
        if (cs) count++;
    }
    return count;
}

function updatePlayerCount() {
    elEntities.textContent = `${countActiveSkins()} player(s)`;
}

function extractMapname() {
    const re = /^maps\/(.+)\.bsp$/;
    for (const idx of [CS_MODELS_EXT + 1, CS_MODELS_OLD + 1]) {
        const m = (configstrings[idx] || '').match(re);
        if (m) return m[1];
    }
    return '';
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
        const res = await fetch(MAP_URL + encodeURIComponent(levelname));
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

function pingForPlayer(name) {
    if (!serverStatus || !serverStatus.players) return null;
    for (const sp of serverStatus.players) {
        if (sp.name === name) return sp.ping;
    }
    return null;
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

function renderScoreboard() {
    renderTeamScores();

    const rows = [];
    const seen = new Set();
    for (const [numStr, sbp] of Object.entries(scoreboardState.players || {})) {
        const num = +numStr;
        seen.add(num);
        const info = getPlayerInfo(num);
        if (!info.name) continue;
        rows.push({ number: num, name: info.name, frags: sbp.frags || 0 });
    }
    // Also include anyone present via status/configstrings but not yet in a stats delta.
    if (maxclientsCache > 0) {
        for (let i = 0; i < maxclientsCache; i++) {
            if (seen.has(i)) continue;
            const info = getPlayerInfo(i);
            if (!info.name) continue;
            rows.push({ number: i, name: info.name, frags: 0 });
        }
    }

    rows.sort((a, b) => b.frags - a.frags || a.name.localeCompare(b.name));

    elScoreboardBody.innerHTML = rows.map((r) => {
        const ping = pingForPlayer(r.name);
        const pingStr = ping == null ? '-' : String(ping);
        return `<tr data-num="${r.number}"><td>${r.number}</td><td>${escapeHtml(r.name)}</td><td class="num">${r.frags}</td><td class="num">${pingStr}</td></tr>`;
    }).join('');
}

function flashScoreboardRow(num, cls) {
    const row = elScoreboardBody.querySelector(`tr[data-num="${num}"]`);
    if (!row) return;
    row.classList.remove(cls);
    // Force reflow to restart the animation.
    void row.offsetWidth;
    row.classList.add(cls);
    setTimeout(() => row.classList.remove(cls), 600);
}

function appendKillfeed(ev) {
    const li = document.createElement('li');
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
        refreshSessionState();
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
        configstrings = data.configstrings || {};
        players = data.players || [];
        if (data.status) {
            serverStatus = data.status;
            if (serverStatus.serverinfo && serverStatus.serverinfo.maxclients) {
                statusMaxclients = parseInt(serverStatus.serverinfo.maxclients, 10) || 0;
            }
        }
        if (data.scoreboard) scoreboardState = data.scoreboard;
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
        configstrings = data.configstrings || {};
        invalidateConfigCaches();
        checkMapChange();
        // Map/gamestate changed: clear transient feeds.
        elKillfeed.innerHTML = '';
        elChat.innerHTML = '';
        scoreboardState = { teamScores: { team1: 0, team2: 0, team3: 0 }, layoutsFlags: 0, layoutText: '', players: {} };
        renderScoreboard();
        scheduleRender(PLAYERS_DIRTY);
    });

    es.addEventListener('configstring', (e) => {
        const { index, value } = JSON.parse(e.data);
        configstrings[index] = value;
        invalidateConfigCaches();
        checkMapChange();
        renderScoreboard();
        scheduleRender(PLAYERS_DIRTY);
    });

    es.addEventListener('frame', (e) => {
        const data = JSON.parse(e.data);
        players = data.players || [];
        teamMapCache = null; // player set may have changed
        updatePlayerCount();

        // Update scoreboard from frame-level stats.
        if (data.teamScores) scoreboardState.teamScores = data.teamScores;
        if (typeof data.layoutsFlags === 'number') scoreboardState.layoutsFlags = data.layoutsFlags;
        const sbPlayers = {};
        for (const p of data.players || []) {
            sbPlayers[p.number] = { number: p.number, frags: p.frags || 0 };
        }
        scoreboardState.players = sbPlayers;
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
        handleKill(entry);
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

playersCanvas.addEventListener('mousedown', (e) => {
    drag = { x: e.clientX - transform.tx, y: e.clientY - transform.ty };
    playersCanvas.classList.add('dragging');
});

window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    transform = { ...transform, tx: e.clientX - drag.x, ty: e.clientY - drag.y };
    scheduleRender(MAP_DIRTY | PLAYERS_DIRTY);
});

window.addEventListener('mouseup', () => {
    drag = null;
    playersCanvas.classList.remove('dragging');
});

playersCanvas.addEventListener('dblclick', () => {
    fitToScreen();
    scheduleRender(MAP_DIRTY | PLAYERS_DIRTY);
});

// ─── Session chooser ─────────────────────────────────────────────────────────

let currentMode = 'idle'; // 'idle' | 'live' | 'replay'

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
}

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
            elReplayForm.querySelector('button[type="submit"]').disabled = true;
        } else {
            for (const name of demos) {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                elDemoSelect.appendChild(opt);
            }
            elReplayForm.querySelector('button[type="submit"]').disabled = false;
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
    const submitBtn = elConnectForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
        const host = elConnectHost.value.trim();
        const port = parseInt(elConnectPort.value, 10);
        const res = await fetch('/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host, port }),
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
    const submitBtn = elReplayForm.querySelector('button[type="submit"]');
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
