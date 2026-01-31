import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

type LngLat = [number, number];
type Mode = "TRIPLE" | "SINGLE" | "MEASURE";
type Lang = "he" | "en" | "local";

// NOTE: keep this in sync with your local key (you mentioned updating it).
const MAPTILER_KEY = "3IYmgQ2XRtJQCLYAdMs6";
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


// ✅ Scenic (parks) legend colors (requested)
const PARK_FILL = "#00FF66"; // ירוק בוהק
const PARK_OPACITY = 0.95;
const PARK_OUTLINE = "rgba(0,90,50,0.9)";

function isParkLikeLayer(l: any) {
    const id = String(l?.id ?? "").toLowerCase();
    const type = String(l?.type ?? "");
    const srcLayer = String((l as any)?.["source-layer"] ?? "").toLowerCase();

    // נזהה גם לפי id וגם לפי source-layer (כדי לעבוד על כמה שיותר וריאציות של style)
    const looksLikePark =
        id.includes("park") ||
        id.includes("leisure") ||
        id.includes("garden") ||
        id.includes("wood") ||
        id.includes("forest") ||
        srcLayer.includes("park") ||
        // srcLayer.includes("landuse") ||
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


// ✅ Spatial categories styling
const CAT_TRAFFIC_COLOR = "#FF0022"; // אדום בוהק
const CAT_TOLL_COLOR = "#FFE100"; // צהוב בוהק
const CAT_TOLL_LABEL_TEXT = "₪";
const CAT_COMM_FILL = "rgba(170,60,255,0.28)";
const CAT_COMM_OUTLINE = "rgba(170,60,255,0.65)";

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


function fcPolygons(polys: { coords: LngLat[]; props?: Record<string, any> }[]) {
    return {
        type: "FeatureCollection",
        features: polys.map((p) => ({
            type: "Feature",
            geometry: { type: "Polygon", coordinates: [p.coords] },
            properties: p.props ?? {},
        })),
    } as any;
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
        id.startsWith("triple-") ||
        id.startsWith("edit-")
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

// Extract visible road geometries in a geographic bbox.
// We rely on rendered features (layer ids) so this works with MapTiler vector styles without hardcoding source-layer names.
// Note: If the bbox is outside the current viewport, this may return fewer roads (because they're not rendered).
function roadLinesInBbox(map: maplibregl.Map, bbox: { west: number; south: number; east: number; north: number }): LngLat[][] {
    const style = map.getStyle() as any;
    const layers: any[] = Array.isArray(style?.layers) ? style.layers : [];
    const roadLayerIds = layers
        .filter((l) => isRoadLayer(l))
        .map((l) => String(l.id || ""))
        .filter((id) => id.length > 0);

    if (!roadLayerIds.length) return [];

    // Convert geographic bbox to screen bbox for queryRenderedFeatures.
    const p1 = map.project([bbox.west, bbox.north] as any) as any;
    const p2 = map.project([bbox.east, bbox.south] as any) as any;
    const minX = Math.min(p1.x, p2.x);
    const maxX = Math.max(p1.x, p2.x);
    const minY = Math.min(p1.y, p2.y);
    const maxY = Math.max(p1.y, p2.y);

    let feats: any[] = [];
    try {
        feats = map.queryRenderedFeatures(
            [
                [minX, minY],
                [maxX, maxY],
            ] as any,
            { layers: roadLayerIds.slice(0, 30) }
        ) as any[];
    } catch {
        feats = [];
    }

    const out: LngLat[][] = [];
    const seen = new Set<string>();
    for (const f of feats) {
        const g = f?.geometry;
        if (!g) continue;
        const t = g.type;

        const pushLine = (coords: any) => {
            if (!Array.isArray(coords) || coords.length < 2) return;
            const line = coords as LngLat[];
            // basic de-dupe by endpoints (rounded)
            const a = line[0];
            const b = line[line.length - 1];
            const key = `${a[0].toFixed(5)},${a[1].toFixed(5)}-${b[0].toFixed(5)},${b[1].toFixed(5)}`;
            if (seen.has(key)) return;
            if (polylineMeters(line) < 80) return;
            seen.add(key);
            out.push(line);
        };

        if (t === "LineString") {
            pushLine(g.coordinates);
        } else if (t === "MultiLineString") {
            const parts = g.coordinates;
            if (Array.isArray(parts)) for (const part of parts) pushLine(part);
        }

        if (out.length >= 80) break;
    }

    return out;
}
function isTransitLayer(l: any) {
    const id = String(l.id || "").toLowerCase();
    return !isOverlayLayerId(String(l.id || "")) && (id.includes("transit") || id.includes("rail") || id.includes("subway") || id.includes("train"));
}

// ---- Language switching on basemap labels ----
function applyLanguage(map: maplibregl.Map, lang: Lang, originalRef: { current: Record<string, any> }) {
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


function rand01() {
    return Math.random();
}
function randBetween(min: number, max: number) {
    return min + (max - min) * rand01();
}
function randInt(min: number, max: number) {
    // inclusive
    return Math.floor(randBetween(min, max + 1));
}

function bboxFromLines(lines: LngLat[][]): { west: number; south: number; east: number; north: number } | null {
    const all = lines.flat();
    if (!all.length) return null;
    let west = all[0][0],
        east = all[0][0],
        south = all[0][1],
        north = all[0][1];
    for (const p of all) {
        west = Math.min(west, p[0]);
        east = Math.max(east, p[0]);
        south = Math.min(south, p[1]);
        north = Math.max(north, p[1]);
    }
    return { west, south, east, north };
}
function expandBbox(b: { west: number; south: number; east: number; north: number }, padRatio = 0.1) {
    const w = b.east - b.west;
    const h = b.north - b.south;
    return {
        west: b.west - w * padRatio,
        east: b.east + w * padRatio,
        south: b.south - h * padRatio,
        north: b.north + h * padRatio,
    };
}
function randomPointInBbox(b: { west: number; south: number; east: number; north: number }): LngLat {
    return [randBetween(b.west, b.east), randBetween(b.south, b.north)];
}

// Return a polyline segment between distances [d0, d1] (meters) along a line.
function subLineBetweenMeters(line: LngLat[], d0: number, d1: number): LngLat[] {
    if (line.length < 2) return line.slice();
    const cum = cumulativeDistances(line);
    const total = cum[cum.length - 1] || 1;
    const a = Math.max(0, Math.min(total, Math.min(d0, d1)));
    const b = Math.max(0, Math.min(total, Math.max(d0, d1)));
    const pts: LngLat[] = [];
    pts.push(pointAtDistance(line, cum, a));
    for (let i = 0; i < cum.length; i++) {
        if (cum[i] > a && cum[i] < b) pts.push(line[i]);
    }
    pts.push(pointAtDistance(line, cum, b));
    return pts;
}

function pointsAlongLineEvery(line: LngLat[], stepMeters: number): LngLat[] {
    if (line.length < 2) return [];
    const cum = cumulativeDistances(line);
    const total = cum[cum.length - 1] || 0;
    if (total <= 0) return [];
    const pts: LngLat[] = [];
    for (let d = 0; d <= total; d += stepMeters) {
        pts.push(pointAtDistance(line, cum, d));
    }
    return pts;
}

function circleRing(center: LngLat, radiusMeters: number, steps = 64): LngLat[] {
    const lat = center[1];
    const mx = metersPerDegLng(lat);
    const my = metersPerDegLat();
    const ring: LngLat[] = [];
    for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const dx = Math.cos(a) * radiusMeters;
        const dy = Math.sin(a) * radiusMeters;
        ring.push([center[0] + dx / (mx || 1), center[1] + dy / (my || 1)]);
    }
    return ring;
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

    // ✅ Route edit mode (junction markers)
    addSrc("edit-junctions");

    // ✅ Spatial categories sources
    addSrc("cat-traffic");
    addSrc("cat-toll");
    addSrc("cat-toll-labels");
    addSrc("cat-comm");

    const fontStack = pickTextFontFromStyle(map);

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


    // ✅ Spatial categories layers
    // Communication zones (below routes)
    if (!map.getLayer("cat-comm-fill")) {
        map.addLayer(
            {
                id: "cat-comm-fill",
                type: "fill",
                source: "cat-comm",
                paint: {
                    "fill-color": CAT_COMM_FILL,
                    "fill-opacity": 1,
                },
            },
            "triple-a-outline"
        );
    }
    if (!map.getLayer("cat-comm-outline")) {
        map.addLayer(
            {
                id: "cat-comm-outline",
                type: "line",
                source: "cat-comm",
                layout: { "line-cap": "round", "line-join": "round" },
                paint: {
                    "line-color": CAT_COMM_OUTLINE,
                    "line-width": 2,
                    "line-opacity": 1,
                },
            },
            "triple-a-outline"
        );
    }

    // Traffic (above routes)
    if (!map.getLayer("cat-traffic-glow")) {
        map.addLayer({
            id: "cat-traffic-glow",
            type: "line",
            source: "cat-traffic",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
                "line-color": CAT_TRAFFIC_COLOR,
                "line-width": 10,
                "line-opacity": 0.28,
                "line-blur": 1.2,
            },
        });
    }
    if (!map.getLayer("cat-traffic")) {
        map.addLayer({
            id: "cat-traffic",
            type: "line",
            source: "cat-traffic",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
                "line-color": CAT_TRAFFIC_COLOR,
                "line-width": 6,
                "line-opacity": 0.95,
                "line-dasharray": [1.2, 1.2],
            },
        });
    }

    // Toll (two bright side stripes + repeated ₪ tags)
    if (!map.getLayer("cat-toll-left")) {
        map.addLayer({
            id: "cat-toll-left",
            type: "line",
            source: "cat-toll",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
                "line-color": CAT_TOLL_COLOR,
                "line-width": 3.5,
                "line-opacity": 0.95,
                "line-offset": 5,
            },
        });
    }
    if (!map.getLayer("cat-toll-right")) {
        map.addLayer({
            id: "cat-toll-right",
            type: "line",
            source: "cat-toll",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
                "line-color": CAT_TOLL_COLOR,
                "line-width": 3.5,
                "line-opacity": 0.95,
                "line-offset": -5,
            },
        });
    }

    if (!map.getLayer("cat-toll-label-bg")) {
        map.addLayer({
            id: "cat-toll-label-bg",
            type: "circle",
            source: "cat-toll-labels",
            paint: {
                "circle-radius": 10,
                "circle-color": CAT_TOLL_COLOR,
                "circle-opacity": 0.95,
                "circle-stroke-width": 2,
                "circle-stroke-color": "#0b1220",
                "circle-translate": [
                    "case",
                    ["==", ["get", "side"], "left"],
                    ["literal", [-16, 0]],
                    ["literal", [16, 0]],
                ],
            },
        });
    }
    if (!map.getLayer("cat-toll-label-text")) {
        map.addLayer({
            id: "cat-toll-label-text",
            type: "symbol",
            source: "cat-toll-labels",
            layout: {
                "text-field": CAT_TOLL_LABEL_TEXT,
                "text-font": fontStack,
                "text-size": 14,
                "text-allow-overlap": true,
                "text-ignore-placement": true,
                "text-offset": [
                    "case",
                    ["==", ["get", "side"], "left"],
                    ["literal", [-1.1, 0]],
                    ["literal", [1.1, 0]],
                ],
            },
            paint: {
                "text-color": "#0b1220",
                "text-halo-color": "#ffffff",
                "text-halo-width": 0.8,
            },
        });
    }

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


    // ✅ Route edit mode junction markers (click to remove segments)
    if (!map.getLayer("edit-junction-circles")) {
        map.addLayer({
            id: "edit-junction-circles",
            type: "circle",
            source: "edit-junctions",
            paint: {
                "circle-radius": 8,
                "circle-color": [
                    "case",
                    ["boolean", ["get", "disabled"], false],
                    "rgba(148,163,184,0.85)", // disabled (gray)
                    "rgba(255,255,255,0.95)"  // active
                ],
                "circle-stroke-width": 3,
                "circle-stroke-color": "#0b1220",
                "circle-opacity": 1,
            },
        });
    }

    if (!map.getLayer("edit-junction-text")) {
        map.addLayer({
            id: "edit-junction-text",
            type: "symbol",
            source: "edit-junctions",
            layout: {
                "text-field": ["to-string", ["get", "label"]],
                "text-font": fontStack,
                "text-size": 12,
                "text-anchor": "center",
                "text-allow-overlap": true,
                "text-ignore-placement": true,
                "text-optional": true,
            },
            paint: {
                "text-color": "#0b1220",
                "text-halo-color": "#ffffff",
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

    // edit junctions above route
    moveSafe("edit-junction-circles");
    moveSafe("edit-junction-text");

    // מוצא/יעד: רקע -> טקסט
    moveSafe("start-label-bg");
    moveSafe("end-label-bg");
    moveSafe("start-label");
    moveSafe("end-label");

    // מרקרים מעל
    moveSafe("start-circle");
    moveSafe("end-pin");
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


// ---------- Route edit mode helpers ----------
type EditJunction = {
    id: string;
    coord: LngLat;
    idx: number;   // order (for labels)
    dist: number;  // meters from start along the base line (approx)
    angle: number; // turn severity (deg)
};

// Select "junction-like" points (major turns) along a route so user can remove unnecessary detours.
function buildEditJunctions(line: LngLat[]): EditJunction[] {
    if (!line || line.length < 3) return [];

    const cum = cumulativeDistances(line);
    const total = cum[cum.length - 1] || 1;
    const ang = turnAngles(line);

    // thresholds
    const minAngle = 20;         // ignore small wiggles
    const minSpacingFrac = 0.10; // avoid too-dense points
    const minSpacing = total * minSpacingFrac;

    // collect candidates by angle
    const candidates: { i: number; a: number }[] = [];
    for (let i = 1; i < line.length - 1; i++) {
        const a = ang[i] || 0;
        if (a >= minAngle) candidates.push({ i, a });
    }
    candidates.sort((x, y) => y.a - x.a);

    // greedy pick with spacing constraint
    const picked: number[] = [];
    for (const c of candidates) {
        if (picked.length >= 14) break;
        const d = cum[c.i];
        const tooClose = picked.some((j) => Math.abs(cum[j] - d) < minSpacing);
        if (!tooClose) picked.push(c.i);
    }

    // Always add a couple of evenly spaced points if we still have too few
    const ensureByFrac = (f: number) => {
        const target = total * f;
        let best = 1;
        let bestErr = Infinity;
        for (let i = 1; i < line.length - 1; i++) {
            const err = Math.abs(cum[i] - target);
            if (err < bestErr) {
                bestErr = err;
                best = i;
            }
        }
        if (!picked.includes(best)) picked.push(best);
    };
    if (picked.length < 5) {
        ensureByFrac(0.25);
        ensureByFrac(0.50);
        ensureByFrac(0.75);
    }

    picked.sort((a, b) => cum[a] - cum[b]);

    return picked.map((i, k) => ({
        id: `J${k + 1}_${i}`,
        coord: line[i],
        idx: k + 1,
        dist: cum[i],
        angle: ang[i] || 0,
    }));
}

function uniqueBy<T, K>(arr: T[], key: (x: T) => K): T[] {
    const seen = new Set<K>();
    const out: T[] = [];
    for (const x of arr) {
        const k = key(x);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(x);
    }
    return out;
}

// Reduce number of points OSRM sees (keep route legal + stable)
function simplifyLine(line: LngLat[], maxPts = 10): LngLat[] {
    if (line.length <= maxPts) return line;

    const total = polylineMeters(line);
    if (!Number.isFinite(total) || total <= 0) return [line[0], line[line.length - 1]];

    const step = total / (maxPts - 1);
    const cum = cumulativeDistances(line);

    const keep: LngLat[] = [line[0]];
    let nextDist = step;

    for (let i = 1; i < line.length - 1; i++) {
        if (cum[i] >= nextDist) {
            keep.push(line[i]);
            nextDist += step;
        }
        if (keep.length >= maxPts - 1) break;
    }
    keep.push(line[line.length - 1]);

    // remove duplicates / super-close
    return uniqueBy(keep, (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`);
}

function renderEditJunctionsOnMap(
    map: maplibregl.Map,
    junctions: EditJunction[],
    disabledIds: Set<string>
) {
    const coords = junctions.map((j) => j.coord);
    const props = junctions.map((j) => ({
        jid: j.id,
        label: j.idx, // show order number
        disabled: disabledIds.has(j.id),
    }));
    setFC(map, "edit-junctions", fcPoints(coords, props));
}

async function applyEditDisabled(
    baseLine: LngLat[],
    junctions: EditJunction[],
    disabledIds: Set<string>
): Promise<LngLat[]> {
    if (!baseLine || baseLine.length < 2) return baseLine;

    // keep only enabled junction coords (ordered)
    const keepJ = junctions.filter((j) => !disabledIds.has(j.id));
    const keepCoords = [baseLine[0], ...keepJ.map((j) => j.coord), baseLine[baseLine.length - 1]];

    const simplified = simplifyLine(keepCoords, 10);

    const snapped = await osrmRoute(simplified);
    const newLine = snapped && snapped.length >= 2 ? snapped : simplified;

    return newLine;
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
    const before = map.getLayer("cat-traffic") ? "cat-traffic" : map.getLayer("triple-badge-lines") ? "triple-badge-lines" : undefined;

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

// =========================
// Route scoring (real data)
// =========================

type SegmentScore = {
    route: BadgeId;
    segment: 1 | 2 | 3;
    lengthM: number;
    timeS: number;
    speedScore: number;
    economyScore: number;
    scenicScore: number;
    commScore: number;
    fracTraffic: number;
    fracToll: number;
    fracScenic: number;
    fracComm: number;
};

type RouteScore = {
    route: BadgeId;
    segments: SegmentScore[];
    totalLengthM: number;
    totalTimeS: number;
};

function clamp01(x: number) {
    return Math.max(0, Math.min(1, x));
}

// Point-to-segment distance in meters (fast local equirect approximation)
function pointToSegmentDistanceMeters(p: LngLat, a: LngLat, b: LngLat): number {
    const lat = (p[1] + a[1] + b[1]) / 3;
    const mx = metersPerDegLng(lat);
    const my = metersPerDegLat();

    const ax = 0;
    const ay = 0;
    const bx = (b[0] - a[0]) * mx;
    const by = (b[1] - a[1]) * my;
    const px = (p[0] - a[0]) * mx;
    const py = (p[1] - a[1]) * my;

    const bb = bx * bx + by * by;
    if (bb <= 1e-9) return Math.hypot(px - ax, py - ay);

    const t = Math.max(0, Math.min(1, (px * bx + py * by) / bb));
    const qx = t * bx;
    const qy = t * by;
    return Math.hypot(px - qx, py - qy);
}

function pointToPolylineMinDistanceMeters(p: LngLat, line: LngLat[]): number {
    if (line.length < 2) return Infinity;
    let best = Infinity;
    for (let i = 0; i < line.length - 1; i++) {
        const d = pointToSegmentDistanceMeters(p, line[i], line[i + 1]);
        if (d < best) best = d;
        if (best <= 0.5) return best;
    }
    return best;
}

function isNearAnyPolyline(p: LngLat, lines: LngLat[][], thresholdM: number): boolean {
    for (const ln of lines) {
        if (pointToPolylineMinDistanceMeters(p, ln) <= thresholdM) return true;
    }
    return false;
}

function ringCenter(ring: LngLat[]): LngLat {
    if (!ring.length) return [0, 0];
    let sx = 0, sy = 0;
    for (const c of ring) { sx += c[0]; sy += c[1]; }
    return [sx / ring.length, sy / ring.length];
}

function isInsideAnyCommZone(
    p: LngLat,
    zones: { ring: LngLat[]; radiusM: number }[]
): boolean {
    for (const z of zones) {
        const c = ringCenter(z.ring);
        if (haversineMeters(p, c) <= z.radiusM) return true;
    }
    return false;
}

function metersToPixelsAt(map: maplibregl.Map, p: LngLat, meters: number): number {
    const p0 = map.project(p as any);
    const p1 = map.project(offsetMeters(p, meters, 0) as any);
    return Math.hypot(p1.x - p0.x, p1.y - p0.y);
}

function getParkFillLayerIds(map: maplibregl.Map): string[] {
    const layers = map.getStyle()?.layers ?? [];
    return layers
        .filter((l: any) => l?.type === "fill" && isParkLikeLayer(l))
        .map((l: any) => l.id);
}

function isNearParkRendered(
    map: maplibregl.Map,
    p: LngLat,
    parkLayerIds: string[],
    radiusM = 20
): boolean {
    if (!parkLayerIds.length) return false;
    const pt = map.project(p as any);
    const r = metersToPixelsAt(map, p, radiusM);
    const bbox: [[number, number], [number, number]] = [
        [pt.x - r, pt.y - r],
        [pt.x + r, pt.y + r],
    ];
    try {
        const feats = map.queryRenderedFeatures(bbox as any, {
            layers: parkLayerIds.slice(0, 50),
        });
        return (feats ?? []).length > 0;
    } catch {
        return false;
    }
}

function split3ByIndices(line: LngLat[]): [LngLat[], LngLat[], LngLat[]] {
    const { i1, i2 } = findSplitIndices3(line);
    const s1 = line.slice(0, i1 + 1);
    const s2 = line.slice(i1, i2 + 1);
    const s3 = line.slice(i2);
    return [s1, s2, s3];
}

function computeRouteScores(
    map: maplibregl.Map,
    tripleLines: Record<BadgeId, LngLat[]>,
    trafficSegs: { coords: LngLat[] }[],
    tollSegs: { coords: LngLat[] }[],
    commZones: { ring: LngLat[]; radiusM: number }[],
    parkLayerIds: string[]
): RouteScore[] {
    const routes: BadgeId[] = ["A", "B", "C"];

    const trafficLines = trafficSegs.map((s) => s.coords);
    const tollLines = tollSegs.map((s) => s.coords);

    const SPEED_FREE_KMH = 30;
    const SPEED_TRAFFIC_KMH = 10;
    const vFree = (SPEED_FREE_KMH * 1000) / 3600;
    const vTraffic = (SPEED_TRAFFIC_KMH * 1000) / 3600;

    const SAMPLE_STEP_M = 60; // keep it fast enough

    function scoreSegment(route: BadgeId, segNo: 1 | 2 | 3, segLine: LngLat[]): SegmentScore {
        // sample as intervals; evaluate midpoint per interval for weighted fraction
        let samples = pointsAlongLineEvery(segLine, SAMPLE_STEP_M);
        if (samples.length < 2) {
            const a = segLine[0];
            const b = segLine[segLine.length - 1];
            samples = a && b ? [a, b] : [];
        }

        let total = 0;
        let lenTraffic = 0;
        let lenToll = 0;
        let lenComm = 0;
        let lenScenic = 0;

        for (let i = 0; i < samples.length - 1; i++) {
            const a = samples[i];
            const b = samples[i + 1];
            const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            const L = haversineMeters(a, b);
            total += L;

            const inTraffic = isNearAnyPolyline(mid, trafficLines, 12);
            const inToll = isNearAnyPolyline(mid, tollLines, 12);
            const inComm = isInsideAnyCommZone(mid, commZones);
            const inScenic = isNearParkRendered(map, mid, parkLayerIds, 20);

            if (inTraffic) lenTraffic += L;
            if (inToll) lenToll += L;
            if (inComm) lenComm += L;
            if (inScenic) lenScenic += L;
        }

        const lengthM = total > 0 ? total : polylineMeters(segLine);

        const fracTraffic = total > 0 ? clamp01(lenTraffic / total) : 0;
        const fracToll = total > 0 ? clamp01(lenToll / total) : 0;
        const fracComm = total > 0 ? clamp01(lenComm / total) : 0;
        const fracScenic = total > 0 ? clamp01(lenScenic / total) : 0;

        // time integration: traffic part at 10 km/h, rest at 30 km/h
        const trafficM = lengthM * fracTraffic;
        const freeM = Math.max(0, lengthM - trafficM);
        const timeS = trafficM / vTraffic + freeM / vFree;

        // scores
        const speedScore = 100 - 70 * fracTraffic;        // 100..30
        const economyScore = 100 * (1 - fracToll);        // 100..0
        const scenicScore = 100 * fracScenic;             // 0..100
        const commScore = 30 + 70 * fracComm;             // 30..100

        return {
            route,
            segment: segNo,
            lengthM,
            timeS,
            speedScore,
            economyScore,
            scenicScore,
            commScore,
            fracTraffic,
            fracToll,
            fracScenic,
            fracComm,
        };
    }

    return routes.map((r) => {
        const line = tripleLines[r] ?? [];
        if (line.length < 2) {
            return { route: r, segments: [], totalLengthM: 0, totalTimeS: 0 };
        }

        const [s1, s2, s3] = split3ByIndices(line);
        const segs: SegmentScore[] = [
            scoreSegment(r, 1, s1),
            scoreSegment(r, 2, s2),
            scoreSegment(r, 3, s3),
        ];

        const totalLengthM = segs.reduce((a, s) => a + s.lengthM, 0);
        const totalTimeS = segs.reduce((a, s) => a + s.timeS, 0);

        return { route: r, segments: segs, totalLengthM, totalTimeS };
    });
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


    // ✅ TRIPLE pick arm: allow start/end clicks only when the "3 מסלולים" button is pressed
    const [triplePickArmed, setTriplePickArmed] = useState(false);
    const triplePickArmedRef = useRef(false);
    useEffect(() => {
        triplePickArmedRef.current = triplePickArmed;
    }, [triplePickArmed]);
    useEffect(() => {
        // switching away disarms
        if (mode !== "TRIPLE") setTriplePickArmed(false);
    }, [mode]);

    // ✅ Spatial categories availability (only after routes are computed)
    const [tripleComputed, setTripleComputed] = useState(false);

    const [showCatTraffic, setShowCatTraffic] = useState(true);
    const [showCatToll, setShowCatToll] = useState(true);
    const [showCatComm, setShowCatComm] = useState(true);

    // Category configs (ranges + per-category diversity)
    const [catGlobalDiversity, setCatGlobalDiversity] = useState(0.35);

    const [catTrafficCount, setCatTrafficCount] = useState(3);
    const [catTrafficLenMin, setCatTrafficLenMin] = useState(50);
    const [catTrafficLenMax, setCatTrafficLenMax] = useState(600);
    const [catTrafficDiv, setCatTrafficDiv] = useState(0.35);

    const [catTollCount, setCatTollCount] = useState(2);
    const [catTollLenMin, setCatTollLenMin] = useState(80);
    const [catTollLenMax, setCatTollLenMax] = useState(700);
    const [catTollDiv, setCatTollDiv] = useState(0.35);

    const [catCommCount, setCatCommCount] = useState(2);
    const [catCommDiaMin, setCatCommDiaMin] = useState(200);
    const [catCommDiaMax, setCatCommDiaMax] = useState(600);
    const [catCommDiv, setCatCommDiv] = useState(0.35);

    // Generated entities (for scoring later)
    const [catTrafficSegs, setCatTrafficSegs] = useState<{ id: string; coords: LngLat[] }[]>([]);
    const [catTollSegs, setCatTollSegs] = useState<{ id: string; coords: LngLat[] }[]>([]);
    const [catTollLabels, setCatTollLabels] = useState<{ coord: LngLat; side: "left" | "right" }[]>([]);
    const [catCommZones, setCatCommZones] = useState<{ id: string; ring: LngLat[]; radiusM: number }[]>([]);

    // RESULTS panel (route scoring)
    const RESULTS_HEIGHT = "33vh";
    const [routeScores, setRouteScores] = useState<RouteScore[]>([]);
    const [showResults, setShowResults] = useState(false);
    const parkLayerIdsRef = useRef<string[]>([]);


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

    // ✅ store computed triple lines for segmentation
    const tripleLinesRef = useRef<{ A: LngLat[]; B: LngLat[]; C: LngLat[] }>({ A: [], B: [], C: [] });
    // ✅ Route edit mode (taken from App_18, merged into App_20)
    const [isEditMode, setIsEditMode] = useState(false);
    const isEditModeRef = useRef(false);
    useEffect(() => {
        isEditModeRef.current = isEditMode;
    }, [isEditMode]);

    const selectedRouteRef = useRef<BadgeId>("A");
    useEffect(() => {
        selectedRouteRef.current = selectedRoute;
    }, [selectedRoute]);

    // Keep the original "system" solution so we can reset edits
    const tripleLinesBaseRef = useRef<{ A: LngLat[]; B: LngLat[]; C: LngLat[] }>({ A: [], B: [], C: [] });

    const [editJunctions, setEditJunctions] = useState<EditJunction[]>([]);
    const editJunctionsRef = useRef<EditJunction[]>([]);
    useEffect(() => {
        editJunctionsRef.current = editJunctions;
    }, [editJunctions]);

    const [editDisabledIds, setEditDisabledIds] = useState<Set<string>>(new Set());
    const editDisabledIdsRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        editDisabledIdsRef.current = editDisabledIds;
    }, [editDisabledIds]);

    const [editHistory, setEditHistory] = useState<Set<string>[]>([]);
    const editHistoryRef = useRef<Set<string>[]>([]);
    useEffect(() => {
        editHistoryRef.current = editHistory;
    }, [editHistory]);

    const [editHistPos, setEditHistPos] = useState(-1);
    const editHistPosRef = useRef(-1);
    useEffect(() => {
        editHistPosRef.current = editHistPos;
    }, [editHistPos]);

    // Expose handlers to the map click listener (which is attached once)
    const toggleJunctionRef = useRef<(jid: string) => void>(() => { });
    const undoEditRef = useRef<() => void>(() => { });
    const redoEditRef = useRef<() => void>(() => { });
    const resetEditRef = useRef<() => void>(() => { });



    // ✅ Random spatial categories generator (inside bbox around the 3 routes)
    const regenerateSpatialCategories = useCallback(
        (forcedGlobalDiversity?: number) => {
            const map = mapRef.current;
            if (!map || !map.isStyleLoaded()) return;

            const A = tripleLinesRef.current.A;
            const B = tripleLinesRef.current.B;
            const C = tripleLinesRef.current.C;
            const bbox0 = bboxFromLines([A, B, C]);
            if (!bbox0) return;

            const bbox = expandBbox(bbox0, 0.12);

            // ✅ Also consider nearby visible roads in the same area (so categories won't always sit on the routes)
            const nearbyRoadLines = roadLinesInBbox(map, bbox);
            const hasNearbyRoads = nearbyRoadLines.length > 0;

            const g = Math.max(0, Math.min(1, forcedGlobalDiversity ?? catGlobalDiversity));

            const clampInt = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)));

            const jitterCount = (base: number, local: number, max: number) => {
                const v = Math.max(0, Math.min(1, local * g));
                const delta = (rand01() * 2 - 1) * base * v;
                return clampInt(base + delta, 0, max);
            };

            const pickLine = () => {
                const idx = randInt(0, 2);
                return idx === 0 ? A : idx === 1 ? B : C;
            };

            // Mix: some segments are taken from the routes, some from nearby roads.
            // Higher diversity => more off-route (roads) => overlaps happen only sometimes.
            const pPickRoad = hasNearbyRoads ? Math.max(0, Math.min(0.92, 0.35 + 0.5 * g)) : 0;
            const pickLineOrRoad = () => {
                if (hasNearbyRoads && rand01() < pPickRoad) {
                    return nearbyRoadLines[randInt(0, nearbyRoadLines.length - 1)];
                }
                return pickLine();
            };

            // TRAFFIC segments
            const trafficCount = jitterCount(catTrafficCount, catTrafficDiv, 8);
            const trafficSegs: { id: string; coords: LngLat[] }[] = [];
            for (let i = 0; i < trafficCount; i++) {
                const line = pickLineOrRoad();
                if (line.length < 2) continue;
                const cum = cumulativeDistances(line);
                const total = cum[cum.length - 1] || 0;
                if (total < 60) continue;

                const v = Math.max(0, Math.min(1, catTrafficDiv * g));
                const lenBase = randBetween(catTrafficLenMin, catTrafficLenMax);
                const len = Math.max(50, Math.min(2000, lenBase * (1 + (rand01() * 2 - 1) * 0.6 * v)));

                const startD = randBetween(0, Math.max(0, total - len));
                const seg = subLineBetweenMeters(line, startD, startD + len);
                trafficSegs.push({ id: `traffic_${i}_${Date.now()}`, coords: seg });
            }

            // TOLL segments + labels every ~100m
            const tollCount = jitterCount(catTollCount, catTollDiv, 6);
            const tollSegs: { id: string; coords: LngLat[] }[] = [];
            const tollLabels: { coord: LngLat; side: "left" | "right" }[] = [];
            for (let i = 0; i < tollCount; i++) {
                const line = pickLineOrRoad();
                if (line.length < 2) continue;
                const cum = cumulativeDistances(line);
                const total = cum[cum.length - 1] || 0;
                if (total < 60) continue;

                const v = Math.max(0, Math.min(1, catTollDiv * g));
                const lenBase = randBetween(catTollLenMin, catTollLenMax);
                const len = Math.max(50, Math.min(2000, lenBase * (1 + (rand01() * 2 - 1) * 0.6 * v)));

                const startD = randBetween(0, Math.max(0, total - len));
                const seg = subLineBetweenMeters(line, startD, startD + len);
                tollSegs.push({ id: `toll_${i}_${Date.now()}`, coords: seg });

                // Repeated ₪ tags every ~100m
                const labelPts = pointsAlongLineEvery(seg, 100);
                for (const p of labelPts) {
                    tollLabels.push({ coord: p, side: rand01() < 0.5 ? "left" : "right" });
                }
            }

            // COMM circles
            const commCount = jitterCount(catCommCount, catCommDiv, 3);
            const commZones: { id: string; ring: LngLat[]; radiusM: number }[] = [];
            for (let i = 0; i < commCount; i++) {
                const v = Math.max(0, Math.min(1, catCommDiv * g));
                const diaBase = randBetween(catCommDiaMin, catCommDiaMax);
                const dia = Math.max(100, Math.min(1000, diaBase * (1 + (rand01() * 2 - 1) * 0.7 * v)));
                const radius = dia / 2;

                const center = randomPointInBbox(bbox);
                const ring = circleRing(center, radius);
                commZones.push({ id: `comm_${i}_${Date.now()}`, ring, radiusM: radius });
            }

            // Update sources
            setFC(
                map,
                "cat-traffic",
                fcLines(trafficSegs.map((s) => ({ coords: s.coords, props: { id: s.id } })))
            );
            setFC(map, "cat-toll", fcLines(tollSegs.map((s) => ({ coords: s.coords, props: { id: s.id } }))));
            setFC(
                map,
                "cat-toll-labels",
                fcPoints(
                    tollLabels.map((p) => p.coord),
                    tollLabels.map((p) => ({ side: p.side }))
                )
            );
            setFC(map, "cat-comm", fcPolygons(commZones.map((z) => ({ coords: z.ring, props: { id: z.id } }))));

            // Keep route badge text above categories
            try { ensureOverlay(map); } catch { }

            // Store state
            setCatTrafficSegs(trafficSegs);
            setCatTollSegs(tollSegs);
            setCatTollLabels(tollLabels);
            setCatCommZones(commZones);

            // Compute scores on real route geometry after scattering entities
            const mapNow = mapRef.current;
            if (mapNow) {
                const scores = computeRouteScores(
                    mapNow,
                    tripleLinesRef.current,
                    trafficSegs,
                    tollSegs,
                    commZones,
                    parkLayerIdsRef.current
                );
                setRouteScores(scores);
                setShowResults(true);
            }

        },
        [
            catGlobalDiversity,
            catTrafficCount,
            catTrafficLenMin,
            catTrafficLenMax,
            catTrafficDiv,
            catTollCount,
            catTollLenMin,
            catTollLenMax,
            catTollDiv,
            catCommCount,
            catCommDiaMin,
            catCommDiaMax,
            catCommDiv,
        ]
    );

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
            setFC(map, "edit-junctions", fcPoints([]));

            // Clear spatial categories too
            setFC(map, "cat-traffic", fcLines([]));
            setFC(map, "cat-toll", fcLines([]));
            setFC(map, "cat-toll-labels", fcPoints([]));
            setFC(map, "cat-comm", fcPolygons([]));

            // Keep route badge text above categories
            try { ensureOverlay(map); } catch { }
            setCatTrafficSegs([]);
            setCatTollSegs([]);
            setCatTollLabels([]);
            setCatCommZones([]);
            setTripleComputed(false);

            // Spatial categories init
            setFC(map, "cat-traffic", fcLines([]));
            setFC(map, "cat-toll", fcLines([]));
            setFC(map, "cat-toll-labels", fcPoints([]));
            setFC(map, "cat-comm", fcPolygons([]));

            // Keep route badge text above categories
            try { ensureOverlay(map); } catch { }

            // apply initial map settings
            applyLanguage(map, lang, originalTextFieldRef);
            toggleLayers(map, isRoadLayer, showRoads);
            toggleLayers(map, isTransitLayer, showTransit);
            toggleLayers(map, (l) => isLabelLayer(l) && !isPoiLayer(l), showLabels);
            toggleLayers(map, isPoiLayer, showPOI);

            // apply initial selected style
            applySelectedRouteStyles(map, selectedRoute);
            applySelectedTagStyle(map, selectedRoute);
            bringSelectedRouteAboveOthers(map, selectedRoute);

            // Emphasize parks / scenic landcover
            emphasizeParks(map);
            parkLayerIdsRef.current = getParkFillLayerIds(map);


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

        // Re-apply park emphasis if the style reloads (e.g., after setStyle)
        map.on("style.load", () => {
            try { emphasizeParks(map); } catch { }
            parkLayerIdsRef.current = getParkFillLayerIds(map);
        });

        map.on("click", (ev) => {
            const ll: LngLat = [ev.lngLat.lng, ev.lngLat.lat];
            const m = modeRef.current;

            // ✅ Route edit mode: clicking on a junction marker toggles deletion (without affecting start/end picking)
            if (m === "TRIPLE" && isEditModeRef.current) {
                const feats = map.queryRenderedFeatures(ev.point, { layers: ["edit-junction-circles", "edit-junction-text"] });
                const f0 = feats && feats[0];
                const jid = (f0 && (f0.properties as any)?.jid) as string | undefined;
                if (jid) {
                    toggleJunctionRef.current(jid);
                    return;
                }
            }


            if (m === "MEASURE") {
                setMeasurePts((prev) => [...prev, ll]);
                return;
            }

            if (m === "SINGLE") {
                setSingleWaypoints((prev) => [...prev, ll]);
                return;
            }

            // TRIPLE: בחירת נקודות רק כאשר הכפתור "3 מסלולים" לחוץ
            if (!triplePickArmedRef.current) return;

            const s = startRef.current;
            const t = endRef.current;

            if (!s) {
                setStart(ll);
                setEnd(null);
                return;
            }
            if (!t) {
                setEnd(ll);
                setTriplePickArmed(false); // ברגע שנבחר יעד, מנטרלים כדי למנוע קליקים בטעות
                return;
            }

            // אם כבר יש מוצא+יעד ומפעילים שוב — מתחילים סבב חדש
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


    // Apply spatial category layer toggles
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !map.isStyleLoaded()) return;

        const setVis = (id: string, on: boolean) => {
            if (!map.getLayer(id)) return;
            try {
                map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
            } catch { }
        };

        setVis("cat-traffic", showCatTraffic);
        setVis("cat-traffic-glow", showCatTraffic);

        const tollOn = showCatToll;
        setVis("cat-toll-left", tollOn);
        setVis("cat-toll-right", tollOn);
        setVis("cat-toll-label-bg", tollOn);
        setVis("cat-toll-label-text", tollOn);

        const commOn = showCatComm;
        setVis("cat-comm-fill", commOn);
        setVis("cat-comm-outline", commOn);
    }, [showCatTraffic, showCatToll, showCatComm]);

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
        tripleLinesBaseRef.current = { A: [], B: [], C: [] };
        setIsEditMode(false);
        setEditJunctions([]);
        setEditDisabledIds(new Set());
        setEditHistory([]);
        setEditHistPos(-1);

        if (!start || !end) {
            setFC(map, "triple-a", fcLine([]));
            setFC(map, "triple-b", fcLine([]));
            setFC(map, "triple-c", fcLine([]));
            setFC(map, "triple-badge-points", fcPoints([]));
            setFC(map, "triple-badge-lines", fcLines([]));
            setFC(map, "triple-seg-points", fcPoints([]));
            setFC(map, "triple-seg-ticks", fcLines([]));
            setFC(map, "edit-junctions", fcPoints([]));
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
        setFC(map, "edit-junctions", fcPoints([]));
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
            // keep the original "system" solution for reset
            tripleLinesBaseRef.current = { A: a, B: bLine, C: cLine };

            // reset edit mode state after a new calculation
            setIsEditMode(false);
            setEditJunctions([]);
            setEditDisabledIds(new Set());
            setEditHistory([]);
            setEditHistPos(-1);
            setFC(map, "edit-junctions", fcPoints([]));
            // keep the original "system" solution for reset
            tripleLinesBaseRef.current = { A: a, B: bLine, C: cLine };

            // reset edit mode state after a new calculation
            setIsEditMode(false);
            setEditJunctions([]);
            setEditDisabledIds(new Set());
            setEditHistory([]);
            setEditHistPos(-1);
            setFC(map, "edit-junctions", fcPoints([]));

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
                setFC(map, "edit-junctions", fcPoints([]));
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

            setTripleComputed(true);
            // initial random scatter inside the routes bbox
            regenerateSpatialCategories();
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
        tripleLinesBaseRef.current = { A: [], B: [], C: [] };
        setIsEditMode(false);
        setEditJunctions([]);
        setEditDisabledIds(new Set());
        setEditHistory([]);
        setEditHistPos(-1);
        const map = mapRef.current;
        if (!map) return;
        setFC(map, "triple-a", fcLine([]));
        setFC(map, "triple-b", fcLine([]));
        setFC(map, "triple-c", fcLine([]));
        setFC(map, "triple-badge-points", fcPoints([]));
        setFC(map, "triple-badge-lines", fcLines([]));
        setFC(map, "triple-seg-points", fcPoints([]));
        setFC(map, "triple-seg-ticks", fcLines([]));
        setFC(map, "edit-junctions", fcPoints([]));

        // Also clear spatial categories when clearing routes
        setFC(map, "cat-traffic", fcLines([]));
        setFC(map, "cat-toll", fcLines([]));
        setFC(map, "cat-toll-labels", fcPoints([]));
        setFC(map, "cat-comm", fcPolygons([]));

        // Keep route badge text above categories
        try { ensureOverlay(map); } catch { }
        setCatTrafficSegs([]);
        setCatTollSegs([]);
        setCatTollLabels([]);
        setCatCommZones([]);
        setTripleComputed(false);
        setTriplePickArmed(false);
    };

    // ---------- Route edit mode (App_18) ----------
    const routeSourceId = (id: BadgeId) => (id === "A" ? "triple-a" : id === "B" ? "triple-b" : "triple-c");

    const renderSegmentsForLine = useCallback(
        (map: maplibregl.Map, line: LngLat[]) => {
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

            setFC(
                map,
                "triple-seg-points",
                fcPoints([mid1, mid2, mid3], [{ label: "1" }, { label: "2" }, { label: "3" }])
            );
            setFC(map, "triple-seg-ticks", fcLines([{ coords: tick1 }, { coords: tick2 }]));
        },
        []
    );

    const updateSelectedRouteOnMapForEdit = useCallback(
        (map: maplibregl.Map, routeId: BadgeId, newLine: LngLat[]) => {
            setFC(map, routeSourceId(routeId), fcLine(newLine));

            // Update anchor (for connector line)
            const newAnchor = midpointOnLine(newLine);
            const nextAnchors = anchorsRef.current.map((a) => (a.id === routeId ? { ...a, coord: newAnchor } : a));
            setAnchors(nextAnchors);

            // Rebuild connector lines using current badge positions
            const curBadges = badgesRef.current;
            if (nextAnchors.length && curBadges.length) {
                setFC(map, "triple-badge-lines", buildConnectorFC(map, nextAnchors, curBadges));
            }

            // Ensure selected route stays on top
            bringSelectedRouteAboveOthers(map, routeId);
        },
        []
    );

    const pushEditHistory = useCallback((next: Set<string>) => {
        const pos = editHistPosRef.current;
        const newPos = pos + 1;

        setEditHistory((prev) => [...prev.slice(0, pos + 1), new Set(next)]);
        setEditHistPos(newPos);
    }, []);

    const applyEditState = useCallback(
        async (nextDisabled: Set<string>) => {
            const map = mapRef.current;
            if (!map || !map.isStyleLoaded()) return;

            const rid = selectedRouteRef.current;

            const base = tripleLinesBaseRef.current[rid];
            const junctions = editJunctionsRef.current;

            // render junctions with current disabled state
            renderEditJunctionsOnMap(map, junctions, nextDisabled);

            // recompute route
            const newLine = await applyEditDisabled(base, junctions, nextDisabled);

            // update in refs + map
            tripleLinesRef.current[rid] = newLine;
            updateSelectedRouteOnMapForEdit(map, rid, newLine);

            // update segment overlays for selected route
            renderSegmentsForLine(map, newLine);
        },
        [renderSegmentsForLine, updateSelectedRouteOnMapForEdit]
    );

    const toggleJunction = useCallback(
        (jid: string) => {
            if (!isEditModeRef.current) return;

            const cur = editDisabledIdsRef.current;
            const next = new Set(cur);
            if (next.has(jid)) next.delete(jid);
            else next.add(jid);

            setEditDisabledIds(next);
            pushEditHistory(next);
            void applyEditState(next);
        },
        [applyEditState, pushEditHistory]
    );

    const undoEdit = useCallback(() => {
        const pos = editHistPosRef.current;
        if (pos <= 0) return;
        const newPos = pos - 1;

        const prevSet = editHistoryRef.current[newPos] ?? new Set<string>();
        setEditHistPos(newPos);
        setEditDisabledIds(new Set(prevSet));
        void applyEditState(new Set(prevSet));
    }, [applyEditState]);

    const redoEdit = useCallback(() => {
        const pos = editHistPosRef.current;
        const hist = editHistoryRef.current;
        if (pos < 0 || pos >= hist.length - 1) return;

        const newPos = pos + 1;
        const nextSet = hist[newPos] ?? new Set<string>();
        setEditHistPos(newPos);
        setEditDisabledIds(new Set(nextSet));
        void applyEditState(new Set(nextSet));
    }, [applyEditState]);

    const resetEditsToSystem = useCallback(() => {
        const map = mapRef.current;
        if (!map || !map.isStyleLoaded()) return;

        const rid = selectedRouteRef.current;

        const base = tripleLinesBaseRef.current[rid];
        if (!base || base.length < 2) return;

        // restore route
        tripleLinesRef.current[rid] = base;
        updateSelectedRouteOnMapForEdit(map, rid, base);

        // clear edit state + history
        const empty = new Set<string>();
        setEditDisabledIds(empty);
        setEditHistory([empty]);
        setEditHistPos(0);

        // redraw junctions and segments
        renderEditJunctionsOnMap(map, editJunctionsRef.current, empty);
        renderSegmentsForLine(map, base);
    }, [renderSegmentsForLine, updateSelectedRouteOnMapForEdit]);

    // expose callbacks to the map click handler (attached once)
    useEffect(() => {
        toggleJunctionRef.current = toggleJunction;
        undoEditRef.current = undoEdit;
        redoEditRef.current = redoEdit;
        resetEditRef.current = resetEditsToSystem;
    }, [toggleJunction, undoEdit, redoEdit, resetEditsToSystem]);

    // build junction markers when entering edit mode (or when route selection changes)
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !map.isStyleLoaded()) return;

        if (!isEditMode) {
            // hide markers when not editing
            setFC(map, "edit-junctions", fcPoints([]));
            return;
        }

        const rid = selectedRoute;
        const base = tripleLinesBaseRef.current[rid];
        if (!base || base.length < 2) {
            setEditJunctions([]);
            setFC(map, "edit-junctions", fcPoints([]));
            return;
        }

        const junctions = buildEditJunctions(base);
        setEditJunctions(junctions);

        // reset edit state when (re)entering edit mode
        const empty = new Set<string>();
        setEditDisabledIds(empty);
        setEditHistory([empty]);
        setEditHistPos(0);

        renderEditJunctionsOnMap(map, junctions, empty);
    }, [isEditMode, selectedRoute, calcNonce]);

    // ---------- End route edit mode ----------

    return (
        <div style={{ display: "flex", width: "100vw", height: "100vh", overflow: "hidden" }}>
            {/* MAP */}
            <div style={{ flex: 1, position: "relative" }}>
                <div ref={mapDivRef} style={{ width: "100%", height: "100%" }} />

                <div
                    style={{
                        position: "absolute",
                        right: 10,
                        bottom: 40,
                        background: "rgba(11,15,23,0.78)",
                        border: "1px solid rgba(255,255,255,0.12)",
                        borderRadius: 12,
                        padding: "10px 12px",
                        color: "#e8eefc",
                        fontFamily: "Arial, sans-serif",
                        fontSize: 12,
                        lineHeight: 1.25,
                        backdropFilter: "blur(6px)",
                        minWidth: 165,
                        pointerEvents: "none",
                        direction: "rtl",   // ✅ עברית
                        textAlign: "right", // ✅ יישור לימין
                    }}
                >
                    <div style={{ fontWeight: 900, marginBottom: 8, opacity: 0.95 }}>מקרא</div>

                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 7 }}>
                        <div
                            style={{
                                width: 34,
                                height: 0,
                                borderTop: `4px dashed ${CAT_TRAFFIC_COLOR}`,
                                filter: "drop-shadow(0 0 2px rgba(255,0,34,0.55))",
                            }}
                        />
                        <div style={{ fontWeight: 700 }}>עומס תנועה</div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 7 }}>
                        <div style={{ width: 34, height: 10, position: "relative" }}>
                            <div style={{ position: "absolute", left: 0, right: 0, top: 1, borderTop: `3px solid ${CAT_TOLL_COLOR}` }} />
                            <div style={{ position: "absolute", left: 0, right: 0, bottom: 1, borderTop: `3px solid ${CAT_TOLL_COLOR}` }} />
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontWeight: 700 }}>כביש אגרה</span>
                            <span
                                style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    width: 18,
                                    height: 18,
                                    borderRadius: 999,
                                    background: CAT_TOLL_COLOR,
                                    border: "1px solid rgba(11,18,32,0.9)",
                                    color: "#0b1220",
                                    fontWeight: 900,
                                }}
                            >
                                ₪
                            </span>
                        </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 7 }}>
                        <div
                            style={{
                                width: 18,
                                height: 18,
                                borderRadius: 999,
                                background: CAT_COMM_FILL,
                                border: `2px solid ${CAT_COMM_OUTLINE}`,
                            }}
                        />
                        <div style={{ fontWeight: 700 }}>תקשורת טובה</div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div
                            style={{
                                width: 18,
                                height: 12,
                                borderRadius: 4,
                                background: PARK_FILL,
                                border: `2px solid ${PARK_OUTLINE}`,
                                opacity: PARK_OPACITY,
                            }}
                        />
                        <div style={{ fontWeight: 700 }}>נוף (פארקים)</div>
                    </div>
                </div>
                {showResults && (
                    <div
                        style={{
                            position: "absolute",
                            left: 0,
                            right: 0,
                            bottom: 0,
                            height: RESULTS_HEIGHT,
                            zIndex: 9999,
                            pointerEvents: "auto",
                            background: "rgba(10, 14, 22, 0.95)",
                            borderTop: "1px solid rgba(255,255,255,0.12)",
                            color: "white",
                            overflow: "hidden",
                            direction: "rtl",
                        }}
                    >
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                padding: "8px 12px",
                                borderBottom: "1px solid rgba(255,255,255,0.12)",
                            }}
                        >
                            <div style={{ fontWeight: 700 }}>תוצאות</div>
                            <button
                                onClick={() => setShowResults(false)}
                                style={{
                                    padding: "6px 10px",
                                    borderRadius: 8,
                                    border: "1px solid rgba(255,255,255,0.15)",
                                    background: "rgba(255,255,255,0.06)",
                                    color: "white",
                                    cursor: "pointer",
                                }}
                            >
                                סגור
                            </button>
                        </div>

                        <div
                            style={{
                                height: `calc(${RESULTS_HEIGHT} - 44px)`,
                                overflow: "auto",
                                padding: "8px 12px",
                            }}
                        >
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                                <thead>
                                    <tr style={{ position: "sticky", top: 0, background: "rgba(10,14,22,0.98)" }}>
                                        {["מקטע", "אורך (ק״מ)", "זמן (דק׳)", "מהירות", "חסכון", "נוף", "קליטה"].map((h) => (
                                            <th
                                                key={h}
                                                style={{
                                                    textAlign: "right",
                                                    padding: "8px 6px",
                                                    borderBottom: "1px solid rgba(255,255,255,0.15)",
                                                    fontWeight: 700,
                                                    whiteSpace: "nowrap",
                                                }}
                                            >
                                                {h}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>

                                <tbody>
                                    {routeScores.map((rs) => {
                                        const km = (m: number) => (m / 1000).toFixed(2);
                                        const min = (s: number) => (s / 60).toFixed(1);
                                        const sc = (x: number) => Math.round(x);

                                        return (
                                            <Fragment key={rs.route}>
                                                <tr>
                                                    <td
                                                        colSpan={7}
                                                        style={{
                                                            padding: "10px 6px",
                                                            fontWeight: 800,
                                                            borderBottom: "1px solid rgba(255,255,255,0.10)",
                                                        }}
                                                    >
                                                        מסלול {rs.route}
                                                    </td>
                                                </tr>

                                                {rs.segments.map((sg) => (
                                                    <tr key={`${rs.route}-${sg.segment}`}>
                                                        <td style={{ padding: "7px 6px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                                                            מקטע {sg.segment}
                                                        </td>
                                                        <td style={{ padding: "7px 6px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                                                            {km(sg.lengthM)}
                                                        </td>
                                                        <td style={{ padding: "7px 6px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                                                            {min(sg.timeS)}
                                                        </td>
                                                        <td style={{ padding: "7px 6px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                                                            {sc(sg.speedScore)}
                                                        </td>
                                                        <td style={{ padding: "7px 6px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                                                            {sc(sg.economyScore)}
                                                        </td>
                                                        <td style={{ padding: "7px 6px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                                                            {sc(sg.scenicScore)}
                                                        </td>
                                                        <td style={{ padding: "7px 6px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                                                            {sc(sg.commScore)}
                                                        </td>
                                                    </tr>
                                                ))}

                                                <tr>
                                                    <td style={{ padding: "9px 6px", fontWeight: 800 }}>
                                                        סה״כ
                                                    </td>
                                                    <td style={{ padding: "9px 6px", fontWeight: 800 }}>
                                                        {km(rs.totalLengthM)}
                                                    </td>
                                                    <td style={{ padding: "9px 6px", fontWeight: 800 }}>
                                                        {min(rs.totalTimeS)}
                                                    </td>
                                                    <td style={{ padding: "9px 6px", fontWeight: 800 }}>—</td>
                                                    <td style={{ padding: "9px 6px", fontWeight: 800 }}>—</td>
                                                    <td style={{ padding: "9px 6px", fontWeight: 800 }}>—</td>
                                                    <td style={{ padding: "9px 6px", fontWeight: 800 }}>—</td>
                                                </tr>
                                            </Fragment>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

            </div>

            {/* RIGHT PANEL */}
            <div
                style={{
                    width: 420,
                    background: "#0b0f17",
                    color: "#e8eefc",
                    padding: 16,
                    borderLeft: "1px solid rgba(255,255,255,0.08)",
                    fontFamily: "Arial, sans-serif",
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
                    ].map((b) => {
                        const isTriple = b.id === "TRIPLE";
                        const isPressed = isTriple ? mode === "TRIPLE" && triplePickArmed : mode === b.id;
                        return (
                            <button
                                key={b.id}
                                onClick={() => {
                                    if (isTriple) {
                                        if (mode !== "TRIPLE") {
                                            setMode("TRIPLE");
                                            setTriplePickArmed(true);
                                        } else {
                                            setTriplePickArmed((v) => !v);
                                        }
                                    } else {
                                        setMode(b.id);
                                        setTriplePickArmed(false);
                                    }
                                }}
                                style={{
                                    padding: "10px 12px",
                                    borderRadius: 12,
                                    border: "1px solid rgba(255,255,255,0.15)",
                                    background: isPressed ? "rgba(140,203,255,0.22)" : "transparent",
                                    color: "#e8eefc",
                                    cursor: "pointer",
                                    fontWeight: 800,
                                }}
                                title={isTriple ? (triplePickArmed ? "בחירת נקודות פעילה (קליק 1 מוצא, קליק 2 יעד)" : "לחץ כדי לאפשר דקירה למוצא/יעד") : undefined}
                            >
                                {b.label}
                            </button>
                        );
                    })}
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

                    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.12)" }}>
                        <div style={{ fontWeight: 800, marginBottom: 8 }}>קטגוריות מרחביות</div>

                        {[
                            { label: "עומס תנועה", v: showCatTraffic, set: setShowCatTraffic },
                            { label: "כבישי אגרה", v: showCatToll, set: setShowCatToll },
                            { label: "תקשורת טובה", v: showCatComm, set: setShowCatComm },
                        ].map((x) => (
                            <label
                                key={x.label}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    padding: "8px 4px",
                                    opacity: tripleComputed ? 1 : 0.55,
                                }}
                                title={tripleComputed ? "הצג/הסתר" : "זמין לאחר חישוב 3 מסלולים"}
                            >
                                <span style={{ fontWeight: 700 }}>{x.label}</span>
                                <input
                                    type="checkbox"
                                    checked={x.v}
                                    disabled={!tripleComputed}
                                    onChange={(e) => x.set(e.target.checked)}
                                    style={{ transform: "scale(1.2)" }}
                                />
                            </label>
                        ))}
                    </div>
                </div>

                {/* Mode-specific tools */}
                {mode === "TRIPLE" && (
                    <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                        <div style={{ fontWeight: 900, marginBottom: 6 }}>3 מסלולים (א/ב/ג)</div>
                        <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 10 }}>
                            כדי לבחור נקודות: לחץ למעלה על <b>3 מסלולים</b> (יהיה מודגש), ואז קליק 1 = <b>מוצא</b>, קליק 2 = <b>יעד</b>. לאחר בחירת יעד הכפתור משתחרר כדי למנוע קליקים בטעות. <br />
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


                        <div style={{ fontWeight: 800, marginBottom: 8 }}>עריכת מסלול</div>

                        <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                            <button
                                onClick={() => {
                                    // allow edit only after we have a computed "system" route
                                    const hasBase =
                                        tripleLinesBaseRef.current.A.length >= 2 &&
                                        tripleLinesBaseRef.current.B.length >= 2 &&
                                        tripleLinesBaseRef.current.C.length >= 2;
                                    if (!hasBase) return;
                                    setIsEditMode((v) => !v);
                                }}
                                disabled={isRoutingTriple}
                                style={{
                                    flex: 1,
                                    padding: "10px 12px",
                                    borderRadius: 12,
                                    border: "1px solid rgba(255,255,255,0.15)",
                                    background: isEditMode ? "rgba(255,255,255,0.12)" : "transparent",
                                    color: "#e8eefc",
                                    cursor: isRoutingTriple ? "not-allowed" : "pointer",
                                    fontWeight: 900,
                                    opacity: isRoutingTriple ? 0.7 : 1,
                                }}
                                title="מצב עריכה: לחץ על עיגולים במסלול כדי למחוק/להחזיר מקטעים"
                            >
                                {isEditMode ? "סיום עריכה" : "עריכת מסלול"}
                            </button>

                            <button
                                onClick={resetEditsToSystem}
                                disabled={!isEditMode}
                                style={{
                                    flex: 1,
                                    padding: "10px 12px",
                                    borderRadius: 12,
                                    border: "1px solid rgba(255,255,255,0.15)",
                                    background: "transparent",
                                    color: "#e8eefc",
                                    cursor: !isEditMode ? "not-allowed" : "pointer",
                                    fontWeight: 900,
                                    opacity: !isEditMode ? 0.6 : 1,
                                }}
                                title="ביטול כל השינויים וחזרה לפתרון המערכת"
                            >
                                חזרה לפתרון מערכת
                            </button>
                        </div>

                        {isEditMode && (
                            <>
                                <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10, lineHeight: 1.4 }}>
                                    במצב עריכה: יופיעו עיגולים בצמתים לאורך המסלול. לחיצה על עיגול תבטל/תחזיר צומת,
                                    והמערכת תחשב מחדש מסלול חוקי בין הצמתים שנותרו.
                                </div>

                                <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
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
                                            opacity: editHistPos <= 0 ? 0.55 : 1,
                                        }}
                                        title="חזור צעד אחורה"
                                    >
                                        חזור
                                    </button>

                                    <button
                                        onClick={redoEdit}
                                        disabled={editHistPos >= editHistory.length - 1}
                                        style={{
                                            flex: 1,
                                            padding: "10px 12px",
                                            borderRadius: 12,
                                            border: "1px solid rgba(255,255,255,0.15)",
                                            background: "transparent",
                                            color: "#e8eefc",
                                            cursor: editHistPos >= editHistory.length - 1 ? "not-allowed" : "pointer",
                                            fontWeight: 900,
                                            opacity: editHistPos >= editHistory.length - 1 ? 0.55 : 1,
                                        }}
                                        title="קדימה (אחרי חזור)"
                                    >
                                        קדימה
                                    </button>
                                </div>
                            </>
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



                        {tripleComputed && (
                            <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.12)" }}>
                                <div style={{ fontWeight: 900, marginBottom: 6 }}>קטגוריות מרחביות</div>
                                <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>
                                    פיזור רנדומלי בתוך מלבן שמכסה את שלושת המסלולים. אפשר לשלוט בכמויות/טווחים ולפזר מחדש.
                                </div>

                                <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>
                                    נוצרו: <b>{catTrafficSegs.length}</b> מקטעי תנועה, <b>{catTollSegs.length}</b> מקטעי אגרה, <b>{catCommZones.length}</b> אזורי תקשורת, <b>{catTollLabels.length}</b> תגיות ₪.
                                </div>

                                <div style={{ fontWeight: 800, marginBottom: 6 }}>שונות גלובלית</div>
                                <input
                                    type="range"
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    value={catGlobalDiversity}
                                    onChange={(e) => setCatGlobalDiversity(parseFloat(e.target.value))}
                                    style={{ width: "100%" }}
                                />
                                <div style={{ fontSize: 12, opacity: 0.8, margin: "6px 0 10px" }}>{Math.round(catGlobalDiversity * 100)}%</div>

                                {/* TRAFFIC */}
                                <div style={{ fontWeight: 900, marginTop: 8, marginBottom: 6, color: CAT_TRAFFIC_COLOR }}>עומס תנועה</div>
                                <div style={{ fontSize: 12, opacity: 0.85 }}>כמות (0–8): <b>{catTrafficCount}</b></div>
                                <input type="range" min={0} max={8} step={1} value={catTrafficCount} onChange={(e) => setCatTrafficCount(parseInt(e.target.value))} style={{ width: "100%" }} />

                                <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: 12, opacity: 0.85 }}>אורך מינ׳ (50–2000m)</div>
                                        <input
                                            type="range"
                                            min={50}
                                            max={2000}
                                            step={10}
                                            value={catTrafficLenMin}
                                            onChange={(e) => {
                                                const v = parseInt(e.target.value);
                                                setCatTrafficLenMin(v);
                                                if (v > catTrafficLenMax) setCatTrafficLenMax(v);
                                            }}
                                            style={{ width: "100%" }}
                                        />
                                        <div style={{ fontSize: 12, opacity: 0.8 }}>{catTrafficLenMin}m</div>
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: 12, opacity: 0.85 }}>אורך מקס׳ (50–2000m)</div>
                                        <input
                                            type="range"
                                            min={50}
                                            max={2000}
                                            step={10}
                                            value={catTrafficLenMax}
                                            onChange={(e) => {
                                                const v = parseInt(e.target.value);
                                                setCatTrafficLenMax(v);
                                                if (v < catTrafficLenMin) setCatTrafficLenMin(v);
                                            }}
                                            style={{ width: "100%" }}
                                        />
                                        <div style={{ fontSize: 12, opacity: 0.8 }}>{catTrafficLenMax}m</div>
                                    </div>
                                </div>

                                <div style={{ fontSize: 12, opacity: 0.85, marginTop: 8 }}>שונות מקומית: <b>{Math.round(catTrafficDiv * 100)}%</b></div>
                                <input type="range" min={0} max={1} step={0.01} value={catTrafficDiv} onChange={(e) => setCatTrafficDiv(parseFloat(e.target.value))} style={{ width: "100%" }} />

                                {/* TOLL */}
                                <div style={{ fontWeight: 900, marginTop: 12, marginBottom: 6, color: CAT_TOLL_COLOR }}>כבישי אגרה</div>
                                <div style={{ fontSize: 12, opacity: 0.85 }}>כמות (0–6): <b>{catTollCount}</b></div>
                                <input type="range" min={0} max={6} step={1} value={catTollCount} onChange={(e) => setCatTollCount(parseInt(e.target.value))} style={{ width: "100%" }} />

                                <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: 12, opacity: 0.85 }}>אורך מינ׳ (50–2000m)</div>
                                        <input
                                            type="range"
                                            min={50}
                                            max={2000}
                                            step={10}
                                            value={catTollLenMin}
                                            onChange={(e) => {
                                                const v = parseInt(e.target.value);
                                                setCatTollLenMin(v);
                                                if (v > catTollLenMax) setCatTollLenMax(v);
                                            }}
                                            style={{ width: "100%" }}
                                        />
                                        <div style={{ fontSize: 12, opacity: 0.8 }}>{catTollLenMin}m</div>
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: 12, opacity: 0.85 }}>אורך מקס׳ (50–2000m)</div>
                                        <input
                                            type="range"
                                            min={50}
                                            max={2000}
                                            step={10}
                                            value={catTollLenMax}
                                            onChange={(e) => {
                                                const v = parseInt(e.target.value);
                                                setCatTollLenMax(v);
                                                if (v < catTollLenMin) setCatTollLenMin(v);
                                            }}
                                            style={{ width: "100%" }}
                                        />
                                        <div style={{ fontSize: 12, opacity: 0.8 }}>{catTollLenMax}m</div>
                                    </div>
                                </div>

                                <div style={{ fontSize: 12, opacity: 0.85, marginTop: 8 }}>שונות מקומית: <b>{Math.round(catTollDiv * 100)}%</b></div>
                                <input type="range" min={0} max={1} step={0.01} value={catTollDiv} onChange={(e) => setCatTollDiv(parseFloat(e.target.value))} style={{ width: "100%" }} />

                                {/* COMM */}
                                <div style={{ fontWeight: 900, marginTop: 12, marginBottom: 6, color: CAT_COMM_OUTLINE }}>תקשורת טובה</div>
                                <div style={{ fontSize: 12, opacity: 0.85 }}>כמות (0–3): <b>{catCommCount}</b></div>
                                <input type="range" min={0} max={3} step={1} value={catCommCount} onChange={(e) => setCatCommCount(parseInt(e.target.value))} style={{ width: "100%" }} />

                                <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: 12, opacity: 0.85 }}>קוטר מינ׳ (100–1000m)</div>
                                        <input
                                            type="range"
                                            min={100}
                                            max={1000}
                                            step={10}
                                            value={catCommDiaMin}
                                            onChange={(e) => {
                                                const v = parseInt(e.target.value);
                                                setCatCommDiaMin(v);
                                                if (v > catCommDiaMax) setCatCommDiaMax(v);
                                            }}
                                            style={{ width: "100%" }}
                                        />
                                        <div style={{ fontSize: 12, opacity: 0.8 }}>{catCommDiaMin}m</div>
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: 12, opacity: 0.85 }}>קוטר מקס׳ (100–1000m)</div>
                                        <input
                                            type="range"
                                            min={100}
                                            max={1000}
                                            step={10}
                                            value={catCommDiaMax}
                                            onChange={(e) => {
                                                const v = parseInt(e.target.value);
                                                setCatCommDiaMax(v);
                                                if (v < catCommDiaMin) setCatCommDiaMin(v);
                                            }}
                                            style={{ width: "100%" }}
                                        />
                                        <div style={{ fontSize: 12, opacity: 0.8 }}>{catCommDiaMax}m</div>
                                    </div>
                                </div>

                                <div style={{ fontSize: 12, opacity: 0.85, marginTop: 8 }}>שונות מקומית: <b>{Math.round(catCommDiv * 100)}%</b></div>
                                <input type="range" min={0} max={1} step={0.01} value={catCommDiv} onChange={(e) => setCatCommDiv(parseFloat(e.target.value))} style={{ width: "100%" }} />

                                <button
                                    onClick={() => regenerateSpatialCategories()}
                                    style={{
                                        marginTop: 12,
                                        width: "100%",
                                        padding: "10px 12px",
                                        borderRadius: 12,
                                        border: "1px solid rgba(255,255,255,0.15)",
                                        background: "rgba(140,203,255,0.18)",
                                        color: "#e8eefc",
                                        cursor: "pointer",
                                        fontWeight: 900,
                                    }}
                                >
                                    פזר רנדומלי
                                </button>
                                <button
                                    onClick={() => {
                                        const next = !showResults;

                                        // אם פותחים ואין עדיין ציונים – נחשב על בסיס ה־state הנוכחי
                                        if (next && routeScores.length === 0) {
                                            const mapNow = mapRef.current;
                                            if (mapNow) {
                                                const scores = computeRouteScores(
                                                    mapNow,
                                                    tripleLinesRef.current,
                                                    catTrafficSegs,
                                                    catTollSegs,
                                                    catCommZones,
                                                    parkLayerIdsRef.current
                                                );
                                                setRouteScores(scores);
                                            }
                                        }

                                        setShowResults(next);
                                    }}
                                    disabled={!tripleComputed}
                                    style={{
                                        width: "100%",
                                        padding: "10px 12px",
                                        marginTop: 8,
                                        borderRadius: 10,
                                        border: "1px solid rgba(255,255,255,0.15)",
                                        background: showResults ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.06)",
                                        color: "white",
                                        cursor: tripleComputed ? "pointer" : "not-allowed",
                                        textAlign: "right",
                                    }}
                                >
                                    {showResults ? "הסתר תוצאות" : "הצג תוצאות"}
                                </button>

                            </div>
                        )}

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
