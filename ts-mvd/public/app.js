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

    const maxclients = parseInt(configstrings[CS_MAXCLIENTS_EXT] || configstrings[CS_MAXCLIENTS_OLD] || '0', 10);

    for (const ent of players) {
        if (ent.number < 0 || ent.number >= maxclients) continue;
        const [sx, sy] = worldToSvg(ent.origin[0], ent.origin[1]);

        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(220, 30, 30, 0.85)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 160, 160, 0.9)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = '#fff';
        ctx.fillText(String(ent.number), sx, sy);

        const yaw = ent.viewangles[1];
        const ca = -yaw * (Math.PI / 180);
        const lineLen = r * 1.8;
        const tipX = sx + Math.cos(ca) * lineLen;
        const tipY = sy + Math.sin(ca) * lineLen;

        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(tipX, tipY);
        ctx.strokeStyle = 'rgba(255, 220, 50, 0.95)';
        ctx.lineWidth = 2;
        ctx.stroke();

        const headLen = r * 0.7;
        const headAngle = 0.45;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - headLen * Math.cos(ca - headAngle), tipY - headLen * Math.sin(ca - headAngle));
        ctx.lineTo(tipX - headLen * Math.cos(ca + headAngle), tipY - headLen * Math.sin(ca + headAngle));
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 220, 50, 0.95)';
        ctx.fill();
    }

    ctx.restore();
}

// ─── Configstring → map name ─────────────────────────────────────────────────
// Map BSP path is at CS_MODELS+1: index 33 (old protocol) or 63 (extended).

const CS_MAXCLIENTS_OLD = 30;
const CS_MAXCLIENTS_EXT = 60;
const CS_MODELS_OLD = 32;
const CS_MODELS_EXT = 62;

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
        if (data.status) serverStatus = data.status;
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
