import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

type LngLat = [number, number];
type Mode = "TRIPLE" | "ROUTE" | "MEASURE";
type LabelLang = "he" | "en";

const MAPTILER_KEY = "zmfamAfBbF0XXvV9Zx5Q";
const STYLE_URL = `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`;

// כולם אותו צבע, עם שקיפות קלה כדי לראות חפיפות
const ROUTE_COLOR = "#4AA3FF";
const ROUTE_OPACITY = 0.25;
const LABEL_FONT_STACK: string[] = ["Roboto Regular", "Noto Sans Regular"];

function pickTextFontFromStyle(map: maplibregl.Map): any {
    const layers = map.getStyle()?.layers ?? [];
    for (const l of layers) {
        if (l.type !== "symbol") continue;
        const tf = (l as any)?.layout?.["text-font"];
        if (tf) return tf; // יכול להיות array של strings או expression
    }
    return ["Noto Sans Regular"]; // fallback סביר, אבל לרוב לא נגיע אליו
}

// ---------- RTL plugin (Hebrew shaping) ----------
function ensureRTLPluginLoadedOnce() {
    const w = window as any;
    if (w.__rtlPluginSet) return; // ✅ guard גלובלי

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
        setPlugin(
            "https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.2.3/mapbox-gl-rtl-text.js",
            () => { },
            true
        );
        w.__rtlPluginSet = true;
    } catch (e) {
        // אם StrictMode כבר קרא לזה פעם אחת – לא להפיל את האפליקציה
        w.__rtlPluginSet = true;
        console.warn("RTL plugin already set / failed:", e);
    }
}

// ---------- Helpers ----------
function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}
function clamp(n: number, a: number, b: number) {
    return Math.max(a, Math.min(b, n));
}
function midpoint(a: LngLat, b: LngLat): LngLat {
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function haversineMeters(a: LngLat, b: LngLat): number {
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
function polylineMeters(coords: LngLat[]): number {
    let sum = 0;
    for (let i = 1; i < coords.length; i++) sum += haversineMeters(coords[i - 1], coords[i]);
    return sum;
}
function fmtDistance(m: number) {
    if (!Number.isFinite(m)) return "—";
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

function offsetMeters(p: LngLat, dxMeters: number, dyMeters: number): LngLat {
    const lat = p[1];
    const metersPerDegLat = 111132.92;
    const metersPerDegLng = 111412.84 * Math.cos((lat * Math.PI) / 180);
    const dLat = dyMeters / metersPerDegLat;
    const dLng = dxMeters / (metersPerDegLng || 1);
    return [p[0] + dLng, p[1] + dLat];
}
function withinBounds(p: LngLat, b: maplibregl.LngLatBounds): LngLat {
    return [
        clamp(p[0], b.getWest() + 1e-6, b.getEast() - 1e-6),
        clamp(p[1], b.getSouth() + 1e-6, b.getNorth() - 1e-6),
    ];
}
function viewportSizeMeters(map: maplibregl.Map): { w: number; h: number } {
    const b = map.getBounds();
    const sw: LngLat = [b.getWest(), b.getSouth()];
    const se: LngLat = [b.getEast(), b.getSouth()];
    const nw: LngLat = [b.getWest(), b.getNorth()];
    return { w: haversineMeters(sw, se), h: haversineMeters(sw, nw) };
}
function buildViaPoints(map: maplibregl.Map, start: LngLat, end: LngLat, diversity01: number) {
    const bounds = map.getBounds();
    const mid = midpoint(start, end);

    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const len = Math.max(1e-9, Math.hypot(dx, dy));
    const ux = -dy / len;
    const uy = dx / len;

    const { w, h } = viewportSizeMeters(map);
    const base = Math.min(w, h);
    const maxOffset = 0.35 * base;
    const offset = clamp(diversity01, 0, 1) * maxOffset;

    const via1 = withinBounds(offsetMeters(mid, ux * offset, uy * offset), bounds);
    const via2 = withinBounds(offsetMeters(mid, -ux * offset, -uy * offset), bounds);

    return { via1, via2 };
}

// ---------- OSRM ----------
async function osrmRoute(waypoints: LngLat[], signal?: AbortSignal): Promise<{ line: LngLat[] | null }> {
    if (waypoints.length < 2) return { line: null };

    const coords = waypoints.map(([lng, lat]) => `${lng},${lat}`).join(";");
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;

    const attempts = 3;
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await fetch(url, { signal });
            if (!res.ok) {
                const retry = res.status === 429 || res.status >= 500;
                if (retry && i < attempts - 1) {
                    await sleep(350 + i * 450);
                    continue;
                }
                return { line: null };
            }
            const json = await res.json();
            const line = json?.routes?.[0]?.geometry?.coordinates;
            if (!Array.isArray(line) || line.length < 2) {
                if (i < attempts - 1) {
                    await sleep(300 + i * 300);
                    continue;
                }
                return { line: null };
            }
            return { line: line as LngLat[] };
        } catch (e: any) {
            if (e?.name === "AbortError") return { line: null };
            if (i < attempts - 1) {
                await sleep(350 + i * 450);
                continue;
            }
            return { line: null };
        }
    }
    return { line: null };
}

// ---------- GeoJSON helpers ----------
function fcPoints(coords: LngLat[], props?: any[]) {
    return {
        type: "FeatureCollection",
        features: coords.map((c, i) => ({
            type: "Feature",
            properties: props?.[i] ?? {},
            geometry: { type: "Point", coordinates: c },
        })),
    };
}
function fcLine(coords: LngLat[], properties: any = {}) {
    if (coords.length < 2) return { type: "FeatureCollection", features: [] };
    return {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties, geometry: { type: "LineString", coordinates: coords } }],
    };
}
function fcLines(lines: LngLat[][]) {
    return {
        type: "FeatureCollection",
        features: lines
            .filter((c) => c.length >= 2)
            .map((coords) => ({
                type: "Feature",
                properties: {},
                geometry: { type: "LineString", coordinates: coords },
            })),
    };
}
function setFC(map: maplibregl.Map, sourceId: string, fc: any) {
    const s = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
    if (s) s.setData(fc);
}

