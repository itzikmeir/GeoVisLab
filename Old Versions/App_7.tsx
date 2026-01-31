import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

type LngLat = [number, number];
type Mode = "TRIPLE" | "SINGLE" | "MEASURE";
type Lang = "he" | "en" | "local";

const MAPTILER_KEY = "mpLN2pWAtDH8gsonXvRt";
const STYLE_URL = `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`;

// Routes styling (בהיר ושקוף יותר)
const ROUTE_COLOR = "#8CCBFF";
const ROUTE_OPACITY = 0.42;
const OUTLINE_OPACITY = 0.22;

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

    // ניסיון "Regular" כדי להימנע מבעיות עברית/italic
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

    // shadow
    ctx.beginPath();
    ctx.ellipse(0, 16, 10, 4, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fill();

    // pin
    ctx.beginPath();
    ctx.moveTo(0, 18);
    ctx.bezierCurveTo(10, 10, 14, 3, 14, -4);
    ctx.arc(0, -4, 14, 0, Math.PI, true);
    ctx.bezierCurveTo(-14, 3, -10, 10, 0, 18);
    ctx.closePath();
    ctx.fillStyle = "#e11d48";
    ctx.fill();

    // inner
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
    if (map.hasImage("route-badge")) return;

    const size = 52;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rgb = hexToRgb(ROUTE_COLOR) ?? { r: 140, g: 203, b: 255 };

    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, 18, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${ROUTE_OPACITY})`; // זהה למסלול
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.stroke();

    const img = ctx.getImageData(0, 0, size, size);
    map.addImage("route-badge", { width: size, height: size, data: img.data }, { pixelRatio: 2 });
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
    return (
        type === "symbol" &&
        !isOverlayLayerId(String(l.id || "")) &&
        (id.includes("label") || id.includes("place") || id.includes("poi") || id.includes("name"))
    );
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
    return (
        !isOverlayLayerId(String(l.id || "")) &&
        (id.includes("transit") || id.includes("rail") || id.includes("subway") || id.includes("train"))
    );
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

    const fontStack = pickTextFontFromStyle(map);

    // images
    try {
        ensurePinImage(map);
        ensureLabelBgImage(map);
        ensureBadgeImage(map);
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
                "icon-offset": offsetPx, // pixels
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

    // Badge connector lines ("דגל")
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

    // Badge background circle
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

    // Badge text (א/ב/ג) — חייב להיות מעל העיגול
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

    // Ensure order (טקסט מעל רקעים)
    const moveSafe = (id: string) => {
        try {
            map.moveLayer(id);
        } catch { }
    };

    // דגלונים: קו -> עיגול -> טקסט
    moveSafe("triple-badge-lines");
    moveSafe("triple-badges");
    moveSafe("triple-badge-text");

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
function buildConnectorFC(anchors: AnchorPoint[], badges: BadgePoint[]) {
    const mapBadge = new Map<BadgeId, LngLat>(badges.map((b) => [b.id, b.coord]));
    return fcLines(
        anchors.map((a) => ({
            coords: [a.coord, mapBadge.get(a.id)!],
            props: { id: a.id },
        }))
    );
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
    const singleDist = useMemo(
        () => polylineMeters(singleLine.length ? singleLine : singleWaypoints),
        [singleLine, singleWaypoints]
    );

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

            // apply initial map settings
            applyLanguage(map, lang, originalTextFieldRef);
            toggleLayers(map, isRoadLayer, showRoads);
            toggleLayers(map, isTransitLayer, showTransit);
            toggleLayers(map, (l) => isLabelLayer(l) && !isPoiLayer(l), showLabels);
            toggleLayers(map, isPoiLayer, showPOI);

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
                    if (a.length) setFC(map, "triple-badge-lines", buildConnectorFC(a, nextBadges));
                };

                map.on("mousemove", (ev) => {
                    // hover cursor
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

            if (m === "MEASURE") {
                setMeasurePts((prev) => [...prev, ll]);
                return;
            }

            if (m === "SINGLE") {
                setSingleWaypoints((prev) => [...prev, ll]);
                return;
            }

            // TRIPLE: רק בחירת נקודות (לא מחשב אוטומטית)
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

    // Compute single route (עדיין אוטומטי כמו קודם)
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
                setFC(map, "single-line", fcLine(singleWaypoints)); // fallback straight
            }
            setIsRoutingSingle(false);
        })();

        return () => {
            cancelled = true;
            setIsRoutingSingle(false);
        };
    }, [singleWaypoints]);

    // Render start/end labels
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

    // כשמשנים נקודות — מנקים תוצאות עד שיילחץ "חישוב"
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        if (!map.isStyleLoaded()) return;
        if (!map.getSource("triple-a")) return;

        // אם אין זוג נקודות מלא — נקי
        if (!start || !end) {
            setFC(map, "triple-a", fcLine([]));
            setFC(map, "triple-b", fcLine([]));
            setFC(map, "triple-c", fcLine([]));
            setFC(map, "triple-badge-points", fcPoints([]));
            setFC(map, "triple-badge-lines", fcLines([]));
            setBadges([]);
            setAnchors([]);
            return;
        }

        // יש 2 נקודות — עדיין לא מחשבים אוטומטית. נשאיר ריק עד "חישוב".
        setFC(map, "triple-a", fcLine([]));
        setFC(map, "triple-b", fcLine([]));
        setFC(map, "triple-c", fcLine([]));
        setFC(map, "triple-badge-points", fcPoints([]));
        setFC(map, "triple-badge-lines", fcLines([]));
        setBadges([]);
        setAnchors([]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [start, end]);

    // Compute triple routes + badges ONLY on "calcNonce" (לחיצה על "חישוב")
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        if (!start || !end) return;
        if (!map.getSource("triple-a")) return;
        if (calcNonce <= 0) return; // עד שלא לחצו

        let cancelled = false;

        (async () => {
            setIsRoutingTriple(true);

            const bounds = map.getBounds();
            const widthLng = Math.abs(bounds.getEast() - bounds.getWest());
            const heightLat = Math.abs(bounds.getNorth() - bounds.getSouth());
            const baseOffset = (0.06 + diversity * 0.10) * Math.min(widthLng, heightLat);

            const dx = end[0] - start[0];
            const dy = end[1] - start[1];

            // unit perpendicular
            const px = -dy,
                py = dx;
            const plen = Math.sqrt(px * px + py * py) || 1;
            const ux = px / plen,
                uy = py / plen;

            // unit direction
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

            setFC(map, "triple-a", fcLine(a));
            setFC(map, "triple-b", fcLine(bLine));
            setFC(map, "triple-c", fcLine(cLine));

            // anchors
            const anchorA = midpointOnLine(a);
            const anchorB = midpointOnLine(bLine);
            const anchorC = midpointOnLine(cLine);

            const newAnchors: AnchorPoint[] = [
                { id: "A", coord: anchorA },
                { id: "B", coord: anchorB },
                { id: "C", coord: anchorC },
            ];
            setAnchors(newAnchors);

            // קו דגלון קצר יותר: משתמשים בשבר קטן מה-offset
            const side = baseOffset * 0.35;
            const along = baseOffset * 0.15;

            const makeBadge = (anchor: LngLat, sign: number, alongK: number) => {
                let p: LngLat = [
                    anchor[0] + ux * side * sign + vx * along * alongK,
                    anchor[1] + uy * side * sign + vy * along * alongK,
                ];
                p = clampToBounds(p, bounds, 0.07);
                return p;
            };

            let badgeA = makeBadge(anchorA, +1, 0.8);
            let badgeB = makeBadge(anchorB, -1, 0.8);
            let badgeC = makeBadge(anchorC, +1, -0.8);

            // basic de-overlap
            const thresh = baseOffset * 0.45;
            const nudge = (p: LngLat, k: number) =>
                [p[0] + ux * side * 0.45 * k, p[1] + uy * side * 0.45 * k] as LngLat;

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
            setFC(map, "triple-badge-lines", buildConnectorFC(newAnchors, newBadges));

            setIsRoutingTriple(false);
        })();

        return () => {
            cancelled = true;
            setIsRoutingTriple(false);
        };
    }, [calcNonce]); // ⬅️ רק לחיצה על "חישוב" מפעילה

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
        const map = mapRef.current;
        if (!map) return;
        setFC(map, "triple-a", fcLine([]));
        setFC(map, "triple-b", fcLine([]));
        setFC(map, "triple-c", fcLine([]));
        setFC(map, "triple-badge-points", fcPoints([]));
        setFC(map, "triple-badge-lines", fcLines([]));
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
                    <div style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>
                        הערה: זה משנה את תוויות ה־basemap בלבד (לא “מוצא/יעד/א-ב-ג”).
                    </div>
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
                        <label
                            key={x.label}
                            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 4px" }}
                        >
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
                            <b>חישוב</b> מתבצע רק בלחיצה על הכפתור. אחרי חישוב אפשר <b>לגרור</b> את הדגלונים על המפה.
                        </div>

                        <div style={{ fontWeight: 800, marginBottom: 8 }}>שונות</div>
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={diversity}
                            onChange={(e) => setDiversity(parseFloat(e.target.value))}
                            style={{ width: "100%" }}
                        />
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

                <div style={{ fontSize: 12, opacity: 0.65 }}>
                    טיפ: אחרי חישוב 3 מסלולים, אפשר לגרור את הדגלונים ולמקם אותם בדיוק איפה שנוח.
                </div>
            </div>
        </div>
    );
}
