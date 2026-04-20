'use strict';

const SSE_URL = '/events';
const MAP_URL = '/maps/';

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const elConn = document.getElementById('status-conn');
const elMap = document.getElementById('status-map');
const elEntities = document.getElementById('status-entities');

let mapImg = null;
let mapBounds = null;
let currentMapname = '';
let players = [];
let transform = { tx: 0, ty: 0, scale: 1 };
let configstrings = {};
let serverStatus = null;
let statusMaxclients = 0;

// ─── Canvas sizing ──────────────────────────────────────────────────────────

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (mapImg) fitToScreen();
    render();
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ─── Fit to screen ──────────────────────────────────────────────────────────

function fitToScreen() {
    if (!mapBounds) return;
    const { svgW, svgH } = mapBounds;
    const scale = Math.min(canvas.width / svgW, canvas.height / svgH) * 0.95;
    const tx = (canvas.width - svgW * scale) / 2;
    const ty = (canvas.height - svgH * scale) / 2;
    transform = { tx, ty, scale };
}

// ─── Coordinate conversion ───────────────────────────────────────────────────
// Quake 2 world (X, Y) → SVG pixel coordinates (mirrors map-render.ts toSvg())

function worldToSvg(wx, wy) {
    const { minsX, maxsY, margin, labelHeight } = mapBounds;
    return [
        margin + (wx - minsX),
        labelHeight + margin + (maxsY - wy),
    ];
}

// ─── Render ──────────────────────────────────────────────────────────────────

function render() {
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    if (!mapImg || !mapBounds) return;

    const { tx, ty, scale } = transform;
    const { svgW, svgH } = mapBounds;

    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, tx, ty);

    ctx.drawImage(mapImg, 0, 0, svgW, svgH);

    const r = 16;
    const fontSize = Math.max(8, r * 1.4);
    ctx.font = `bold ${fontSize}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const maxclients = statusMaxclients || parseInt(configstrings[CS_MAXCLIENTS_EXT] || configstrings[CS_MAXCLIENTS_OLD] || '0', 10);
    const teamMap = buildTeamMap();

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

        const info = parsePlayerInfo(ent.number);
        if (info.name) {
            const nameFontSize = Math.max(10, r * 1.6);
            ctx.font = `bold ${nameFontSize}px monospace`;
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 3;
            ctx.strokeText(info.name, sx, sy - r - 10);
            ctx.fillText(info.name, sx, sy - r - 10);
            ctx.font = `bold ${fontSize}px monospace`;
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

    ctx.restore();
}

// ─── Configstring → map name ─────────────────────────────────────────────────
// Map BSP path is at CS_MODELS+1: index 33 (old protocol) or 63 (extended).

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

function parsePlayerInfo(playerNumber) {
    const cs =
        configstrings[CS_PLAYERSKINS_EXT + playerNumber] ||
        configstrings[CS_PLAYERSKINS_OLD + playerNumber] ||
        '';
    const sep = cs.indexOf('\\');
    if (sep === -1) return { name: '', skin: cs };
    return { name: cs.substring(0, sep), skin: cs.substring(sep + 1) };
}

function buildTeamMap() {
    const skinToTeam = {};
    const teamMap = {};
    let nextTeam = 0;
    for (const ent of players) {
        const info = parsePlayerInfo(ent.number);
        if (!info.skin) continue;
        if (!(info.skin in skinToTeam)) {
            skinToTeam[info.skin] = nextTeam++;
        }
        teamMap[ent.number] = skinToTeam[info.skin];
    }
    return teamMap;
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

        const blob = new Blob([svgText], { type: 'image/svg+xml' });
        const blobUrl = URL.createObjectURL(blob);

        const img = new Image();
        img.onload = () => {
            if (mapImg && mapImg._blobUrl) URL.revokeObjectURL(mapImg._blobUrl);
            img._blobUrl = blobUrl;
            mapImg = img;
            fitToScreen();
            render();
        };
        img.onerror = () => {
            URL.revokeObjectURL(blobUrl);
            console.error('[MAP] Image load failed for', levelname);
        };
        img.src = blobUrl;

        elMap.textContent = levelname;
    } catch (err) {
        console.error('[MAP] Failed to load:', err);
        elMap.textContent = `${levelname} (error)`;
    }
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
        elEntities.textContent = `${players.length} player(s)`;
        checkMapChange();
        render();
    });

    es.addEventListener('serverdata', (e) => {
        const data = JSON.parse(e.data);
        configstrings = data.configstrings || {};
        checkMapChange();
    });

    es.addEventListener('configstring', (e) => {
        const { index, value } = JSON.parse(e.data);
        configstrings[index] = value;
        checkMapChange();
    });

    es.addEventListener('frame', (e) => {
        const data = JSON.parse(e.data);
        players = data.players || [];
        elEntities.textContent = `${players.length} player(s)`;
        render();
    });

    es.addEventListener('status', (e) => {
        serverStatus = JSON.parse(e.data);
        if (serverStatus.serverinfo && serverStatus.serverinfo.maxclients) {
            statusMaxclients = parseInt(serverStatus.serverinfo.maxclients, 10) || 0;
        }
    });

    es.addEventListener('error', () => {
        elConn.textContent = 'Disconnected';
        elConn.classList.remove('connected');
    });
}

connectSSE();

// ─── Zoom / Pan ───────────────────────────────────────────────────────────────

const MIN_SCALE = 0.05;
const MAX_SCALE = 10;

canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, transform.scale * factor));
    const ratio = newScale / transform.scale;
    transform = {
        tx: mx - (mx - transform.tx) * ratio,
        ty: my - (my - transform.ty) * ratio,
        scale: newScale,
    };
    render();
}, { passive: false });

let drag = null;

canvas.addEventListener('mousedown', (e) => {
    drag = { x: e.clientX - transform.tx, y: e.clientY - transform.ty };
    canvas.classList.add('dragging');
});

window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    transform = { ...transform, tx: e.clientX - drag.x, ty: e.clientY - drag.y };
    render();
});

window.addEventListener('mouseup', () => {
    drag = null;
    canvas.classList.remove('dragging');
});

canvas.addEventListener('dblclick', () => {
    fitToScreen();
    render();
});