// ---------- Base layer toggles ----------
function toggleBy(map: maplibregl.Map, pred: (l: any) => boolean, visible: boolean) {
    const layers = map.getStyle()?.layers ?? [];
    for (const l of layers) {
        if (!l?.id) continue;
        if (!pred(l)) continue;
        try {
            map.setLayoutProperty(l.id, "visibility", visible ? "visible" : "none");
        } catch { }
    }
}
function isPoiLayer(l: any) {
    const id = ((l.id as string) || "").toLowerCase();
    const src = (((l["source-layer"] as string) || "") as string).toLowerCase();
    return id.includes("poi") || src.includes("poi");
}
function isLabelLayer(l: any) {
    const type = (l.type as string) || "";
    const id = ((l.id as string) || "").toLowerCase();
    return type === "symbol" || id.includes("label") || id.includes("place");
}
function isRoadLayer(l: any) {
    const type = (l.type as string) || "";
    if (type !== "line") return false;
    const id = ((l.id as string) || "").toLowerCase();
    const src = (((l["source-layer"] as string) || "") as string).toLowerCase();
    return id.includes("road") || id.includes("transport") || src.includes("transport") || src.includes("road");
}
function isTransitLayer(l: any) {
    const id = ((l.id as string) || "").toLowerCase();
    const src = (((l["source-layer"] as string) || "") as string).toLowerCase();
    return id.includes("transit") || id.includes("rail") || src.includes("transit") || src.includes("rail");
}
function applyLabelLang(map: maplibregl.Map, lang: LabelLang) {
    const layers = map.getStyle()?.layers ?? [];
    for (const l of layers) {
        if (!l?.id) continue;
        if (l.type !== "symbol") continue;

        const tf = (l as any).layout?.["text-field"];
        if (typeof tf === "undefined") continue;

        try {
            map.setLayoutProperty(
                l.id,
                "text-field",
                lang === "he"
                    ? ["coalesce", ["get", "name:he"], ["get", "name_he"], ["get", "name:en"], ["get", "name"]]
                    : ["coalesce", ["get", "name:en"], ["get", "name_en"], ["get", "name"]]
            );
            map.setLayoutProperty(l.id, "text-allow-overlap", true);
        } catch { }
    }
}

