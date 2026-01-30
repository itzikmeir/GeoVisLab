import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

type LngLat = [number, number];
type Mode = "TRIPLE" | "SINGLE" | "MEASURE";
type Lang = "he" | "en" | "local";

const MAPTILER_KEY = "zmfamAfBbF0XXvV9Zx5Q";
const STYLE_URL = `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`;

// Routes styling (בהיר ושקוף יותר)
const ROUTE_COLOR = "#8CCBFF";
const ROUTE_OPACITY = 0.42;
const OUTLINE_OPACITY = 0.22;

// ✅ Selected route styling (כחול כהה ובולט)
const SELECTED_ROUTE_COLOR = "#1E4ED8";
const SELECTED_ROUTE_OPACITY = 0.92;
const SELECTED_ROUTE_WIDTH = 9;
const SELECTED_OUTLINE_OPACITY = 0.35;

// ✅ Route tag (A/B/C) visual size assumptions on screen
// note: in ensureBadgeImage we add size=52 with pixelRatio=2 => ~26 CSS px on screen at icon-size=1
const ROUTE_TAG_CANVAS_SIZE = 52;
const ROUTE_TAG_PIXEL_RATIO = 2;
const ROUTE_TAG_SCREEN_PX = ROUTE_TAG_CANVAS_SIZE / ROUTE_TAG_PIXEL_RATIO; // ~26

function haversineMeters(a: LngLat, b: LngLat) {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const [lng1, lat1] = a;
    const [lng2, lat2] = b;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const s1 = Math.sin(dLat / 2);
    const s2 = Math.sin(dLng / 2);
    const q = s1 * s1 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * s2 * s2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(q)));
}

function polylineMeters(coords: LngLat[]) {
    let sum = 0;
    for (let i = 1; i < coords.length; i++) sum += haversineMeters(coords[i - 1], coords[i]);
    return sum;
}

