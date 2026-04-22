'use strict';

const SSE_URL = '/events';
const MAP_URL = '/maps/';

const mapCanvas = document.getElementById('map');
const playersCanvas = document.getElementById('players');
const mapCtx = mapCanvas.getContext('2d');
const playersCtx = playersCanvas.getContext('2d');
const elConn = document.getElementById('status-conn');
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

// ─── Shot traces ─────────────────────────────────────────────────────────────

const TRACE_TTL_MS = 500;
const TRACE_MAX = 256;

// Two-point (exact) TE types — start is the muzzle, endPosition is the impact.
const TE_TWO_POINT = new Set([3 /*RailTrail*/, 11 /*BubbleTrail*/, 23 /*BfgLaser*/, 27 /*BlueHyper*/]);

const traces = []; // { x0, y0, x1, y1, team, t0 }

function pushTrace(start, end, team) {
    traces.push({
        x0: start[0], y0: start[1],
        x1: end[0], y1: end[1],
        team: team,
        t0: performance.now(),
    });
    if (traces.length > TRACE_MAX) traces.splice(0, traces.length - TRACE_MAX);
    scheduleRender(PLAYERS_DIRTY);
}

function nearestPlayerTeam(pos) {
    const maxclients = maxclientsCache;
    const teamMap = getTeamMap();
    let best = null;
    let bestDist = Infinity;
    for (const ent of players) {
        if (ent.number < 0 || ent.number >= maxclients) continue;
        const d = Math.hypot(pos[0] - ent.origin[0], pos[1] - ent.origin[1]);
        if (d < bestDist) { bestDist = d; best = ent; }
    }
    if (!best) return undefined;
    return teamMap[best.number];
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

    // Draw shot traces first, under the player icons. Expired ones are dropped.
    const now = performance.now();
    let aliveCount = 0;
    for (let i = 0; i < traces.length; i++) {
        const tr = traces[i];
        const age = now - tr.t0;
        if (age >= TRACE_TTL_MS) continue;
        if (aliveCount !== i) traces[aliveCount] = tr;
        aliveCount++;
        const alpha = 1 - age / TRACE_TTL_MS;
        const col = (tr.team !== undefined && tr.team < TEAM_COLOURS.length)
            ? TEAM_COLOURS[tr.team] : DEFAULT_COLOUR;
        const [sx0, sy0] = worldToSvg(tr.x0, tr.y0);
        const [sx1, sy1] = worldToSvg(tr.x1, tr.y1);
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = col.stroke;
        ctx.lineWidth = 2 / transform.scale;
        ctx.beginPath();
        ctx.moveTo(sx0, sy0);
        ctx.lineTo(sx1, sy1);
        ctx.stroke();
    }
    traces.length = aliveCount;
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

        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(leftX, leftY);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo(rightX, rightY);
        ctx.closePath();
        ctx.fillStyle = col.cone;
        ctx.fill();
        ctx.strokeStyle = col.coneStroke;
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    // Keep the render loop ticking while any trace is still fading.
    if (traces.length > 0) scheduleRender(PLAYERS_DIRTY);
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
    } else {
        li.innerHTML = `<span class="victim">${escapeHtml(ev.victim)}</span> <span class="world">${escapeHtml(ev.weapon || 'died')}</span>`;
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
        elConn.textContent = 'Connected';
        elConn.classList.add('connected');
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
        appendKillfeed(JSON.parse(e.data));
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

    es.addEventListener('te', (e) => {
        const ev = JSON.parse(e.data);
        if (!ev || !ev.position || !ev.endPosition) return;
        if (!TE_TWO_POINT.has(ev.type)) return;
        // Exact: muzzle → impact. Color from whoever is nearest the muzzle.
        const team = nearestPlayerTeam(ev.position);
        pushTrace(ev.position, ev.endPosition, team);
    });

    es.addEventListener('error', () => {
        elConn.textContent = 'Disconnected';
        elConn.classList.remove('connected');
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