// ---------- Create a stable pin icon (no async loadImage) ----------
function ensurePinImage(map: maplibregl.Map) {
    if (map.hasImage("end-pin")) return;

    const size = 48;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // draw a simple teardrop pin
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(size / 2, size / 2);

    // shadow
    ctx.beginPath();
    ctx.ellipse(0, 15, 10, 4, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fill();

    // pin body
    ctx.beginPath();
    ctx.moveTo(0, 18);
    ctx.bezierCurveTo(10, 10, 14, 3, 14, -4);
    ctx.arc(0, -4, 14, 0, Math.PI, true);
    ctx.bezierCurveTo(-14, 3, -10, 10, 0, 18);
    ctx.closePath();
    ctx.fillStyle = "#e11d48";
    ctx.fill();

    // inner white circle
    ctx.beginPath();
    ctx.arc(0, -4, 5.2, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    ctx.restore();

    const img = ctx.getImageData(0, 0, size, size);
    map.addImage("end-pin", { width: size, height: size, data: img.data }, { pixelRatio: 2 });
}

// ---------- NEW: label background image (white rounded rect) ----------
function ensureLabelBgImage(map: maplibregl.Map) {
    if (map.hasImage("label-bg")) return;

    const w = 140;
    const h = 44;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(255,255,255,0.75)";
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

// ---------- NEW: route badge image (light-blue circle) ----------
function ensureRouteBadgeImage(map: maplibregl.Map) {
    if (map.hasImage("route-badge")) return;

    const size = 52;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, 18, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(74,163,255,0.90)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.stroke();

    const img = ctx.getImageData(0, 0, size, size);
    map.addImage("route-badge", { width: size, height: size, data: img.data }, { pixelRatio: 2 });
}

// ---------- Overlay layers ----------
function ensureOverlay(map: maplibregl.Map) {
    const addSrc = (id: string) => {
        if (!map.getSource(id)) {
            map.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        }
    };

    // Sources
    addSrc("measure-points");
    addSrc("measure-line");
    addSrc("route-points");
    addSrc("route-line");

    addSrc("start-end");
    addSrc("triple-a");
    addSrc("triple-b");
    addSrc("triple-c");
    addSrc("triple-labels");

    // NEW: flag sources (badge + leader line)
    addSrc("triple-badge-points");
    addSrc("triple-badge-lines");

    // ✅ Pick font stack from existing style (most reliable)
    const fontStack = pickTextFontFromStyle(map);
    console.log("Overlay fontStack =", fontStack, "glyphs =", map.getStyle()?.glyphs);

    const sample = (map.getStyle()?.layers ?? []).find(
        (l: any) => l.type === "symbol" && l.layout && l.layout["text-field"] && l.layout["text-font"]
    ) as any;

    console.log("Sample style text-font =", sample?.layout?.["text-font"], "layerId=", sample?.id);

    // ✅ images
    try {
        ensurePinImage(map);
        ensureLabelBgImage(map);
        ensureRouteBadgeImage(map);
    } catch (e) {
        console.warn("Failed to register overlay images", e);
    }

    // ---------- MEASURE ----------
    if (!map.getLayer("measure-line")) {
        map.addLayer({
            id: "measure-line",
            type: "line",
            source: "measure-line",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#111", "line-width": 4, "line-opacity": 0.9 },
        });
    }

    if (!map.getLayer("measure-points")) {
        map.addLayer({
            id: "measure-points",
            type: "circle",
            source: "measure-points",
            paint: {
                "circle-radius": 5,
                "circle-color": "#111",
                "circle-stroke-width": 2,
                "circle-stroke-color": "#fff",
            },
        });
    }

    // ---------- SINGLE ROUTE ----------
    if (!map.getLayer("route-line")) {
        map.addLayer({
            id: "route-line",
            type: "line",
            source: "route-line",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#1a73e8", "line-width": 5, "line-opacity": 0.95 },
        });
    }

    if (!map.getLayer("route-points")) {
        map.addLayer({
            id: "route-points",
            type: "circle",
            source: "route-points",
            paint: {
                "circle-radius": 5,
                "circle-color": "#1a73e8",
                "circle-stroke-width": 2,
                "circle-stroke-color": "#fff",
            },
        });
    }

    // ---------- TRIPLE ROUTES (outline + fill) ----------
    const addTripleLineWithOutline = (id: string) => {
        const outlineId = `${id}-outline`;

        if (!map.getLayer(outlineId)) {
            map.addLayer({
                id: outlineId,
                type: "line",
                source: id,
                layout: { "line-cap": "round", "line-join": "round" },
                paint: {
                    "line-color": "#0b1220",
                    "line-width": 9,
                    "line-opacity": ROUTE_OPACITY * 0.4,
                },
            });
        }

        if (!map.getLayer(id)) {
            map.addLayer({
                id,
                type: "line",
                source: id,
                layout: { "line-cap": "round", "line-join": "round" },
                paint: {
                    "line-color": ROUTE_COLOR,
                    "line-width": 7,
                    "line-opacity": ROUTE_OPACITY,
                },
            });
        }
    };

    addTripleLineWithOutline("triple-a");
    addTripleLineWithOutline("triple-b");
    addTripleLineWithOutline("triple-c");

    // ---------- START / END ----------
    if (!map.getLayer("start-circle")) {
        map.addLayer({
            id: "start-circle",
            type: "circle",
            source: "start-end",
            filter: ["==", ["get", "kind"], "start"],
            paint: {
                "circle-radius": 10,
                "circle-color": "#ffffff",
                "circle-stroke-width": 4,
                "circle-stroke-color": "#0b1220",
                "circle-opacity": 1,
            },
        });
    }

    if (!map.getLayer("end-pin")) {
        map.addLayer({
            id: "end-pin",
            type: "symbol",
            source: "start-end",
            filter: ["==", ["get", "kind"], "end"],
            layout: {
                "icon-image": "end-pin",
                "icon-size": 1.5,
                "icon-anchor": "bottom",
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
            },
        });
    }

    // ---------- NEW: LABEL BACKGROUNDS (מוצא/יעד) ----------
    if (!map.getLayer("start-label-bg")) {
        map.addLayer({
            id: "start-label-bg",
            type: "symbol",
            source: "start-end",
            filter: ["==", ["get", "kind"], "start"],
            layout: {
                "icon-image": "label-bg",
                "icon-size": 1,
                "icon-anchor": "bottom",
                "icon-offset": [0, -22],
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
            },
        });
    }

    if (!map.getLayer("end-label-bg")) {
        map.addLayer({
            id: "end-label-bg",
            type: "symbol",
            source: "start-end",
            filter: ["==", ["get", "kind"], "end"],
            layout: {
                "icon-image": "label-bg",
                "icon-size": 1,
                "icon-anchor": "bottom",
                "icon-offset": [0, -34],
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
            },
        });
    }

    // ---------- LABELS: מוצא / יעד ----------
    if (!map.getLayer("start-label")) {
        map.addLayer({
            id: "start-label",
            type: "symbol",
            source: "start-end",
            filter: ["==", ["get", "kind"], "start"],
            layout: {
                "symbol-placement": "point",
                "text-field": ["to-string", ["get", "label"]],
                "text-font": LABEL_FONT_STACK,
                "text-size": 18,
                "text-anchor": "top",
                "text-offset": [0, 1.0],
                "text-allow-overlap": true,
                "text-ignore-placement": true,
                "text-optional": true,
            },
            paint: {
                "text-color": "#0b1220",
                "text-halo-color": "#ffffff",
                "text-halo-width": 2,
                "text-opacity": 1,
            },
        });
    }

    if (!map.getLayer("end-label")) {
        map.addLayer({
            id: "end-label",
            type: "symbol",
            source: "start-end",
            filter: ["==", ["get", "kind"], "end"],
            layout: {
                "symbol-placement": "point",
                "text-field": ["to-string", ["get", "label"]],
                "text-font": LABEL_FONT_STACK,
                "text-size": 18,
                "text-anchor": "top",
                "text-offset": [0, 1.2],
                "text-allow-overlap": true,
                "text-ignore-placement": true,
                "text-optional": true,
            },
            paint: {
                "text-color": "#0b1220",
                "text-halo-color": "#ffffff",
                "text-halo-width": 2,
                "text-opacity": 1,
            },
        });
    }

    // ---------- LABELS: א / ב / ג (ישן - נשאר אבל נזין ריק) ----------
    if (!map.getLayer("triple-labels")) {
        map.addLayer({
            id: "triple-labels",
            type: "symbol",
            source: "triple-labels",
            layout: {
                "symbol-placement": "point",
                "text-field": ["to-string", ["get", "label"]],
                "text-font": LABEL_FONT_STACK,
                "text-size": 22,
                "text-anchor": "center",
                "text-offset": [0, 0],
                "text-allow-overlap": true,
                "text-ignore-placement": true,
                "text-optional": true,
            },
            paint: {
                "text-color": "#0b1220",
                "text-halo-color": "#ffffff",
                "text-halo-width": 2,
                "text-opacity": 1,
            },
        });
    }

    // ---------- DEBUG DOTS (to prove features exist) ----------
    if (!map.getLayer("triple-labels-dot")) {
        map.addLayer({
            id: "triple-labels-dot",
            type: "circle",
            source: "triple-labels",
            paint: {
                "circle-radius": 6,
                "circle-color": "#ff00ff",
                "circle-stroke-width": 2,
                "circle-stroke-color": "#ffffff",
            },
        });
    }

    // ---------- NEW: FLAGS for א/ב/ג (leader line + badge + text) ----------
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

    if (!map.getLayer("triple-badge-text")) {
        map.addLayer({
            id: "triple-badge-text",
            type: "symbol",
            source: "triple-badge-points",
            layout: {
                "text-field": ["to-string", ["get", "label"]],
                "text-font": LABEL_FONT_STACK,
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

    // ✅ Make sure labels are on top
    try {
        map.moveLayer("start-label-bg");
    } catch { }
    try {
        map.moveLayer("end-label-bg");
    } catch { }

    try {
        map.moveLayer("start-label");
    } catch { }
    try {
        map.moveLayer("end-label");
    } catch { }

    try {
        map.moveLayer("triple-labels-dot");
    } catch { }
    try {
        map.moveLayer("end-pin");
    } catch { }
    try {
        map.moveLayer("start-circle");
    } catch { }

    try {
        map.moveLayer("triple-badge-lines");
    } catch { }
    try {
        map.moveLayer("triple-badges");
    } catch { }
    try {
        map.moveLayer("triple-badge-text");
    } catch { }

    try {
        map.moveLayer("triple-labels");
    } catch { }
}

type RouteState = "idle" | "loading" | "snapped" | "fallback";

function Badge({ state, text }: { state: RouteState; text: string }) {
    const bg =
        state === "loading" ? "#1f2937" : state === "snapped" ? "#064e3b" : state === "fallback" ? "#7c2d12" : "#111827";
    return (
        <span style={{ background: bg, color: "#fff", padding: "3px 8px", borderRadius: 999, fontSize: 12 }}>
            {text}
        </span>
    );
}

export default function App() {
    const mapDivRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<maplibregl.Map | null>(null);

    const [mode, setMode] = useState<Mode>("TRIPLE");
    const [labelLang, setLabelLang] = useState<LabelLang>("he");

    const [showRoads, setShowRoads] = useState(true);
    const [showTransit, setShowTransit] = useState(true);
    const [showLabels, setShowLabels] = useState(true);
    const [showPOI, setShowPOI] = useState(true);

    const [measurePts, setMeasurePts] = useState<LngLat[]>([]);

    const [routeWaypoints, setRouteWaypoints] = useState<LngLat[]>([]);
    const [routeLine, setRouteLine] = useState<LngLat[]>([]);
    const [singleState, setSingleState] = useState<RouteState>("idle");

    const [tripleStart, setTripleStart] = useState<LngLat | null>(null);
    const [tripleEnd, setTripleEnd] = useState<LngLat | null>(null);
    const [diversity, setDiversity] = useState(0.45);
    const [diversityDebounced, setDiversityDebounced] = useState(0.45);

    const [routeA, setRouteA] = useState<LngLat[]>([]);
    const [routeB, setRouteB] = useState<LngLat[]>([]);
    const [routeC, setRouteC] = useState<LngLat[]>([]);
    const [stateA, setStateA] = useState<RouteState>("idle");
    const [stateB, setStateB] = useState<RouteState>("idle");
    const [stateC, setStateC] = useState<RouteState>("idle");

    // avoid stale in click handler
    const modeRef = useRef<Mode>("TRIPLE");
    useEffect(() => {
        modeRef.current = mode;
    }, [mode]);

    const tripleRef = useRef<{ start: LngLat | null; end: LngLat | null }>({ start: null, end: null });
    useEffect(() => {
        tripleRef.current = { start: tripleStart, end: tripleEnd };
    }, [tripleStart, tripleEnd]);

    // debounce diversity
    useEffect(() => {
        const t = setTimeout(() => setDiversityDebounced(diversity), 250);
        return () => clearTimeout(t);
    }, [diversity]);

    const measureDist = useMemo(() => polylineMeters(measurePts), [measurePts]);
    const singleDist = useMemo(
        () => polylineMeters(routeLine.length ? routeLine : routeWaypoints),
        [routeLine, routeWaypoints]
    );
    const distA = useMemo(() => polylineMeters(routeA), [routeA]);
    const distB = useMemo(() => polylineMeters(routeB), [routeB]);
    const distC = useMemo(() => polylineMeters(routeC), [routeC]);

    // init map
    useEffect(() => {
        if (!mapDivRef.current) return;
        if (mapRef.current) return;

        ensureRTLPluginLoadedOnce();

        const map = new maplibregl.Map({
            container: mapDivRef.current,
            style: STYLE_URL,
            center: [34.7818, 32.0853],
            zoom: 13.8,
        });

        map.on("styleimagemissing", (e) => {
            const id = ((e as any)?.id as string | undefined) ?? "";
            const transparent = new Uint8Array([0, 0, 0, 0]);

            try {
                if (id.trim() === "") {
                    if (!map.hasImage(" ")) map.addImage(" ", { width: 1, height: 1, data: transparent });
                    return;
                }

                // אופציונלי: להשתיק גם אייקונים חסרים אחרים (exit_2, office)
                if (!map.hasImage(id)) map.addImage(id, { width: 1, height: 1, data: transparent });
            } catch {
                // ignore
            }
        });

        // ואז ממשיכים כרגיל:
        map.on("load", () => {
            // ensureOverlay(map) וכו'
        });

        map.addControl(new maplibregl.NavigationControl(), "top-left");
        map.addControl(new maplibregl.ScaleControl({ maxWidth: 140, unit: "metric" }), "bottom-left");

        map.on("styleimagemissing", (e) => {
            const id = (e as any)?.id;
            if (!id || id.trim() === "") {
                // “אייקון ריק” – נרשום אייקון 1x1 שקוף כדי להשתיק
                const data = new Uint8Array([0, 0, 0, 0]);
                try {
                    map.addImage(" ", { width: 1, height: 1, data });
                } catch { }
            }
        });
        map.on("styleimagemissing", (e) => {
            const id = (e as any)?.id as string | undefined;

            // אם חסר "אייקון ריק" או שם שהוא רק רווחים
            if (!id || id.trim() === "") {
                const transparent = new Uint8Array([0, 0, 0, 0]); // RGBA שקוף

                try {
                    // MapLibre מבקש לפעמים ממש את השם " " (רווח)
                    if (!map.hasImage(" ")) {
                        map.addImage(" ", { width: 1, height: 1, data: transparent });
                    }
                } catch {
                    // ignore
                }

                return;
            }

            // (אופציונלי) אם תרצה להשתיק גם אייקונים חסרים אחרים:
            // if (!map.hasImage(id)) map.addImage(id, { width: 1, height: 1, data: transparent });
        });

        map.on("load", () => {
            ensureOverlay(map);

            toggleBy(map, isRoadLayer, showRoads);
            toggleBy(map, isTransitLayer, showTransit);
            toggleBy(map, (l) => isLabelLayer(l) && !isPoiLayer(l), showLabels);
            toggleBy(map, isPoiLayer, showPOI);

            applyLabelLang(map, labelLang);

            setFC(map, "measure-points", fcPoints([]));
            setFC(map, "measure-line", fcLine([]));
            setFC(map, "route-points", fcPoints([]));
            setFC(map, "route-line", fcLine([]));

            setFC(map, "start-end", fcPoints([]));
            setFC(map, "triple-a", fcLine([]));
            setFC(map, "triple-b", fcLine([]));
            setFC(map, "triple-c", fcLine([]));
            setFC(map, "triple-labels", fcPoints([]));

            // NEW: init flag sources
            setFC(map, "triple-badge-points", fcPoints([]));
            setFC(map, "triple-badge-lines", fcLines([]));

            console.log("triple-labels features:", (map.getSource("triple-labels") as any)?._data);
            try {
                map.moveLayer("triple-labels");
            } catch { }
            try {
                map.moveLayer("start-label");
            } catch { }
            try {
                map.moveLayer("end-label");
            } catch { }
            try {
                map.moveLayer("start-circle");
            } catch { }
            try {
                map.moveLayer("end-pin");
            } catch { }
        });

        map.on("click", (e) => {
            const ll: LngLat = [e.lngLat.lng, e.lngLat.lat];
            const m = modeRef.current;

            if (m === "MEASURE") {
                setMeasurePts((p) => [...p, ll]);
                return;
            }
            if (m === "ROUTE") {
                setRouteWaypoints((p) => [...p, ll]);
                return;
            }

            // TRIPLE
            const cur = tripleRef.current;

            if (!cur.start) {
                tripleRef.current = { start: ll, end: null };
                setTripleStart(ll);
                setTripleEnd(null);
                return;
            }

            if (!cur.end) {
                tripleRef.current = { start: cur.start, end: ll };
                setTripleEnd(ll);
                return;
            }

            // third click => restart
            tripleRef.current = { start: ll, end: null };
            setTripleStart(ll);
            setTripleEnd(null);
            setRouteA([]);
            setRouteB([]);
            setRouteC([]);
        });

        mapRef.current = map;

        return () => {
            map.remove();
            mapRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // toggles
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !map.isStyleLoaded()) return;

        toggleBy(map, isRoadLayer, showRoads);
        toggleBy(map, isTransitLayer, showTransit);
        toggleBy(map, (l) => isLabelLayer(l) && !isPoiLayer(l), showLabels);
        toggleBy(map, isPoiLayer, showPOI);
    }, [showRoads, showTransit, showLabels, showPOI]);

    // language
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !map.isStyleLoaded()) return;
        applyLabelLang(map, labelLang);
    }, [labelLang]);

    // measure
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        setFC(map, "measure-points", fcPoints(measurePts));
        setFC(map, "measure-line", fcLine(measurePts));
    }, [measurePts]);

    // start/end source: includes labels
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        const coords: LngLat[] = [];
        const props: any[] = [];

        if (tripleStart) {
            coords.push(tripleStart);
            props.push({ kind: "start", label: "מוצא" });
        }
        if (tripleEnd) {
            coords.push(tripleEnd);
            props.push({ kind: "end", label: "יעד" });
        }

        setFC(map, "start-end", fcPoints(coords, props));
    }, [tripleStart, tripleEnd]);

    // single route
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        setFC(map, "route-points", fcPoints(routeWaypoints));

        if (routeWaypoints.length < 2) {
            setRouteLine([]);
            setFC(map, "route-line", fcLine([]));
            setSingleState("idle");
            return;
        }

        const ac = new AbortController();
        setSingleState("loading");

        (async () => {
            const { line } = await osrmRoute(routeWaypoints, ac.signal);
            if (ac.signal.aborted) return;

            if (line && line.length >= 2) {
                setRouteLine(line);
                setFC(map, "route-line", fcLine(line));
                setSingleState("snapped");
            } else {
                setRouteLine([]);
                setFC(map, "route-line", fcLine(routeWaypoints));
                setSingleState("fallback");
            }
        })();

        return () => ac.abort();
    }, [routeWaypoints]);

    // triple routes + flags א/ב/ג
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        if (!tripleStart || !tripleEnd) {
            setRouteA([]);
            setRouteB([]);
            setRouteC([]);
            setStateA("idle");
            setStateB("idle");
            setStateC("idle");
            setFC(map, "triple-a", fcLine([]));
            setFC(map, "triple-b", fcLine([]));
            setFC(map, "triple-c", fcLine([]));
            setFC(map, "triple-labels", fcPoints([]));

            // NEW: clear flags
            setFC(map, "triple-badge-points", fcPoints([]));
            setFC(map, "triple-badge-lines", fcLines([]));

            return;
        }

        const d = clamp(diversityDebounced, 0, 1);
        const ac = new AbortController();

        setStateA("loading");
        setStateB("loading");
        setStateC("loading");

        (async () => {
            const { line: aLine } = await osrmRoute([tripleStart, tripleEnd], ac.signal);
            if (ac.signal.aborted) return;

            const { via1, via2 } = buildViaPoints(map, tripleStart, tripleEnd, d);

            await sleep(120);
            const { line: bLine } = await osrmRoute([tripleStart, via1, tripleEnd], ac.signal);
            if (ac.signal.aborted) return;

            await sleep(120);
            const { line: cLine } = await osrmRoute([tripleStart, via2, tripleEnd], ac.signal);
            if (ac.signal.aborted) return;

            const a = aLine ?? [tripleStart, tripleEnd];
            const b = bLine ?? [tripleStart, via1, tripleEnd];
            const c = cLine ?? [tripleStart, via2, tripleEnd];

            setRouteA(a);
            setRouteB(b);
            setRouteC(c);

            setFC(map, "triple-a", fcLine(a));
            setFC(map, "triple-b", fcLine(b));
            setFC(map, "triple-c", fcLine(c));

            setStateA(aLine ? "snapped" : "fallback");
            setStateB(bLine ? "snapped" : "fallback");
            setStateC(cLine ? "snapped" : "fallback");

            // ----- NEW: FLAGS (א/ב/ג) ליד מרכז המסלול + קו מחבר -----
            const anchorA: LngLat = a[Math.floor(a.length / 2)] ?? midpoint(tripleStart, tripleEnd);
            const anchorB: LngLat = b[Math.floor(b.length / 2)] ?? via1;
            const anchorC: LngLat = c[Math.floor(c.length / 2)] ?? via2;

            // חישוב כיוון במטרים (מזרח/צפון) לפי lat
            const midLat = (tripleStart[1] + tripleEnd[1]) / 2;
            const metersPerDegLat = 111132.92;
            const metersPerDegLng = 111412.84 * Math.cos((midLat * Math.PI) / 180);

            const dxm = (tripleEnd[0] - tripleStart[0]) * (metersPerDegLng || 1);
            const dym = (tripleEnd[1] - tripleStart[1]) * metersPerDegLat;
            const lenm = Math.max(1e-6, Math.hypot(dxm, dym));

            const vx = dxm / lenm; // לאורך
            const vy = dym / lenm;
            const ux = -vy; // ניצב
            const uy = vx;

            const { w, h } = viewportSizeMeters(map);
            const base = Math.min(w, h);

            // אורך דגל "סביר" ותלוי שונות
            const side = clamp(d, 0, 1) * (0.08 * base) + 120; // מטרים
            const along = 0.03 * base; // מטרים

            const bounds = map.getBounds();
            const placeFlag = (anchor: LngLat, sideSign: number, alongSign: number) => {
                const p = offsetMeters(
                    anchor,
                    ux * side * sideSign + vx * along * alongSign,
                    uy * side * sideSign + vy * along * alongSign
                );
                return withinBounds(p, bounds);
            };

            // פיזור בסיסי כדי לא לחפוף
            const flagA = placeFlag(anchorA, +1, +1);
            const flagB = placeFlag(anchorB, -1, +1);
            const flagC = placeFlag(anchorC, +1, -1);

            setFC(
                map,
                "triple-badge-points",
                fcPoints([flagA, flagB, flagC], [{ label: "א" }, { label: "ב" }, { label: "ג" }])
            );
            setFC(map, "triple-badge-lines", fcLines([[anchorA, flagA], [anchorB, flagB], [anchorC, flagC]]));

            // השאר את השכבה הישנה ריקה כדי שלא יופיעו נקודות/טקסט עליה
            setFC(map, "triple-labels", fcPoints([]));
        })();

        return () => ac.abort();
    }, [tripleStart, tripleEnd, diversityDebounced]);

    // UI actions
    const zoomToTA = () => mapRef.current?.flyTo({ center: [34.7818, 32.0853], zoom: 14.6, speed: 1.2 });

    const clearMeasure = () => setMeasurePts([]);
    const clearSingle = () => {
        setRouteWaypoints([]);
        setRouteLine([]);
        setSingleState("idle");
        const map = mapRef.current;
        if (!map) return;
        setFC(map, "route-points", fcPoints([]));
        setFC(map, "route-line", fcLine([]));
    };
    const clearTriple = () => {
        tripleRef.current = { start: null, end: null };
        setTripleStart(null);
        setTripleEnd(null);
        setRouteA([]);
        setRouteB([]);
        setRouteC([]);
        setStateA("idle");
        setStateB("idle");
        setStateC("idle");
        const map = mapRef.current;
        if (!map) return;
        setFC(map, "start-end", fcPoints([]));
        setFC(map, "triple-a", fcLine([]));
        setFC(map, "triple-b", fcLine([]));
        setFC(map, "triple-c", fcLine([]));
        setFC(map, "triple-labels", fcPoints([]));

        // NEW
        setFC(map, "triple-badge-points", fcPoints([]));
        setFC(map, "triple-badge-lines", fcLines([]));
    };
    const clearAll = () => {
        clearMeasure();
        clearSingle();
        clearTriple();
    };

    const anyRoutingLoading = singleState === "loading" || stateA === "loading" || stateB === "loading" || stateC === "loading";
    const anyFallback = singleState === "fallback" || stateA === "fallback" || stateB === "fallback" || stateC === "fallback";

    return (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", height: "100vh", width: "100vw" }}>
            <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

            {/* MAP */}
            <div style={{ position: "relative", minHeight: 0 }}>
                <div ref={mapDivRef} style={{ position: "absolute", inset: 0 }} />

                {/* Overlay "thinking" on the map */}
                {anyRoutingLoading && (
                    <div
                        style={{
                            position: "absolute",
                            left: 16,
                            top: 16,
                            zIndex: 10,
                            background: "rgba(17,24,39,0.85)",
                            color: "#fff",
                            padding: "10px 12px",
                            borderRadius: 12,
                            display: "flex",
                            gap: 10,
                            alignItems: "center",
                            boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
                            backdropFilter: "blur(6px)",
                        }}
                    >
                        <div
                            style={{
                                width: 18,
                                height: 18,
                                borderRadius: "999px",
                                border: "3px solid rgba(255,255,255,0.35)",
                                borderTopColor: "#fff",
                                animation: "spin 0.9s linear infinite",
                            }}
                        />
                        <div style={{ fontSize: 13, fontWeight: 700 }}>מחשב מסלולים…</div>
                    </div>
                )}
            </div>

            {/* PANEL */}
            <div
                style={{
                    borderLeft: "1px solid #222",
                    padding: 12,
                    fontFamily: "system-ui",
                    background: "#0b0b0c",
                    color: "#fff",
                    overflow: "auto",
                    direction: "rtl",
                }}
            >
                <h3 style={{ margin: "8px 0" }}>GeoVis Lab</h3>

                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
                    {anyRoutingLoading && <Badge state="loading" text="מחשב מסלולים…" />}
                    {!anyRoutingLoading && anyFallback && <Badge state="fallback" text="חלק מהמסלולים בקו ישר (OSRM לא זמין)" />}
                    {!anyRoutingLoading && !anyFallback && (routeWaypoints.length >= 2 || (tripleStart && tripleEnd)) && (
                        <Badge state="snapped" text="מסלולים מוצמדים לרחובות" />
                    )}
                </div>

                <div style={{ fontSize: 12, color: "#a3a3a3", marginBottom: 10 }}>
                    <b>3 מסלולים:</b> קליק 1 = <b>מוצא</b>, קליק 2 = <b>יעד</b>. קליק נוסף מתחיל מחדש.
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                    <button onClick={() => setMode("TRIPLE")}>3 מסלולים</button>
                    <button onClick={() => setMode("ROUTE")}>מסלול יחיד</button>
                    <button onClick={() => setMode("MEASURE")}>מדידה</button>
                    <button onClick={zoomToTA}>זום לת״א</button>
                    <button onClick={clearAll}>ניקוי הכל</button>
                </div>

                <div style={{ marginBottom: 10 }}>
                    <label>
                        שפת תוויות:{" "}
                        <select value={labelLang} onChange={(e) => setLabelLang(e.target.value as LabelLang)}>
                            <option value="he">עברית</option>
                            <option value="en">English</option>
                        </select>
                    </label>
                </div>

                <fieldset style={{ border: "1px solid #333", borderRadius: 10, padding: 10, marginBottom: 12 }}>
                    <legend>שכבות</legend>
                    <label style={{ display: "block" }}>
                        <input type="checkbox" checked={showRoads} onChange={(e) => setShowRoads(e.target.checked)} /> כבישים
                    </label>
                    <label style={{ display: "block" }}>
                        <input type="checkbox" checked={showTransit} onChange={(e) => setShowTransit(e.target.checked)} /> תחבורה ציבורית
                    </label>
                    <label style={{ display: "block" }}>
                        <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> תוויות (שמות)
                    </label>
                    <label style={{ display: "block" }}>
                        <input type="checkbox" checked={showPOI} onChange={(e) => setShowPOI(e.target.checked)} /> POI
                    </label>
                </fieldset>

                <fieldset style={{ border: "1px solid #333", borderRadius: 10, padding: 10, marginBottom: 12 }}>
                    <legend>3 מסלולים (א/ב/ג)</legend>

                    <div style={{ fontSize: 12, color: "#cbd5e1", marginBottom: 8 }}>
                        נקודות: {tripleStart ? "מוצא ✓" : "מוצא —"} · {tripleEnd ? "יעד ✓" : "יעד —"}
                    </div>

                    <label style={{ display: "block", fontSize: 12, color: "#cbd5e1" }}>שונות: {Math.round(diversity * 100)}%</label>

                    <input
                        type="range"
                        min={0}
                        max={100}
                        value={Math.round(diversity * 100)}
                        onChange={(e) => setDiversity(parseInt(e.target.value, 10) / 100)}
                        style={{ width: "100%" }}
                    />

                    <div style={{ fontSize: 12, color: "#a3a3a3", marginTop: 6 }}>
                        0% = כמעט ללא שונות · 100% = שונות מקסימלית בתוך גבולות התצוגה.
                    </div>

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                        <button onClick={clearTriple}>ניקוי 3 מסלולים</button>
                    </div>

                    <div style={{ marginTop: 10, fontSize: 13, display: "grid", gap: 6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span>א: <b>{routeA.length ? fmtDistance(distA) : "—"}</b></span>
                            <Badge state={stateA} text={stateA === "loading" ? "מחשב…" : stateA === "snapped" ? "מוצמד" : stateA === "fallback" ? "קו ישר" : "—"} />
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span>ב: <b>{routeB.length ? fmtDistance(distB) : "—"}</b></span>
                            <Badge state={stateB} text={stateB === "loading" ? "מחשב…" : stateB === "snapped" ? "מוצמד" : stateB === "fallback" ? "קו ישר" : "—"} />
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span>ג: <b>{routeC.length ? fmtDistance(distC) : "—"}</b></span>
                            <Badge state={stateC} text={stateC === "loading" ? "מחשב…" : stateC === "snapped" ? "מוצמד" : stateC === "fallback" ? "קו ישר" : "—"} />
                        </div>
                    </div>
                </fieldset>

                <fieldset style={{ border: "1px solid #333", borderRadius: 10, padding: 10, marginBottom: 12 }}>
                    <legend>מסלול יחיד</legend>
                    <div style={{ fontSize: 12, color: "#a3a3a3", marginBottom: 8 }}>
                        במצב "מסלול יחיד" כל קליק מוסיף waypoint, והמערכת מצמידה לרחובות דרך OSRM.
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span>Waypoints: <b>{routeWaypoints.length}</b></span>
                        <Badge state={singleState} text={singleState === "loading" ? "מחשב…" : singleState === "snapped" ? "מוצמד" : singleState === "fallback" ? "קו ישר" : "—"} />
                    </div>
                    <div>אורך: <b>{routeWaypoints.length >= 2 ? fmtDistance(singleDist) : "—"}</b></div>
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <button onClick={clearSingle}>ניקוי מסלול יחיד</button>
                    </div>
                </fieldset>

                <fieldset style={{ border: "1px solid #333", borderRadius: 10, padding: 10 }}>
                    <legend>מדידה</legend>
                    <div style={{ fontSize: 12, color: "#a3a3a3", marginBottom: 8 }}>
                        במצב "מדידה" כל קליק מוסיף נקודה, והקו מחשב מרחק גאודזי.
                    </div>
                    <div>נקודות: <b>{measurePts.length}</b></div>
                    <div>מרחק: <b>{measurePts.length >= 2 ? fmtDistance(measureDist) : "—"}</b></div>
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <button onClick={clearMeasure}>ניקוי מדידה</button>
                    </div>
                </fieldset>
            </div>
        </div>
    );
}