function fmtDistance(m: number) {
    if (!Number.isFinite(m)) return "—";
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(2)} km`;
}

function ensureRTLPluginLoadedOnce() {
    const w = window as any;
    if (w.__rtlPluginSet) return;

    const getStatus = (maplibregl as any).getRTLTextPluginStatus as undefined | (() => string);
    const setPlugin = (maplibregl as any).setRTLTextPlugin as
        | undefined
        | ((url: string, cb: () => void, lazy?: boolean) => void);

    if (typeof getStatus !== "function" || typeof setPlugin !== "function") return;

    const status = getStatus();
    if (status === "loaded" || status === "loading") {
        w.__rtlPluginSet = true;
        return;
    }

    try {
        setPlugin("https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.2.3/mapbox-gl-rtl-text.js", () => { }, true);
        w.__rtlPluginSet = true;
    } catch {
        w.__rtlPluginSet = true;
    }
}

async function osrmRoute(points: LngLat[]): Promise<LngLat[] | null> {
    if (points.length < 2) return null;
    const coords = points.map(([lng, lat]) => `${lng},${lat}`).join(";");
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const json = await res.json();
        const line = json?.routes?.[0]?.geometry?.coordinates;
        if (!Array.isArray(line) || line.length < 2) return null;
        return line as LngLat[];
    } catch {
        return null;
    }
}

function fcPoints(coords: LngLat[], props?: Record<string, any>[]) {
    return {
        type: "FeatureCollection",
        features: coords.map((c, i) => ({
            type: "Feature",
            properties: props?.[i] ?? {},
            geometry: { type: "Point", coordinates: c },
        })),
    };
}

function fcLine(coords: LngLat[]) {
    if (coords.length < 2) return { type: "FeatureCollection", features: [] };
    return {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } }],
    };
}

function fcLines(lines: { coords: LngLat[]; props?: Record<string, any> }[]) {
    return {
        type: "FeatureCollection",
        features: lines
            .filter((l) => l.coords.length >= 2)
            .map((l) => ({
                type: "Feature",
                properties: l.props ?? {},
                geometry: { type: "LineString", coordinates: l.coords },
            })),
    };
}

function setFC(map: maplibregl.Map, sourceId: string, data: any) {
    const s = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
    if (s) s.setData(data);
}

function pickTextFontFromStyle(map: maplibregl.Map): any {
    const layers = map.getStyle()?.layers ?? [];
    const sample = layers.find((l: any) => l.type === "symbol" && l?.layout?.["text-font"]) as any;
    const tf = sample?.layout?.["text-font"] ?? ["Noto Sans Regular", "Roboto Regular"];

    if (Array.isArray(tf) && tf.length) {
        const maybeRegular = tf.map((x: string) => (x.includes("Italic") ? x.replace("Italic", "Regular") : x));
        return maybeRegular;
    }
    return tf;
}

// ---- Images: pin + label backgrounds + badge ----
function ensurePinImage(map: maplibregl.Map) {
    if (map.hasImage("end-pin")) return;

    const size = 48;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(size / 2, size / 2);

    ctx.beginPath();
    ctx.ellipse(0, 16, 10, 4, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(0, 18);
    ctx.bezierCurveTo(10, 10, 14, 3, 14, -4);
    ctx.arc(0, -4, 14, 0, Math.PI, true);
    ctx.bezierCurveTo(-14, 3, -10, 10, 0, 18);
    ctx.closePath();
    ctx.fillStyle = "#e11d48";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(0, -4, 5.2, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    ctx.restore();

    const img = ctx.getImageData(0, 0, size, size);
    map.addImage("end-pin", { width: size, height: size, data: img.data }, { pixelRatio: 2 });
}

function ensureLabelBgImage(map: maplibregl.Map) {
    if (map.hasImage("label-bg")) return;

    const w = 140,
        h = 44;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(255,255,255,0.80)";
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 2;

    const r = 12;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(w - r, 0);
    ctx.quadraticCurveTo(w, 0, w, r);
    ctx.lineTo(w, h - r);
    ctx.quadraticCurveTo(w, h, w - r, h);
    ctx.lineTo(r, h);
    ctx.quadraticCurveTo(0, h, 0, h - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    const img = ctx.getImageData(0, 0, w, h);
    map.addImage("label-bg", { width: w, height: h, data: img.data }, { pixelRatio: 2 });
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const h = hex.replace("#", "").trim();
    if (h.length !== 6) return null;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if (![r, g, b].every((x) => Number.isFinite(x))) return null;
    return { r, g, b };
}

function ensureBadgeImage(map: maplibregl.Map) {
    // ✅ now we create TWO images:
    // - route-badge (normal, ROUTE_COLOR + ROUTE_OPACITY)
    // - route-badge-selected (selected, SELECTED_ROUTE_COLOR + SELECTED_ROUTE_OPACITY)
    const makeRoundedSquare = (fill: string, stroke: string, size: number) => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;

        const r = 12; // rounded corners
        const pad = 7; // inner padding for nicer frame
        const x = pad;
        const y = pad;
        const w = size - pad * 2;
        const h = size - pad * 2;

        ctx.clearRect(0, 0, size, size);

        // rounded rect path
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();

        ctx.fillStyle = fill;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = stroke;
        ctx.stroke();

        return ctx.getImageData(0, 0, size, size);
    };

    const rgb = hexToRgb(ROUTE_COLOR) ?? { r: 140, g: 203, b: 255 };
    const rgbSel = hexToRgb(SELECTED_ROUTE_COLOR) ?? { r: 30, g: 78, b: 216 };

    if (!map.hasImage("route-badge")) {
        const img = makeRoundedSquare(
            `rgba(${rgb.r},${rgb.g},${rgb.b},${ROUTE_OPACITY})`,
            "rgba(0,0,0,0.18)",
            ROUTE_TAG_CANVAS_SIZE
        );
        if (img) map.addImage("route-badge", { width: ROUTE_TAG_CANVAS_SIZE, height: ROUTE_TAG_CANVAS_SIZE, data: img.data }, { pixelRatio: ROUTE_TAG_PIXEL_RATIO });
    }

    if (!map.hasImage("route-badge-selected")) {
        const img = makeRoundedSquare(
            `rgba(${rgbSel.r},${rgbSel.g},${rgbSel.b},${SELECTED_ROUTE_OPACITY})`,
            "rgba(0,0,0,0.18)",
            ROUTE_TAG_CANVAS_SIZE
        );
        if (img) map.addImage("route-badge-selected", { width: ROUTE_TAG_CANVAS_SIZE, height: ROUTE_TAG_CANVAS_SIZE, data: img.data }, { pixelRatio: ROUTE_TAG_PIXEL_RATIO });
    }
}

// ---- Base-map layer toggles (roads/labels/poi/transit) ----
function toggleLayers(map: maplibregl.Map, predicate: (layer: any) => boolean, visible: boolean) {
    const style = map.getStyle();
    if (!style?.layers) return;
    for (const lyr of style.layers as any[]) {
        if (!lyr?.id) continue;
        if (!predicate(lyr)) continue;
        try {
            map.setLayoutProperty(lyr.id, "visibility", visible ? "visible" : "none");
        } catch { }
    }
}
function isOverlayLayerId(id: string) {
    return (
        id.startsWith("measure-") ||
        id.startsWith("single-") ||
        id.startsWith("start-") ||
        id.startsWith("end-") ||
        id.startsWith("triple-")
    );
}
function isLabelLayer(l: any) {
    const type = l.type;
    const id = String(l.id || "").toLowerCase();
    return type === "symbol" && !isOverlayLayerId(String(l.id || "")) && (id.includes("label") || id.includes("place") || id.includes("poi") || id.includes("name"));
}
function isPoiLayer(l: any) {
    const id = String(l.id || "").toLowerCase();
    return !isOverlayLayerId(String(l.id || "")) && (id.includes("poi") || id.includes("pois"));
}
function isRoadLayer(l: any) {
    const id = String(l.id || "").toLowerCase();
    const type = l.type;
    const srcLayer = String(l["source-layer"] || "").toLowerCase();
    const looksLikeRoad =
        id.includes("road") ||
        id.includes("street") ||
        id.includes("highway") ||
        id.includes("transport") ||
        srcLayer.includes("transport") ||
        srcLayer.includes("road");
    return !isOverlayLayerId(String(l.id || "")) && type === "line" && looksLikeRoad;
}
function isTransitLayer(l: any) {
    const id = String(l.id || "").toLowerCase();
    return !isOverlayLayerId(String(l.id || "")) && (id.includes("transit") || id.includes("rail") || id.includes("subway") || id.includes("train"));
}

// ---- Language switching on basemap labels ----
function applyLanguage(map: maplibregl.Map, lang: Lang, originalRef: React.MutableRefObject<Record<string, any>>) {
    const style = map.getStyle();
    if (!style?.layers) return;

    for (const layer of style.layers as any[]) {
        if (layer.type !== "symbol") continue;
        const id = String(layer.id || "");
        if (isOverlayLayerId(id)) continue;

        const current = map.getLayoutProperty(id, "text-field");
        if (originalRef.current[id] === undefined) originalRef.current[id] = current;

        let expr: any;
        if (lang === "he") {
            expr = ["coalesce", ["get", "name:he"], ["get", "name"], ["get", "name:en"]];
        } else if (lang === "en") {
            expr = ["coalesce", ["get", "name:en"], ["get", "name"], ["get", "name:he"]];
        } else {
            expr = ["coalesce", ["get", "name"], ["get", "name:en"], ["get", "name:he"]];
        }

        try {
            map.setLayoutProperty(id, "text-field", expr);
        } catch { }
    }
}

// ---------- Segment helpers (NEW) ----------
const PARK_FILL = "#00FF66";          // ירוק בוהק
const PARK_OPACITY = 0.95;
const PARK_OUTLINE = "rgba(0,90,50,0.9)";

function isParkLikeLayer(l: any) {
    const id = String(l?.id ?? "").toLowerCase();
    const type = String(l?.type ?? "");
    const srcLayer = String(l?.["source-layer"] ?? "").toLowerCase();

    // נזהה גם לפי id וגם לפי source-layer (כדי לעבוד על כמה שיותר וריאציות של style)
    const looksLikePark =
        id.includes("park") ||
        id.includes("leisure") ||
        id.includes("garden") ||
        id.includes("wood") ||
        id.includes("forest") ||
        srcLayer.includes("park") ||
        //srcLayer.includes("landuse");
        srcLayer.includes("landcover");

    // פארקים בדרך כלל הם fill (פוליגונים), לפעמים גם line ל-outline
    return looksLikePark && (type === "fill" || type === "line");
}
function emphasizeParks(map: maplibregl.Map) {
    const layers = map.getStyle()?.layers ?? [];
    for (const l of layers as any[]) {
        if (!l?.id) continue;
        if (typeof l.id !== "string") continue;
        if (!isParkLikeLayer(l)) continue;

        try {
            if (l.type === "fill") {
                map.setPaintProperty(l.id, "fill-color", PARK_FILL);
                map.setPaintProperty(l.id, "fill-opacity", PARK_OPACITY);
                // לא בכל שכבה קיים, אבל אם כן – נותן קונטרסט חזק
                try { map.setPaintProperty(l.id, "fill-outline-color", PARK_OUTLINE); } catch { }
            } else if (l.type === "line") {
                map.setPaintProperty(l.id, "line-color", PARK_OUTLINE);
                map.setPaintProperty(l.id, "line-width", 1.6);
                map.setPaintProperty(l.id, "line-opacity", 0.9);
            }
        } catch {
            // מתעלמים משכבות שלא מאפשרות override (נדיר)
        }
    }
}

function metersPerDegLat() {
    return 111132.92;
}
function metersPerDegLng(lat: number) {
    return 111412.84 * Math.cos((lat * Math.PI) / 180);
}
function offsetMeters(p: LngLat, dxMeters: number, dyMeters: number): LngLat {
    const lat = p[1];
    const dLat = dyMeters / metersPerDegLat();
    const dLng = dxMeters / (metersPerDegLng(lat) || 1);
    return [p[0] + dLng, p[1] + dLat];
}

function cumulativeDistances(line: LngLat[]) {
    const cum: number[] = [0];
    for (let i = 1; i < line.length; i++) {
        cum[i] = cum[i - 1] + haversineMeters(line[i - 1], line[i]);
    }
    return cum;
}

function turnAngles(line: LngLat[]) {
    const n = line.length;
    const ang = new Array(n).fill(0);

    for (let i = 1; i < n - 1; i++) {
        const a = line[i - 1];
        const b = line[i];
        const c = line[i + 1];

        const mx = metersPerDegLng(b[1]);
        const my = metersPerDegLat();

        const v1x = (b[0] - a[0]) * mx;
        const v1y = (b[1] - a[1]) * my;
        const v2x = (c[0] - b[0]) * mx;
        const v2y = (c[1] - b[1]) * my;

        const n1 = Math.hypot(v1x, v1y) || 1;
        const n2 = Math.hypot(v2x, v2y) || 1;
        const dot = (v1x / n1) * (v2x / n2) + (v1y / n1) * (v2y / n2);
        const cl = Math.max(-1, Math.min(1, dot));
        const rad = Math.acos(cl);
        const deg = (rad * 180) / Math.PI;

        ang[i] = deg;
    }
    return ang;
}

function findSplitIndices3(line: LngLat[]): { i1: number; i2: number } {
    const n = line.length;
    if (n < 4) {
        const i1 = Math.max(1, Math.floor(n / 3));
        const i2 = Math.max(i1 + 1, Math.floor((2 * n) / 3));
        return { i1, i2: Math.min(n - 2, i2) };
    }

    const cum = cumulativeDistances(line);
    const total = cum[cum.length - 1] || 1;

    const d1 = total / 3;
    const d2 = (2 * total) / 3;

    const ang = turnAngles(line);

    const minFrac = 0.18;
    const maxFrac = 0.48;
    const minLen = total * minFrac;
    const maxLen = total * maxFrac;

    const candidates: number[] = [];
    for (let i = 1; i < n - 1; i++) candidates.push(i);

    const turningSorted = [...candidates]
        .filter((i) => ang[i] >= 12)
        .sort((a, b) => ang[b] - ang[a])
        .slice(0, 24);

    const idxNear = (dist: number) => {
        let best = 1;
        let bestErr = Infinity;
        for (let i = 1; i < n - 1; i++) {
            const err = Math.abs(cum[i] - dist);
            if (err < bestErr) {
                bestErr = err;
                best = i;
            }
        }
        return best;
    };

    const near1 = idxNear(d1);
    const near2 = idxNear(d2);

    const pool = Array.from(new Set([...turningSorted, near1, near2]))
        .filter((i) => i >= 1 && i <= n - 2)
        .slice(0, 30);

    let bestPair: { i1: number; i2: number; score: number } | null = null;

    const scorePair = (i1: number, i2: number) => {
        const l1 = cum[i1] - cum[0];
        const l2 = cum[i2] - cum[i1];
        const l3 = total - cum[i2];

        if (l1 < minLen || l2 < minLen || l3 < minLen) return -Infinity;
        if (l1 > maxLen || l2 > maxLen || l3 > maxLen) return -Infinity;

        const turnScore = (ang[i1] || 0) + (ang[i2] || 0);
        const closeness = (1 - Math.abs(cum[i1] - d1) / total) + (1 - Math.abs(cum[i2] - d2) / total);
        const balance = 1 - (Math.max(l1, l2, l3) - Math.min(l1, l2, l3)) / total;

        return turnScore * 1.0 + closeness * 60 + balance * 80;
    };

    for (let a = 0; a < pool.length; a++) {
        for (let b = a + 1; b < pool.length; b++) {
            const i1 = pool[a];
            const i2 = pool[b];
            if (i2 <= i1) continue;

            const sc = scorePair(i1, i2);
            if (!Number.isFinite(sc)) continue;

            if (!bestPair || sc > bestPair.score) bestPair = { i1, i2, score: sc };
        }
    }

    if (bestPair) return { i1: bestPair.i1, i2: bestPair.i2 };

    let i1 = near1;
    let i2 = near2;
    if (i2 <= i1) i2 = Math.min(n - 2, i1 + 1);

    const nudgeForward = (idx: number, targetLen: number) => {
        while (idx < n - 2 && cum[idx] < targetLen) idx++;
        return Math.min(n - 2, idx);
    };
    const nudgeBackward = (idx: number, targetLen: number) => {
        while (idx > 1 && cum[idx] > targetLen) idx--;
        return Math.max(1, idx);
    };

    if (cum[i1] < minLen) i1 = nudgeForward(i1, minLen);
    if (cum[i2] - cum[i1] < minLen) i2 = nudgeForward(i2, cum[i1] + minLen);
    if (total - cum[i2] < minLen) i2 = nudgeBackward(i2, total - minLen);

    if (i2 <= i1) i2 = Math.min(n - 2, i1 + 1);

    return { i1, i2 };
}

function pointAtDistance(line: LngLat[], cum: number[], dist: number): LngLat {
    const n = line.length;
    if (n === 0) return [0, 0];
    if (dist <= 0) return line[0];
    const total = cum[cum.length - 1] || 1;
    if (dist >= total) return line[n - 1];

    let i = 1;
    while (i < n && cum[i] < dist) i++;
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(n - 1, i);

    const d0 = cum[i0];
    const d1 = cum[i1];
    const t = d1 === d0 ? 0 : (dist - d0) / (d1 - d0);

    const p0 = line[i0];
    const p1 = line[i1];
    return [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
}

function localDirUnitMeters(a: LngLat, b: LngLat): { ux: number; uy: number } {
    const mx = metersPerDegLng((a[1] + b[1]) / 2);
    const my = metersPerDegLat();
    const dx = (b[0] - a[0]) * mx;
    const dy = (b[1] - a[1]) * my;
    const len = Math.hypot(dx, dy) || 1;
    return { ux: dx / len, uy: dy / len };
}

// ✅ NEW: compute connector endpoint on the BORDER of the route tag square (not center)
function tagBorderPoint(map: maplibregl.Map, tagCenter: LngLat, anchor: LngLat): LngLat {
    try {
        const c = map.project(tagCenter); // Point
        const a = map.project(anchor);

        const dx = a.x - c.x;
        const dy = a.y - c.y;

        if (dx === 0 && dy === 0) return tagCenter;

        const halfW = ROUTE_TAG_SCREEN_PX / 2;
        const halfH = ROUTE_TAG_SCREEN_PX / 2;

        const tx = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
        const ty = dy !== 0 ? halfH / Math.abs(dy) : Infinity;
        const t = Math.min(tx, ty);

        const bx = c.x + dx * t;
        const by = c.y + dy * t;

        const ll = map.unproject([bx, by]);
        return [ll.lng, ll.lat];
    } catch {
        return tagCenter;
    }
}

// ---- Overlay sources/layers ----
function ensureOverlay(map: maplibregl.Map) {
    const addSrc = (id: string) => {
        if (!map.getSource(id)) {
            map.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        }
    };

    // ✅ ensure sources/fonts before adding overlay layers
    addSrc("edit-junctions");
    const fontStack = pickTextFontFromStyle(map);

    // ✅ NEW: edit junction circles
    if (!map.getLayer("edit-junction-circles")) {
        map.addLayer({
            id: "edit-junction-circles",
            type: "circle",
            source: "edit-junctions",
            paint: {
                "circle-radius": 6,
                "circle-color": [
                    "case",
                    ["boolean", ["get", "selected"], false],
                    SELECTED_ROUTE_COLOR,
                    "rgba(255,255,255,0.92)",
                ],
                "circle-stroke-width": 2,
                "circle-stroke-color": "#0b1220",
                "circle-opacity": 1,
            },
        });
    }

    // (רשות) טקסט קטן ליד כל נקודה – לא חובה
    if (!map.getLayer("edit-junction-text")) {
        map.addLayer({
            id: "edit-junction-text",
            type: "symbol",
            source: "edit-junctions",
            layout: {
                "text-field": ["to-string", ["get", "n"]],
                "text-font": fontStack,
                "text-size": 11,
                "text-offset": [0, 1.1],
                "text-anchor": "top",
                "text-allow-overlap": true,
                "text-ignore-placement": true,
                "text-optional": true,
            },
            paint: {
                "text-color": "#e8eefc",
                "text-halo-color": "rgba(11,15,23,0.85)",
                "text-halo-width": 1,
            },
        });
    }


    // ✅ NEW: edit mode overlays
    addSrc("edit-junctions");

    // measure
    addSrc("measure-points");
    addSrc("measure-line");

    // single
    addSrc("single-points");
    addSrc("single-line");

    // start/end + triple routes
    addSrc("start-end");
    addSrc("triple-a");
    addSrc("triple-b");
    addSrc("triple-c");

    // route badges + connector lines
    addSrc("triple-badge-points");
    addSrc("triple-badge-lines");

    // ✅ NEW: selected route segments overlays
    addSrc("triple-seg-points");
    addSrc("triple-seg-ticks");

    // images
    try {
        ensurePinImage(map);
        ensureLabelBgImage(map);
        ensureBadgeImage(map); // ✅ now makes square tag + selected variant
    } catch { }

    // MEASURE line/points
    if (!map.getLayer("measure-line")) {
        map.addLayer({
            id: "measure-line",
            type: "line",
            source: "measure-line",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#0b1220", "line-width": 4, "line-opacity": 0.85 },
        });
    }
    if (!map.getLayer("measure-points")) {
        map.addLayer({
            id: "measure-points",
            type: "circle",
            source: "measure-points",
            paint: { "circle-radius": 5, "circle-color": "#0b1220", "circle-stroke-width": 2, "circle-stroke-color": "#fff" },
        });
    }

    // SINGLE/TRIPLE line helper (outline + route)
    const addLineWithOutline = (srcId: string, baseId: string, width: number) => {
        const outlineId = `${baseId}-outline`;
        if (!map.getLayer(outlineId)) {
            map.addLayer({
                id: outlineId,
                type: "line",
                source: srcId,
                layout: { "line-cap": "round", "line-join": "round" },
                paint: { "line-color": "#0b1220", "line-width": width + 2, "line-opacity": OUTLINE_OPACITY },
            });
        }
        if (!map.getLayer(baseId)) {
            map.addLayer({
                id: baseId,
                type: "line",
                source: srcId,
                layout: { "line-cap": "round", "line-join": "round" },
                paint: { "line-color": ROUTE_COLOR, "line-width": width, "line-opacity": ROUTE_OPACITY },
            });
        }
    };

    addLineWithOutline("single-line", "single-line", 6);

    if (!map.getLayer("single-points")) {
        map.addLayer({
            id: "single-points",
            type: "circle",
            source: "single-points",
            paint: {
                "circle-radius": 5,
                "circle-color": ROUTE_COLOR,
                "circle-stroke-width": 2,
                "circle-stroke-color": "#fff",
                "circle-opacity": 0.95,
            },
        });
    }

    // TRIPLE routes
    addLineWithOutline("triple-a", "triple-a", 7);
    addLineWithOutline("triple-b", "triple-b", 7);
    addLineWithOutline("triple-c", "triple-c", 7);

    // START marker
    if (!map.getLayer("start-circle")) {
        map.addLayer({
            id: "start-circle",
            type: "circle",
            source: "start-end",
            filter: ["==", ["get", "kind"], "start"],
            paint: {
                "circle-radius": 11,
                "circle-color": "#ffffff",
                "circle-stroke-width": 4,
                "circle-stroke-color": "#0b1220",
                "circle-opacity": 1,
            },
        });
    }

    // END marker (pin)
    if (!map.getLayer("end-pin")) {
        map.addLayer({
            id: "end-pin",
            type: "symbol",
            source: "start-end",
            filter: ["==", ["get", "kind"], "end"],
            layout: {
                "icon-image": "end-pin",
                "icon-size": 1.55,
                "icon-anchor": "bottom",
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
            },
        });
    }

    // START/END label bg
    const addLabelBg = (id: string, filter: any, offsetPx: [number, number]) => {
        if (map.getLayer(id)) return;
        map.addLayer({
            id,
            type: "symbol",
            source: "start-end",
            filter,
            layout: {
                "icon-image": "label-bg",
                "icon-size": 1,
                "icon-anchor": "center",
                "icon-offset": offsetPx,
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
            },
        });
    };
    addLabelBg("start-label-bg", ["==", ["get", "kind"], "start"], [0, -36]);
    addLabelBg("end-label-bg", ["==", ["get", "kind"], "end"], [0, -44]);

    // START/END label text
    const addLabelText = (id: string, filter: any, offsetEm: [number, number]) => {
        if (map.getLayer(id)) return;
        map.addLayer({
            id,
            type: "symbol",
            source: "start-end",
            filter,
            layout: {
                "symbol-placement": "point",
                "text-field": ["to-string", ["get", "label"]],
                "text-font": fontStack,
                "text-size": 16,
                "text-anchor": "center",
                "text-offset": offsetEm,
                "text-allow-overlap": true,
                "text-ignore-placement": true,
                "text-optional": true,
            },
            paint: {
                "text-color": "#0b1220",
                "text-halo-color": "#ffffff",
                "text-halo-width": 1.5,
                "text-opacity": 1,
            },
        });
    };
    addLabelText("start-label", ["==", ["get", "kind"], "start"], [0, -2.1]);
    addLabelText("end-label", ["==", ["get", "kind"], "end"], [0, -2.6]);

    // Badge connector lines
    if (!map.getLayer("triple-badge-lines")) {
        map.addLayer({
            id: "triple-badge-lines",
            type: "line",
            source: "triple-badge-lines",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
                "line-color": "#0b1220",
                "line-width": 2,
                "line-opacity": 0.35,
            },
        });
    }

    // Badge background (square rounded)
    if (!map.getLayer("triple-badges")) {
        map.addLayer({
            id: "triple-badges",
            type: "symbol",
            source: "triple-badge-points",
            layout: {
                "icon-image": "route-badge",
                "icon-size": 1,
                "icon-anchor": "center",
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
            },
        });
    }

    // Badge text (א/ב/ג)
    if (!map.getLayer("triple-badge-text")) {
        map.addLayer({
            id: "triple-badge-text",
            type: "symbol",
            source: "triple-badge-points",
            layout: {
                "text-field": ["to-string", ["get", "label"]],
                "text-font": fontStack,
                "text-size": 18,
                "text-anchor": "center",
                "text-allow-overlap": true,
                "text-ignore-placement": true,
                "text-optional": true,
            },
            paint: {
                "text-color": "#0b1220",
                "text-halo-color": "#ffffff",
                "text-halo-width": 1.2,
                "text-opacity": 1,
            },
        });
    }

    // ✅ NEW: segment boundary ticks (thin short lines)
    if (!map.getLayer("triple-seg-ticks")) {
        map.addLayer({
            id: "triple-seg-ticks",
            type: "line",
            source: "triple-seg-ticks",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
                "line-color": "#0b1220",
                "line-width": 2,
                "line-opacity": 0.7,
            },
        });
    }

    // ✅ NEW: segment markers background circles
    if (!map.getLayer("triple-seg-circles")) {
        map.addLayer({
            id: "triple-seg-circles",
            type: "circle",
            source: "triple-seg-points",
            paint: {
                "circle-radius": 10,
                "circle-color": SELECTED_ROUTE_COLOR,
                "circle-opacity": 0.95,
                "circle-stroke-width": 2,
                "circle-stroke-color": "#ffffff",
            },
        });
    }

    // ✅ NEW: segment markers text (1/2/3)
    if (!map.getLayer("triple-seg-text")) {
        map.addLayer({
            id: "triple-seg-text",
            type: "symbol",
            source: "triple-seg-points",
            layout: {
                "text-field": ["to-string", ["get", "label"]],
                "text-font": fontStack,
                "text-size": 14,
                "text-anchor": "center",
                "text-allow-overlap": true,
                "text-ignore-placement": true,
                "text-optional": true,
            },
            paint: {
                "text-color": "#ffffff",
                "text-halo-color": "rgba(0,0,0,0.25)",
                "text-halo-width": 1,
                "text-opacity": 1,
            },
        });
    }

    // Ensure order
    const moveSafe = (id: string) => {
        try {
            map.moveLayer(id);
        } catch { }
    };

    // דגלונים: קו -> ריבוע -> טקסט
    moveSafe("triple-badge-lines");
    moveSafe("triple-badges");
    moveSafe("triple-badge-text");

    // segments on top of selected route
    moveSafe("triple-seg-ticks");
    moveSafe("triple-seg-circles");
    moveSafe("triple-seg-text");

    // מוצא/יעד: רקע -> טקסט
    moveSafe("start-label-bg");
    moveSafe("end-label-bg");
    moveSafe("start-label");
    moveSafe("end-label");

    // מרקרים מעל
    moveSafe("start-circle");
    moveSafe("end-pin");

    moveSafe("edit-junction-circles");
    moveSafe("edit-junction-text");

}

function midpointOnLine(line: LngLat[]): LngLat {
    if (!line.length) return [0, 0];
    return line[Math.floor(line.length / 2)] ?? line[0];
}
function clampToBounds(p: LngLat, b: maplibregl.LngLatBounds, padRatio = 0.06): LngLat {
    const west = b.getWest(),
        east = b.getEast(),
        south = b.getSouth(),
        north = b.getNorth();
    const padLng = (east - west) * padRatio;
    const padLat = (north - south) * padRatio;
    const lng = Math.min(east - padLng, Math.max(west + padLng, p[0]));
    const lat = Math.min(north - padLat, Math.max(south + padLat, p[1]));
    return [lng, lat];
}
function euclidDeg(a: LngLat, b: LngLat) {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy);
}

type BadgeId = "A" | "B" | "C";
type BadgePoint = { id: BadgeId; label: string; coord: LngLat };
type AnchorPoint = { id: BadgeId; coord: LngLat };

function buildBadgeFC(badges: BadgePoint[]) {
    return fcPoints(
        badges.map((b) => b.coord),
        badges.map((b) => ({ id: b.id, label: b.label }))
    );
}

// ✅ UPDATED: connector uses border-point on the tag frame (not center)
function buildConnectorFC(map: maplibregl.Map, anchors: AnchorPoint[], badges: BadgePoint[]) {
    const mapBadge = new Map<BadgeId, LngLat>(badges.map((b) => [b.id, b.coord]));
    return fcLines(
        anchors.map((a) => {
            const badgeCenter = mapBadge.get(a.id)!;
            const endOnBorder = tagBorderPoint(map, badgeCenter, a.coord);
            return {
                coords: [a.coord, endOnBorder],
                props: { id: a.id },
            };
        })
    );
}

// ✅ NEW: apply selected route highlight
function applySelectedRouteStyles(map: maplibregl.Map, selected: BadgeId) {
    const ids: BadgeId[] = ["A", "B", "C"];
    const layerId = (id: BadgeId) => (id === "A" ? "triple-a" : id === "B" ? "triple-b" : "triple-c");
    for (const id of ids) {
        const base = layerId(id);
        const outline = `${base}-outline`;

        const isSel = id === selected;

        try {
            map.setPaintProperty(base, "line-color", isSel ? SELECTED_ROUTE_COLOR : ROUTE_COLOR);
            map.setPaintProperty(base, "line-opacity", isSel ? SELECTED_ROUTE_OPACITY : ROUTE_OPACITY);
            map.setPaintProperty(base, "line-width", isSel ? SELECTED_ROUTE_WIDTH : 7);
        } catch { }

        try {
            map.setPaintProperty(outline, "line-opacity", isSel ? SELECTED_OUTLINE_OPACITY : OUTLINE_OPACITY);
            map.setPaintProperty(outline, "line-width", isSel ? SELECTED_ROUTE_WIDTH + 2 : 9);
        } catch { }
    }
}

// ✅ NEW: make sure selected route is ABOVE other routes, but BELOW overlays (badges/segments/labels)
function bringSelectedRouteAboveOthers(map: maplibregl.Map, selected: BadgeId) {
    const before = map.getLayer("triple-badge-lines") ? "triple-badge-lines" : undefined;

    const baseId = (id: BadgeId) => (id === "A" ? "triple-a" : id === "B" ? "triple-b" : "triple-c");
    const order: BadgeId[] = (["A", "B", "C"] as BadgeId[]).filter((x) => x !== selected).concat([selected]);

    for (const id of order) {
        const base = baseId(id);
        const outline = `${base}-outline`;
        try {
            if (before) map.moveLayer(outline, before);
            else map.moveLayer(outline);
        } catch { }
        try {
            if (before) map.moveLayer(base, before);
            else map.moveLayer(base);
        } catch { }
    }
}

// ✅ NEW: update tag icon to selected (blue) for chosen route
function applySelectedTagStyle(map: maplibregl.Map, selected: BadgeId) {
    try {
        map.setLayoutProperty("triple-badges", "icon-image", [
            "case",
            ["==", ["get", "id"], selected],
            "route-badge-selected",
            "route-badge",
        ]);
    } catch { }

    // optional: keep text readable (white on selected)
    try {
        map.setPaintProperty("triple-badge-text", "text-color", [
            "case",
            ["==", ["get", "id"], selected],
            "#ffffff",
            "#0b1220",
        ]);
    } catch { }
}


// ---------- Route Edit helpers (NEW) ----------
type EditJunction = { id: string; coord: LngLat; lineIdx: number; locked: boolean };

function buildEditJunctions(line: LngLat[]): EditJunction[] {
    const n = line.length;
    if (n < 2) return [];
    const ang = turnAngles(line);
    const cum = cumulativeDistances(line);

    const TURN_THRESH_DEG = 28;      // סף לזיהוי "צומת/פניה" משמעותית
    const MIN_SPACING_M = 45;        // להימנע מצמתים צפופים מדי
    const MAX_JUNCTIONS = 26;        // כולל start/end (כדי לא להעמיס ולא לשבור OSRM)

    const picks: { i: number; score: number }[] = [];

    // start/end תמיד
    picks.push({ i: 0, score: 1e9 });
    picks.push({ i: n - 1, score: 1e9 });

    for (let i = 1; i < n - 1; i++) {
        const score = ang[i] || 0;
        if (score < TURN_THRESH_DEG) continue;
        picks.push({ i, score });
    }

    // מיון לפי "חוזק פניה" כדי לבחור את המרכזיים
    picks.sort((a, b) => b.score - a.score);

    // בנייה עם ריווח מינימלי, ואז החזרה לסדר לאורך הקו
    const chosen: number[] = [];
    const tryAdd = (idx: number) => {
        const d = cum[idx] || 0;
        for (const j of chosen) {
            const dj = cum[j] || 0;
            if (Math.abs(d - dj) < MIN_SPACING_M) return false;
        }
        chosen.push(idx);
        return true;
    };

    // קודם כל דואגים ל-start/end
    tryAdd(0);
    tryAdd(n - 1);

    for (const p of picks) {
        if (chosen.length >= MAX_JUNCTIONS) break;
        tryAdd(p.i);
    }

    chosen.sort((a, b) => a - b);

    // אם עדיין מעט מדי (למשל מסלול כמעט ישר) — דוגמים נקודות לאורך המרחק
    if (chosen.length < 4) {
        const total = cum[n - 1] || 1;
        const targets = [total * 0.33, total * 0.66];
        for (const t of targets) {
            let best = 1;
            let bestErr = Infinity;
            for (let i = 1; i < n - 1; i++) {
                const err = Math.abs((cum[i] || 0) - t);
                if (err < bestErr) { bestErr = err; best = i; }
            }
            if (!chosen.includes(best)) chosen.push(best);
        }
        chosen.sort((a, b) => a - b);
    }

    const out: EditJunction[] = chosen.map((i) => ({
        id: String(i),
        coord: line[i],
        lineIdx: i,
        locked: i === 0 || i === n - 1,
    }));

    return out;
}

export default function App() {
    const mapDivRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<maplibregl.Map | null>(null);

    // base map controls
    const [lang, setLang] = useState<Lang>("he");
    const originalTextFieldRef = useRef<Record<string, any>>({});
    const [showRoads, setShowRoads] = useState(true);
    const [showTransit, setShowTransit] = useState(true);
    const [showLabels, setShowLabels] = useState(true);
    const [showPOI, setShowPOI] = useState(true);

    // modes
    const [mode, setMode] = useState<Mode>("TRIPLE");
    const modeRef = useRef<Mode>("TRIPLE");
    useEffect(() => {
        modeRef.current = mode;
    }, [mode]);

    // MEASURE
    const [measurePts, setMeasurePts] = useState<LngLat[]>([]);
    const measureDist = useMemo(() => polylineMeters(measurePts), [measurePts]);

    // SINGLE route
    const [singleWaypoints, setSingleWaypoints] = useState<LngLat[]>([]);
    const [singleLine, setSingleLine] = useState<LngLat[]>([]);
    const [isRoutingSingle, setIsRoutingSingle] = useState(false);
    const singleDist = useMemo(() => polylineMeters(singleLine.length ? singleLine : singleWaypoints), [singleLine, singleWaypoints]);

    // TRIPLE route
    const [start, setStart] = useState<LngLat | null>(null);
    const [end, setEnd] = useState<LngLat | null>(null);
    const [diversity, setDiversity] = useState(0.35);
    const [isRoutingTriple, setIsRoutingTriple] = useState(false);

    // "חישוב" מתבצע רק כשמגדילים nonce
    const [calcNonce, setCalcNonce] = useState(0);

    // badge state (לגרירה ידנית)
    const [badges, setBadges] = useState<BadgePoint[]>([]);
    const [anchors, setAnchors] = useState<AnchorPoint[]>([]);
    const badgesRef = useRef<BadgePoint[]>([]);
    const anchorsRef = useRef<AnchorPoint[]>([]);
    useEffect(() => {
        badgesRef.current = badges;
    }, [badges]);
    useEffect(() => {
        anchorsRef.current = anchors;
    }, [anchors]);

    const canTriple = useMemo(() => !!start && !!end, [start, end]);

    // Refs for click logic
    const startRef = useRef<LngLat | null>(null);
    const endRef = useRef<LngLat | null>(null);
    useEffect(() => {
        startRef.current = start;
        endRef.current = end;
    }, [start, end]);

    // ✅ selected route (A default)
    const [selectedRoute, setSelectedRoute] = useState<BadgeId>("A");

    const selectedRouteRef = useRef<BadgeId>("A");
    useEffect(() => { selectedRouteRef.current = selectedRoute; }, [selectedRoute]);


    // ✅ base (system) triple lines snapshot (for "reset to system solution")
    const tripleLinesBaseRef = useRef<{ A: LngLat[]; B: LngLat[]; C: LngLat[] }>({ A: [], B: [], C: [] });

    // ✅ Route Edit mode (selected route only)
    const [isEditMode, setIsEditMode] = useState(false);
    const isEditModeRef = useRef(false);
    useEffect(() => { isEditModeRef.current = isEditMode; }, [isEditMode]);

    // אם עוברים בין מסלולים בזמן עריכה — נבנה מחדש את רשימת הצמתים למסלול החדש
    useEffect(() => {
        if (!isEditMode) return;
        startEditModeForSelected();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedRoute]);


    const [editJunctions, setEditJunctions] = useState<EditJunction[]>([]);
    const editJunctionsRef = useRef<EditJunction[]>([]);
    useEffect(() => { editJunctionsRef.current = editJunctions; }, [editJunctions]);

    // junctions disabled by user (id = lineIdx as string)
    const [editDisabledIds, setEditDisabledIds] = useState<string[]>([]);

    const editDisabledIdsRef = useRef<string[]>([]);
    useEffect(() => { editDisabledIdsRef.current = editDisabledIds; }, [editDisabledIds]);


    // undo/redo history
    const [editHist, setEditHist] = useState<string[][]>([]);
    const [editHistPos, setEditHistPos] = useState(0);
    const editHistRef = useRef<string[][]>([]);
    const editHistPosRef = useRef(0);
    useEffect(() => { editHistRef.current = editHist; }, [editHist]);
    useEffect(() => { editHistPosRef.current = editHistPos; }, [editHistPos]);

    const isEditRoutingRef = useRef(false);


    // ✅ store computed triple lines for segmentation
    const tripleLinesRef = useRef<{ A: LngLat[]; B: LngLat[]; C: LngLat[] }>({ A: [], B: [], C: [] });


    // ---------- Route Edit mode logic (selected route only) ----------
    const tripleSrcId = (id: BadgeId) => (id === "A" ? "triple-a" : id === "B" ? "triple-b" : "triple-c");

    const renderEditJunctionsOnMap = (junctions: EditJunction[], disabledIds: string[]) => {
        const map = mapRef.current;
        if (!map) return;
        if (!map.getSource("edit-junctions")) return;

        if (!isEditModeRef.current || !junctions.length) {
            setFC(map, "edit-junctions", fcPoints([]));
            return;
        }

        const disabled = new Set(disabledIds);
        const coords = junctions.map((j) => j.coord);
        const props = junctions.map((j, idx) => ({
            id: j.id,
            n: idx + 1,
            locked: j.locked,
            // "selected" כאן = עדיין קיים במסלול (כלומר לא נמחק)
            selected: j.locked ? true : !disabled.has(j.id),
        }));

        setFC(map, "edit-junctions", fcPoints(coords, props));
    };

    const renderSelectedSegmentsNow = (line: LngLat[]) => {
        const map = mapRef.current;
        if (!map) return;
        if (!map.getSource("triple-seg-points")) return;

        if (!line || line.length < 2) {
            setFC(map, "triple-seg-points", fcPoints([]));
            setFC(map, "triple-seg-ticks", fcLines([]));
            setFC(map, "edit-junctions", fcPoints([]));
            return;
        }

        const { i1, i2 } = findSplitIndices3(line);
        const cum = cumulativeDistances(line);
        const total = cum[cum.length - 1] || 1;

        const d0 = 0;
        const dI1 = cum[i1];
        const dI2 = cum[i2];
        const dEnd = total;

        const mid1 = pointAtDistance(line, cum, (d0 + dI1) / 2);
        const mid2 = pointAtDistance(line, cum, (dI1 + dI2) / 2);
        const mid3 = pointAtDistance(line, cum, (dI2 + dEnd) / 2);

        const tickLenMeters = 18;
        const makeTick = (idx: number) => {
            const p = line[idx];
            const prev = line[Math.max(0, idx - 1)];
            const next = line[Math.min(line.length - 1, idx + 1)];
            const dir = localDirUnitMeters(prev, next);
            const px = -dir.uy;
            const py = dir.ux;

            const a = offsetMeters(p, px * (tickLenMeters / 2), py * (tickLenMeters / 2));
            const b = offsetMeters(p, -px * (tickLenMeters / 2), -py * (tickLenMeters / 2));
            return [a, b] as LngLat[];
        };

        const tick1 = makeTick(i1);
        const tick2 = makeTick(i2);

        setFC(map, "triple-seg-points", fcPoints([mid1, mid2, mid3], [{ label: "1" }, { label: "2" }, { label: "3" }]));
        setFC(map, "triple-seg-ticks", fcLines([{ coords: tick1 }, { coords: tick2 }]));
    };

    const updateSelectedRouteOnMap = (line: LngLat[]) => {
        const map = mapRef.current;
        if (!map) return;

        const id = selectedRouteRef.current;
        const src = tripleSrcId(id);

        setFC(map, src, fcLine(line));

        // update ref store
        if (id === "A") tripleLinesRef.current.A = line;
        else if (id === "B") tripleLinesRef.current.B = line;
        else tripleLinesRef.current.C = line;

        // update anchor (for connector line)
        const newAnchor = midpointOnLine(line);
        const currentAnchors =
            anchorsRef.current.length
                ? anchorsRef.current
                : ([
                    { id: "A" as const, coord: midpointOnLine(tripleLinesRef.current.A) },
                    { id: "B" as const, coord: midpointOnLine(tripleLinesRef.current.B) },
                    { id: "C" as const, coord: midpointOnLine(tripleLinesRef.current.C) },
                ] as AnchorPoint[]);

        const nextAnchors = currentAnchors.map((a) => (a.id === id ? { ...a, coord: newAnchor } : a));
        setAnchors(nextAnchors);


        // update connector lines immediately (use current badges positions)
        const b = badgesRef.current;
        if (b.length) setFC(map, "triple-badge-lines", buildConnectorFC(map, nextAnchors, b));

        // keep selected on top + keep styling
        applySelectedRouteStyles(map, id);
        bringSelectedRouteAboveOthers(map, id);

        // update segment overlays now
        renderSelectedSegmentsNow(line);
    };

    const applyEditDisabled = (nextDisabledIds: string[], pushHistory: boolean) => {
        setEditDisabledIds(nextDisabledIds);
        renderEditJunctionsOnMap(editJunctionsRef.current, nextDisabledIds);

        if (pushHistory) {
            const pos = editHistPosRef.current;
            const base = editHistRef.current.slice(0, pos + 1);
            const nextHist = [...base, nextDisabledIds];

            editHistRef.current = nextHist;
            editHistPosRef.current = pos + 1;

            setEditHist(nextHist);
            setEditHistPos(pos + 1);
        }

        // rebuild route from remaining junction waypoints (async)
        if (isEditRoutingRef.current) return;
        const junctions = editJunctionsRef.current;
        if (!junctions.length) return;

        const disabled = new Set(nextDisabledIds);
        const waypoints: LngLat[] = junctions.filter((j) => j.locked || !disabled.has(j.id)).map((j) => j.coord);

        if (waypoints.length < 2) return;

        isEditRoutingRef.current = true;
        (async () => {
            const snapped = await osrmRoute(waypoints);
            const line = snapped && snapped.length >= 2 ? snapped : waypoints;
            updateSelectedRouteOnMap(line);
            isEditRoutingRef.current = false;
        })().catch(() => {
            isEditRoutingRef.current = false;
        });
    };

    const startEditModeForSelected = () => {
        const map = mapRef.current;
        if (!map) return;

        const id = selectedRouteRef.current;
        const line = id === "A" ? tripleLinesRef.current.A : id === "B" ? tripleLinesRef.current.B : tripleLinesRef.current.C;
        if (!line || line.length < 2) return;

        const junctions = buildEditJunctions(line);
        setEditJunctions(junctions);
        setEditDisabledIds([]);
        setEditHist([[]]);
        setEditHistPos(0);
        editHistRef.current = [[]];
        editHistPosRef.current = 0;
        editHistRef.current = [[]];
        editHistPosRef.current = 0;
        setIsEditMode(true);

        // render immediately
        renderEditJunctionsOnMap(junctions, []);
    };

    const stopEditMode = () => {
        const map = mapRef.current;
        setIsEditMode(false);
        setEditJunctions([]);
        setEditDisabledIds([]);
        setEditHist([]);
        setEditHistPos(0);
        editHistRef.current = [];
        editHistPosRef.current = 0;

        if (map && map.getSource("edit-junctions")) {
            setFC(map, "edit-junctions", fcPoints([]));
        }
    };

    const undoEdit = () => {
        const pos = editHistPosRef.current;
        if (pos <= 0) return;
        const nextPos = pos - 1;
        const disabled = editHistRef.current[nextPos] ?? [];
        editHistPosRef.current = nextPos;
        editHistPosRef.current = nextPos;
        setEditHistPos(nextPos);
        applyEditDisabled(disabled, false);
    };

    const redoEdit = () => {
        const pos = editHistPosRef.current;
        const hist = editHistRef.current;
        if (pos >= hist.length - 1) return;
        const nextPos = pos + 1;
        const disabled = hist[nextPos] ?? [];
        setEditHistPos(nextPos);
        applyEditDisabled(disabled, false);
    };

    const resetEditToSystem = () => {
        const id = selectedRouteRef.current;
        const base = id === "A" ? tripleLinesBaseRef.current.A : id === "B" ? tripleLinesBaseRef.current.B : tripleLinesBaseRef.current.C;
        if (!base || base.length < 2) return;

        // restore base route + rebuild junctions from base
        updateSelectedRouteOnMap(base);

        const junctions = buildEditJunctions(base);
        setEditJunctions(junctions);
        setEditDisabledIds([]);
        setEditHist([[]]);
        setEditHistPos(0);
        editHistRef.current = [[]];
        editHistPosRef.current = 0;

        renderEditJunctionsOnMap(junctions, []);
    };


    // INIT MAP (once)
    useEffect(() => {
        ensureRTLPluginLoadedOnce();
        if (!mapDivRef.current) return;
        if (mapRef.current) return;

        const map = new maplibregl.Map({
            container: mapDivRef.current,
            style: STYLE_URL,
            center: [34.7818, 32.0853],
            zoom: 13.8,
        });

        // Silence missing images
        map.on("styleimagemissing", (e) => {
            const id = (((e as any)?.id as string | undefined) ?? "").toString();
            const transparent = new Uint8Array([0, 0, 0, 0]);
            try {
                if (id.trim() === "") {
                    if (!map.hasImage(" ")) map.addImage(" ", { width: 1, height: 1, data: transparent });
                    return;
                }
                if (!map.hasImage(id)) map.addImage(id, { width: 1, height: 1, data: transparent });
            } catch { }
        });

        map.addControl(new maplibregl.NavigationControl(), "top-left");
        map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

        map.on("load", () => {
            ensureOverlay(map);

            // init empty sources
            setFC(map, "measure-points", fcPoints([]));
            setFC(map, "measure-line", fcLine([]));
            setFC(map, "single-points", fcPoints([]));
            setFC(map, "single-line", fcLine([]));
            setFC(map, "start-end", fcPoints([]));
            setFC(map, "triple-a", fcLine([]));
            setFC(map, "triple-b", fcLine([]));
            setFC(map, "triple-c", fcLine([]));
            setFC(map, "triple-badge-points", fcPoints([]));
            setFC(map, "triple-badge-lines", fcLines([]));

            // segments sources init
            setFC(map, "triple-seg-points", fcPoints([]));
            setFC(map, "triple-seg-ticks", fcLines([]));

            // apply initial map settings
            applyLanguage(map, lang, originalTextFieldRef);
            toggleLayers(map, isRoadLayer, showRoads);
            toggleLayers(map, isTransitLayer, showTransit);
            toggleLayers(map, (l) => isLabelLayer(l) && !isPoiLayer(l), showLabels);
            toggleLayers(map, isPoiLayer, showPOI);

            emphasizeParks(map);

            // apply initial selected style
            applySelectedRouteStyles(map, selectedRoute);
            applySelectedTagStyle(map, selectedRoute);
            bringSelectedRouteAboveOthers(map, selectedRoute);

            // ---- DRAG badges (attach once) ----
            if (!(map as any).__badgeDragAttached) {
                (map as any).__badgeDragAttached = true;

                let draggingId: BadgeId | null = null;

                const setCursor = (c: string) => {
                    const canvas = map.getCanvas();
                    canvas.style.cursor = c;
                };

                const updateBadgeOnMap = (nextBadges: BadgePoint[]) => {
                    const a = anchorsRef.current;
                    setFC(map, "triple-badge-points", buildBadgeFC(nextBadges));
                    if (a.length) setFC(map, "triple-badge-lines", buildConnectorFC(map, a, nextBadges)); // ✅ border-leg
                };

                map.on("mousemove", (ev) => {
                    const feats = map.queryRenderedFeatures(ev.point, { layers: ["triple-badges", "triple-badge-text"] });
                    if (draggingId) {
                        setCursor("grabbing");
                        return;
                    }
                    setCursor(feats.length ? "grab" : "");
                });

                map.on("mousedown", (ev) => {
                    const feats = map.queryRenderedFeatures(ev.point, { layers: ["triple-badges", "triple-badge-text"] });
                    const f = feats?.[0] as any;
                    const id = (f?.properties?.id as BadgeId | undefined) ?? null;
                    if (!id) return;

                    draggingId = id;
                    try {
                        map.dragPan.disable();
                    } catch { }
                    setCursor("grabbing");
                    ev.preventDefault();
                });

                map.on("mousemove", (ev) => {
                    if (!draggingId) return;
                    const b = map.getBounds();
                    const ll: LngLat = [ev.lngLat.lng, ev.lngLat.lat];
                    const clamped = clampToBounds(ll, b, 0.08);

                    const cur = badgesRef.current;
                    const next = cur.map((x) => (x.id === draggingId ? { ...x, coord: clamped } : x));
                    setBadges(next);
                    updateBadgeOnMap(next);
                });

                const endDrag = () => {
                    if (!draggingId) return;
                    draggingId = null;
                    try {
                        map.dragPan.enable();
                    } catch { }
                    setCursor("");
                };

                map.on("mouseup", endDrag);
                map.on("mouseleave", endDrag);
                map.on("touchend", endDrag);
            }
        });

        map.on("click", (ev) => {
            const ll: LngLat = [ev.lngLat.lng, ev.lngLat.lat];
            const m = modeRef.current;


            // ✅ Edit mode: click junction circles to remove/restore segments (does not change start/end)
            if (m === "TRIPLE" && isEditModeRef.current) {
                const feats = map.queryRenderedFeatures(ev.point, { layers: ["edit-junction-circles", "edit-junction-text"] });
                const f = feats?.[0] as any;
                const id = (f?.properties?.id as string | undefined) ?? null;

                if (id) {
                    const j = editJunctionsRef.current.find((x) => x.id === id);
                    if (j && !j.locked) {
                        const prevDisabled = editDisabledIdsRef.current;
                        const nextDisabled = prevDisabled.includes(id) ? prevDisabled.filter((x) => x !== id) : [...prevDisabled, id];
                        applyEditDisabled(nextDisabled, true);
                    }
                }

                ev.preventDefault();
                return;
            }


            if (m === "MEASURE") {
                setMeasurePts((prev) => [...prev, ll]);
                return;
            }

            if (m === "SINGLE") {
                setSingleWaypoints((prev) => [...prev, ll]);
                return;
            }

            // TRIPLE: רק בחירת נקודות
            const s = startRef.current;
            const t = endRef.current;

            if (!s) {
                setStart(ll);
                setEnd(null);
                return;
            }
            if (!t) {
                setEnd(ll);
                return;
            }
            setStart(ll);
            setEnd(null);
        });

        mapRef.current = map;
        return () => {
            map.remove();
            mapRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Apply language when changed
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !map.isStyleLoaded()) return;
        applyLanguage(map, lang, originalTextFieldRef);
    }, [lang]);

    // Apply layer toggles when changed
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !map.isStyleLoaded()) return;
        toggleLayers(map, isRoadLayer, showRoads);
        toggleLayers(map, isTransitLayer, showTransit);
        toggleLayers(map, (l) => isLabelLayer(l) && !isPoiLayer(l), showLabels);
        toggleLayers(map, isPoiLayer, showPOI);
    }, [showRoads, showTransit, showLabels, showPOI]);

    // Render measure
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        if (!map.getSource("measure-points")) return;
        setFC(map, "measure-points", fcPoints(measurePts));
        setFC(map, "measure-line", fcLine(measurePts));
    }, [measurePts]);

    // Render single waypoints
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        if (!map.getSource("single-points")) return;
        setFC(map, "single-points", fcPoints(singleWaypoints));
    }, [singleWaypoints]);

    // Compute single route (אוטומטי כמו קודם)
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        if (!map.getSource("single-line")) return;

        if (singleWaypoints.length < 2) {
            setSingleLine([]);
            setFC(map, "single-line", fcLine([]));
            return;
        }

        let cancelled = false;
        (async () => {
            setIsRoutingSingle(true);
            const snapped = await osrmRoute(singleWaypoints);
            if (cancelled) return;
            if (snapped && snapped.length >= 2) {
                setSingleLine(snapped);
                setFC(map, "single-line", fcLine(snapped));
            } else {
                setSingleLine([]);
                setFC(map, "single-line", fcLine(singleWaypoints));
            }
            setIsRoutingSingle(false);
        })();

        return () => {
            cancelled = true;
            setIsRoutingSingle(false);
        };
    }, [singleWaypoints]);

    // Render start/end
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        if (!map.getSource("start-end")) return;

        const coords: LngLat[] = [];
        const props: any[] = [];
        if (start) {
            coords.push(start);
            props.push({ kind: "start", label: "מוצא" });
        }
        if (end) {
            coords.push(end);
            props.push({ kind: "end", label: "יעד" });
        }

        setFC(map, "start-end", fcPoints(coords, props));
    }, [start, end]);

    // כשמשנים נקודות — מנקים תוצאות עד "חישוב"
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        if (!map.isStyleLoaded()) return;
        if (!map.getSource("triple-a")) return;

        tripleLinesRef.current = { A: [], B: [], C: [] };

        if (!start || !end) {
            setFC(map, "triple-a", fcLine([]));
            setFC(map, "triple-b", fcLine([]));
            setFC(map, "triple-c", fcLine([]));
            setFC(map, "triple-badge-points", fcPoints([]));
            setFC(map, "triple-badge-lines", fcLines([]));
            setFC(map, "triple-seg-points", fcPoints([]));
            setFC(map, "triple-seg-ticks", fcLines([]));
            setBadges([]);
            setAnchors([]);
            return;
        }

        setFC(map, "triple-a", fcLine([]));
        setFC(map, "triple-b", fcLine([]));
        setFC(map, "triple-c", fcLine([]));
        setFC(map, "triple-badge-points", fcPoints([]));
        setFC(map, "triple-badge-lines", fcLines([]));
        setFC(map, "triple-seg-points", fcPoints([]));
        setFC(map, "triple-seg-ticks", fcLines([]));
        setBadges([]);
        setAnchors([]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [start, end]);

    // Compute triple routes + badges ONLY on "calcNonce"
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        if (!start || !end) return;
        if (!map.getSource("triple-a")) return;
        if (calcNonce <= 0) return;

        // ✅ NEW: after calculation - default selected route is A
        setSelectedRoute("A");

        let cancelled = false;

        (async () => {
            setIsRoutingTriple(true);

            const bounds = map.getBounds();
            const widthLng = Math.abs(bounds.getEast() - bounds.getWest());
            const heightLat = Math.abs(bounds.getNorth() - bounds.getSouth());
            const baseOffset = (0.06 + diversity * 0.10) * Math.min(widthLng, heightLat);

            const dx = end[0] - start[0];
            const dy = end[1] - start[1];

            const px = -dy,
                py = dx;
            const plen = Math.sqrt(px * px + py * py) || 1;
            const ux = px / plen,
                uy = py / plen;

            const dlen = Math.sqrt(dx * dx + dy * dy) || 1;
            const vx = dx / dlen,
                vy = dy / dlen;

            const mid: LngLat = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
            const via1: LngLat = [mid[0] + ux * baseOffset, mid[1] + uy * baseOffset];
            const via2: LngLat = [mid[0] - ux * baseOffset, mid[1] - uy * baseOffset];

            const rA = await osrmRoute([start, end]);
            const rB = await osrmRoute([start, via1, end]);
            const rC = await osrmRoute([start, via2, end]);

            if (cancelled) return;

            const a = rA ?? [start, end];
            const bLine = rB ?? [start, via1, end];
            const cLine = rC ?? [start, via2, end];

            // store for segmentation
            tripleLinesRef.current = { A: a, B: bLine, C: cLine };

            // snapshot base (system) solution for reset
            tripleLinesBaseRef.current = { A: a, B: bLine, C: cLine };
            if (isEditModeRef.current) {
                // if user recalculated - exit edit mode to avoid stale junctions
                stopEditMode();
            }


            setFC(map, "triple-a", fcLine(a));
            setFC(map, "triple-b", fcLine(bLine));
            setFC(map, "triple-c", fcLine(cLine));

            const anchorA = midpointOnLine(a);
            const anchorB = midpointOnLine(bLine);
            const anchorC = midpointOnLine(cLine);

            const newAnchors: AnchorPoint[] = [
                { id: "A", coord: anchorA },
                { id: "B", coord: anchorB },
                { id: "C", coord: anchorC },
            ];
            setAnchors(newAnchors);

            // shorter flag offset
            const side = baseOffset * 0.17;
            const along = baseOffset * 0.17;

            const makeBadge = (anchor: LngLat, sign: number, alongK: number) => {
                let p: LngLat = [anchor[0] + ux * side * sign + vx * along * alongK, anchor[1] + uy * side * sign + vy * along * alongK];
                p = clampToBounds(p, bounds, 0.07);
                return p;
            };

            let badgeA = makeBadge(anchorA, +1, 0.8);
            let badgeB = makeBadge(anchorB, -1, 0.8);
            let badgeC = makeBadge(anchorC, +1, -0.8);

            const thresh = baseOffset * 0.45;
            const nudge = (p: LngLat, k: number) => [p[0] + ux * side * 0.45 * k, p[1] + uy * side * 0.45 * k] as LngLat;

            if (euclidDeg(badgeA, badgeB) < thresh) badgeB = clampToBounds(nudge(badgeB, -1), bounds, 0.07);
            if (euclidDeg(badgeA, badgeC) < thresh) badgeC = clampToBounds(nudge(badgeC, +1), bounds, 0.07);
            if (euclidDeg(badgeB, badgeC) < thresh) badgeC = clampToBounds(nudge(badgeC, +1.4), bounds, 0.07);

            const newBadges: BadgePoint[] = [
                { id: "A", label: "א", coord: badgeA },
                { id: "B", label: "ב", coord: badgeB },
                { id: "C", label: "ג", coord: badgeC },
            ];
            setBadges(newBadges);

            setFC(map, "triple-badge-points", buildBadgeFC(newBadges));
            setFC(map, "triple-badge-lines", buildConnectorFC(map, newAnchors, newBadges)); // ✅ border-leg
            // ✅ Force: אחרי חישוב – ברירת מחדל מסלול א' + להציג מיד מקטעים למסלול א'
            setSelectedRoute("A");
            applySelectedRouteStyles(map, "A");

            const segLineA = a; // המסלול א' שחישבנו עכשיו
            if (!segLineA || segLineA.length < 2) {
                setFC(map, "triple-seg-points", fcPoints([]));
                setFC(map, "triple-seg-ticks", fcLines([]));
            } else {
                const { i1, i2 } = findSplitIndices3(segLineA);

                const segCum = cumulativeDistances(segLineA);
                const segTotal = segCum[segCum.length - 1] || 1;

                const d0 = 0;
                const dI1 = segCum[i1];
                const dI2 = segCum[i2];
                const dEnd = segTotal;

                const segMid1 = pointAtDistance(segLineA, segCum, (d0 + dI1) / 2);
                const segMid2 = pointAtDistance(segLineA, segCum, (dI1 + dI2) / 2);
                const segMid3 = pointAtDistance(segLineA, segCum, (dI2 + dEnd) / 2);

                const tickLenMeters = 18; // אותו אורך שכבר יש לך (אפשר לשנות)
                const makeTick = (idx: number) => {
                    const p = segLineA[idx];
                    const prevP = segLineA[Math.max(0, idx - 1)];
                    const nextP = segLineA[Math.min(segLineA.length - 1, idx + 1)];
                    const dir = localDirUnitMeters(prevP, nextP);
                    const px = -dir.uy;
                    const py = dir.ux;

                    const aP = offsetMeters(p, px * (tickLenMeters / 2), py * (tickLenMeters / 2));
                    const bP = offsetMeters(p, -px * (tickLenMeters / 2), -py * (tickLenMeters / 2));
                    return [aP, bP] as LngLat[];
                };

                const tick1 = makeTick(i1);
                const tick2 = makeTick(i2);

                setFC(
                    map,
                    "triple-seg-points",
                    fcPoints([segMid1, segMid2, segMid3], [{ label: "1" }, { label: "2" }, { label: "3" }])
                );

                setFC(map, "triple-seg-ticks", fcLines([{ coords: tick1 }, { coords: tick2 }]));
            }


            setIsRoutingTriple(false);
        })();

        return () => {
            cancelled = true;
            setIsRoutingTriple(false);
        };
    }, [calcNonce]); // רק "חישוב"

    // ✅ update selected route highlight + tag + layering + segments (ONLY for selected)
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        if (!map.isStyleLoaded()) return;

        applySelectedRouteStyles(map, selectedRoute);
        applySelectedTagStyle(map, selectedRoute);
        bringSelectedRouteAboveOthers(map, selectedRoute);


        // segments only for selected route
        const lines = tripleLinesRef.current;
        const line = selectedRoute === "A" ? lines.A : selectedRoute === "B" ? lines.B : lines.C;

        if (!line || line.length < 2) {
            setFC(map, "triple-seg-points", fcPoints([]));
            setFC(map, "triple-seg-ticks", fcLines([]));
            return;
        }

        const { i1, i2 } = findSplitIndices3(line);

        const cum = cumulativeDistances(line);
        const total = cum[cum.length - 1] || 1;

        const d0 = 0;
        const dI1 = cum[i1];
        const dI2 = cum[i2];
        const dEnd = total;

        const mid1 = pointAtDistance(line, cum, (d0 + dI1) / 2);
        const mid2 = pointAtDistance(line, cum, (dI1 + dI2) / 2);
        const mid3 = pointAtDistance(line, cum, (dI2 + dEnd) / 2);

        const tickLenMeters = 40;
        const makeTick = (idx: number) => {
            const p = line[idx];
            const prev = line[Math.max(0, idx - 1)];
            const next = line[Math.min(line.length - 1, idx + 1)];
            const dir = localDirUnitMeters(prev, next);
            const px = -dir.uy;
            const py = dir.ux;

            const a = offsetMeters(p, px * (tickLenMeters / 2), py * (tickLenMeters / 2));
            const b = offsetMeters(p, -px * (tickLenMeters / 2), -py * (tickLenMeters / 2));
            return [a, b] as LngLat[];
        };

        const tick1 = makeTick(i1);
        const tick2 = makeTick(i2);

        setFC(map, "triple-seg-points", fcPoints([mid1, mid2, mid3], [{ label: "1" }, { label: "2" }, { label: "3" }]));
        setFC(map, "triple-seg-ticks", fcLines([{ coords: tick1 }, { coords: tick2 }]));
    }, [selectedRoute, calcNonce]);

    // clears
    const clearMeasure = () => setMeasurePts([]);
    const clearSingle = () => {
        setSingleWaypoints([]);
        setSingleLine([]);
    };
    const clearTriple = () => {
        setStart(null);
        setEnd(null);
        setBadges([]);
        setAnchors([]);
        tripleLinesRef.current = { A: [], B: [], C: [] };
        const map = mapRef.current;
        if (!map) return;
        setFC(map, "triple-a", fcLine([]));
        setFC(map, "triple-b", fcLine([]));
        setFC(map, "triple-c", fcLine([]));
        setFC(map, "triple-badge-points", fcPoints([]));
        setFC(map, "triple-badge-lines", fcLines([]));
        setFC(map, "triple-seg-points", fcPoints([]));
        setFC(map, "triple-seg-ticks", fcLines([]));
    };

    return (
        <div style={{ display: "flex", width: "100vw", height: "100vh", overflow: "hidden" }}>
            {/* MAP */}
            <div style={{ flex: 1, position: "relative" }}>
                <div ref={mapDivRef} style={{ width: "100%", height: "100%" }} />
            </div>

            {/* RIGHT PANEL */}
            <div
                style={{
                    width: 420,
                    background: "#0b0f17",
                    color: "#e8eefc",
                    padding: 16,
                    borderLeft: "1px solid rgba(255,255,255,0.08)",
                    fontFamily: "system-ui, Arial",
                    direction: "rtl",
                    overflowY: "auto",
                }}
            >
                <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 6 }}>GeoVis Lab</div>
                <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 12 }}>
                    מצב נוכחי: <b>{mode === "TRIPLE" ? "3 מסלולים" : mode === "SINGLE" ? "מסלול יחיד" : "מדידה"}</b>
                </div>

                {/* Mode buttons */}
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
                    {[
                        { id: "TRIPLE" as const, label: "3 מסלולים" },
                        { id: "SINGLE" as const, label: "מסלול יחיד" },
                        { id: "MEASURE" as const, label: "מדידה" },
                    ].map((b) => (
                        <button
                            key={b.id}
                            onClick={() => setMode(b.id)}
                            style={{
                                padding: "10px 12px",
                                borderRadius: 12,
                                border: "1px solid rgba(255,255,255,0.15)",
                                background: mode === b.id ? "rgba(140,203,255,0.18)" : "transparent",
                                color: "#e8eefc",
                                cursor: "pointer",
                                fontWeight: 800,
                            }}
                        >
                            {b.label}
                        </button>
                    ))}
                </div>

                {/* Language */}
                <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                    <div style={{ fontWeight: 800, marginBottom: 10 }}>שפה במפה</div>
                    <select
                        value={lang}
                        onChange={(e) => setLang(e.target.value as Lang)}
                        style={{
                            width: "100%",
                            padding: 10,
                            borderRadius: 10,
                            border: "1px solid rgba(255,255,255,0.15)",
                            background: "rgba(0,0,0,0.25)",
                            color: "#e8eefc",
                            outline: "none",
                        }}
                    >
                        <option value="he">עברית (name:he)</option>
                        <option value="en">English (name:en)</option>
                        <option value="local">ברירת מחדל (name)</option>
                    </select>
                    <div style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>הערה: זה משנה את תוויות ה־basemap בלבד (לא “מוצא/יעד/א-ב-ג”).</div>
                </div>

                {/* Layers */}
                <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                    <div style={{ fontWeight: 800, marginBottom: 10 }}>שכבות</div>

                    {[
                        { label: "כבישים", v: showRoads, set: setShowRoads },
                        { label: "תחבורה ציבורית", v: showTransit, set: setShowTransit },
                        { label: "תוויות (שמות)", v: showLabels, set: setShowLabels },
                        { label: "POI", v: showPOI, set: setShowPOI },
                    ].map((x) => (
                        <label key={x.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 4px" }}>
                            <span style={{ fontWeight: 700 }}>{x.label}</span>
                            <input type="checkbox" checked={x.v} onChange={(e) => x.set(e.target.checked)} style={{ transform: "scale(1.2)" }} />
                        </label>
                    ))}
                </div>

                {/* Mode-specific tools */}
                {mode === "TRIPLE" && (
                    <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                        <div style={{ fontWeight: 900, marginBottom: 6 }}>3 מסלולים (א/ב/ג)</div>
                        <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 10 }}>
                            קליק 1 = <b>מוצא</b>, קליק 2 = <b>יעד</b>. <br />
                            <b>חישוב</b> מתבצע רק בלחיצה על הכפתור. אחרי חישוב אפשר <b>לגרור</b> את הדגלונים.
                        </div>

                        <div style={{ fontWeight: 800, marginBottom: 8 }}>מסלול נבחר</div>
                        <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                            {[
                                { id: "A" as const, label: "א" },
                                { id: "B" as const, label: "ב" },
                                { id: "C" as const, label: "ג" },
                            ].map((r) => (
                                <button
                                    key={r.id}
                                    onClick={() => setSelectedRoute(r.id)}
                                    style={{
                                        flex: 1,
                                        padding: "10px 12px",
                                        borderRadius: 12,
                                        border: "1px solid rgba(255,255,255,0.15)",
                                        background: selectedRoute === r.id ? "rgba(30,78,216,0.22)" : "transparent",
                                        color: "#e8eefc",
                                        cursor: "pointer",
                                        fontWeight: 900,
                                    }}
                                    title="בחירת מסלול תציג את חלוקת המקטעים רק עליו"
                                >
                                    {r.label}
                                </button>
                            ))}
                        </div>




                        {/* ✅ NEW: edit mode controls (selected route) */}
                        <button
                            onClick={() => (isEditMode ? stopEditMode() : startEditModeForSelected())}
                            disabled={isRoutingTriple}
                            style={{
                                width: "100%",
                                padding: "10px 12px",
                                borderRadius: 12,
                                border: "1px solid rgba(255,255,255,0.15)",
                                background: isEditMode ? "rgba(30,78,216,0.18)" : "transparent",
                                color: "#e8eefc",
                                cursor: isRoutingTriple ? "not-allowed" : "pointer",
                                fontWeight: 900,
                                opacity: isRoutingTriple ? 0.75 : 1,
                                marginBottom: 10,
                            }}
                            title="מצב עריכה למסלול הנבחר: עיגולים בצמתים להסרה/החזרה של קטעים"
                        >
                            {isEditMode ? "סיום עריכה" : "עריכת מסלול נבחר"}
                        </button>

                        {isEditMode && (
                            <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                                <button
                                    onClick={undoEdit}
                                    disabled={editHistPos <= 0}
                                    style={{
                                        flex: 1,
                                        padding: "10px 12px",
                                        borderRadius: 12,
                                        border: "1px solid rgba(255,255,255,0.15)",
                                        background: "transparent",
                                        color: "#e8eefc",
                                        cursor: editHistPos <= 0 ? "not-allowed" : "pointer",
                                        fontWeight: 900,
                                        opacity: editHistPos <= 0 ? 0.6 : 1,
                                    }}
                                >
                                    חזור
                                </button>
                                <button
                                    onClick={redoEdit}
                                    disabled={editHistPos >= editHist.length - 1}
                                    style={{
                                        flex: 1,
                                        padding: "10px 12px",
                                        borderRadius: 12,
                                        border: "1px solid rgba(255,255,255,0.15)",
                                        background: "transparent",
                                        color: "#e8eefc",
                                        cursor: editHistPos >= editHist.length - 1 ? "not-allowed" : "pointer",
                                        fontWeight: 900,
                                        opacity: editHistPos >= editHist.length - 1 ? 0.6 : 1,
                                    }}
                                >
                                    קדימה
                                </button>
                                <button
                                    onClick={resetEditToSystem}
                                    style={{
                                        flex: 1,
                                        padding: "10px 12px",
                                        borderRadius: 12,
                                        border: "1px solid rgba(255,255,255,0.15)",
                                        background: "transparent",
                                        color: "#e8eefc",
                                        cursor: "pointer",
                                        fontWeight: 900,
                                    }}
                                    title="חזור לפתרון המקורי של המערכת למסלול הנבחר"
                                >
                                    איפוס
                                </button>
                            </div>
                        )}

                        {isEditMode && (
                            <div style={{ fontSize: 12, opacity: 0.78, marginBottom: 10, lineHeight: 1.35 }}>
                                מצב עריכה פעיל: לחץ על עיגול בצומת כדי להסיר/להחזיר קטעים. המערכת תבנה מחדש מסלול חוקי.
                            </div>
                        )}
                        <div style={{ fontWeight: 800, marginBottom: 8 }}>שונות</div>
                        <input type="range" min={0} max={1} step={0.01} value={diversity} onChange={(e) => setDiversity(parseFloat(e.target.value))} style={{ width: "100%" }} />
                        <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>{Math.round(diversity * 100)}%</div>

                        <button
                            onClick={() => setCalcNonce((n) => n + 1)}
                            disabled={!canTriple || isRoutingTriple}
                            style={{
                                marginTop: 10,
                                width: "100%",
                                padding: "10px 12px",
                                borderRadius: 12,
                                border: "1px solid rgba(255,255,255,0.15)",
                                background: !canTriple ? "rgba(255,255,255,0.06)" : "rgba(140,203,255,0.18)",
                                color: "#e8eefc",
                                cursor: !canTriple ? "not-allowed" : "pointer",
                                fontWeight: 900,
                                opacity: isRoutingTriple ? 0.75 : 1,
                            }}
                            title={!canTriple ? "בחר מוצא ויעד כדי לאפשר חישוב" : "חשב מסלולים"}
                        >
                            {isRoutingTriple ? "מחשב…" : "חישוב"}
                        </button>

                        <button
                            onClick={clearTriple}
                            style={{
                                marginTop: 10,
                                width: "100%",
                                padding: "10px 12px",
                                borderRadius: 12,
                                border: "1px solid rgba(255,255,255,0.15)",
                                background: "transparent",
                                color: "#e8eefc",
                                cursor: "pointer",
                                fontWeight: 900,
                            }}
                        >
                            ניקוי 3 מסלולים
                        </button>

                        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>הערה: חלוקת מקטעים (1/2/3 + טיקים) מוצגת רק למסלול שנבחר.</div>
                    </div>
                )}

                {mode === "SINGLE" && (
                    <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                        <div style={{ fontWeight: 900, marginBottom: 6 }}>מסלול יחיד</div>
                        <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 10 }}>
                            כל קליק מוסיף waypoint. המערכת מנסה להצמיד ל־OSRM. אם נופל — קו ישר (fallback).
                        </div>

                        {isRoutingSingle && <div style={{ marginTop: 10, fontSize: 13, fontWeight: 900 }}>מחשב מסלול…</div>}

                        <div style={{ marginTop: 10, fontSize: 13 }}>
                            Waypoints: <b>{singleWaypoints.length}</b>
                        </div>
                        <div style={{ marginTop: 6, fontSize: 13 }}>
                            אורך מסלול: <b>{fmtDistance(singleDist)}</b>
                        </div>

                        <button
                            onClick={clearSingle}
                            style={{
                                marginTop: 10,
                                width: "100%",
                                padding: "10px 12px",
                                borderRadius: 12,
                                border: "1px solid rgba(255,255,255,0.15)",
                                background: "transparent",
                                color: "#e8eefc",
                                cursor: "pointer",
                                fontWeight: 900,
                            }}
                        >
                            ניקוי מסלול יחיד
                        </button>
                    </div>
                )}

                {mode === "MEASURE" && (
                    <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                        <div style={{ fontWeight: 900, marginBottom: 6 }}>מדידה</div>
                        <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 10 }}>קליקים מוסיפים נקודות מדידה (חישוב גאודזי).</div>

                        <div style={{ fontSize: 13 }}>
                            נקודות: <b>{measurePts.length}</b>
                        </div>
                        <div style={{ marginTop: 6, fontSize: 13 }}>
                            מרחק: <b>{fmtDistance(measureDist)}</b>
                        </div>

                        <button
                            onClick={clearMeasure}
                            style={{
                                marginTop: 10,
                                width: "100%",
                                padding: "10px 12px",
                                borderRadius: 12,
                                border: "1px solid rgba(255,255,255,0.15)",
                                background: "transparent",
                                color: "#e8eefc",
                                cursor: "pointer",
                                fontWeight: 900,
                            }}
                        >
                            ניקוי מדידה
                        </button>
                    </div>
                )}

                <div style={{ fontSize: 12, opacity: 0.65 }}>טיפ: בחר מסלול א/ב/ג בפאנל כדי להציג עליו את חלוקת המקטעים.</div>
            </div>
        </div>
    );
}
