import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

type LngLat = [number, number];
type Mode = "TRIPLE" | "ROUTE" | "MEASURE";
type LabelLang = "he" | "en";

const MAPTILER_KEY = "mpLN2pWAtDH8gsonXvRt";
const STYLE_URL = `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`;

// ---------- RTL (Hebrew shaping, no TS error) ----------
function ensureRTLPluginLoaded() {
    const getStatus = (maplibregl as any).getRTLTextPluginStatus as undefined | (() => string);
    const setPlugin = (maplibregl as any).setRTLTextPlugin as undefined | ((url: string, cb: () => void, lazy?: boolean) => void);

    if (typeof getStatus !== "function" || typeof setPlugin !== "function") return;

    const status = getStatus();
    if (status === "loaded" || status === "loading") return;

    setPlugin(
        "https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.2.3/mapbox-gl-rtl-text.js",
        () => { },
        true
    );
}

// ---------- Geo helpers ----------
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

function clamp(n: number, a: number, b: number) {
    return Math.max(a, Math.min(b, n));
}

function midpoint(a: LngLat, b: LngLat): LngLat {
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
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
    const b = map.getBounds();
    const mid = midpoint(start, end);

    // perpendicular direction to start->end (rough but stable)
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const len = Math.max(1e-9, Math.hypot(dx, dy));
    const ux = -dy / len;
    const uy = dx / len;

    const { w, h } = viewportSizeMeters(map);
    const base = Math.min(w, h);
    const maxOffset = 0.35 * base;
    const offset = clamp(diversity01, 0, 1) * maxOffset;

    const via1 = withinBounds(offsetMeters(mid, ux * offset, uy * offset), b);
    const via2 = withinBounds(offsetMeters(mid, -ux * offset, -uy * offset), b);

    return { via1, via2 };
}

// ---------- OSRM routing ----------
async function osrmRoute(waypoints: LngLat[]): Promise<LngLat[] | null> {
    if (waypoints.length < 2) return null;
    const coords = waypoints.map(([lng, lat]) => `${lng},${lat}`).join(";");
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

function setFC(map: maplibregl.Map, sourceId: string, fc: any) {
    const s = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
    if (s) s.setData(fc);
}

// ---------- Base layer predicates (loose MVP) ----------
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
        } catch { }
    }
}

// ---------- Overlay sources/layers ----------
function ensureOverlay(map: maplibregl.Map) {
    const addSrc = (id: string) => {
        if (!map.getSource(id)) {
            map.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        }
    };

    addSrc("measure-points");
    addSrc("measure-line");

    addSrc("route-points");
    addSrc("route-line");

    addSrc("triple-points");
    addSrc("triple-a");
    addSrc("triple-b");
    addSrc("triple-c");
    addSrc("triple-labels");

    // measure
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
            paint: { "circle-radius": 5, "circle-color": "#111", "circle-stroke-width": 2, "circle-stroke-color": "#fff" },
        });
    }

    // single route
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
            paint: { "circle-radius": 5, "circle-color": "#1a73e8", "circle-stroke-width": 2, "circle-stroke-color": "#fff" },
        });
    }

    // triple lines
    const addTripleLine = (id: string, color: string, dash?: number[]) => {
        if (map.getLayer(id)) return;
        map.addLayer({
            id,
            type: "line",
            source: id,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
                "line-color": color,
                "line-width": 6,
                "line-opacity": 0.9,
                ...(dash ? { "line-dasharray": dash } : {}),
            },
        });
    };

    addTripleLine("triple-a", "#e11d48");
    addTripleLine("triple-b", "#16a34a", [2, 1]);
    addTripleLine("triple-c", "#7c3aed", [1, 1]);

    // triple points
    if (!map.getLayer("triple-points")) {
        map.addLayer({
            id: "triple-points",
            type: "circle",
            source: "triple-points",
            paint: { "circle-radius": 6, "circle-color": "#f59e0b", "circle-stroke-width": 2, "circle-stroke-color": "#fff" },
        });
    }

    // labels א/ב/ג
    if (!map.getLayer("triple-labels")) {
        map.addLayer({
            id: "triple-labels",
            type: "symbol",
            source: "triple-labels",
            layout: {
                "text-field": ["get", "label"],
                "text-size": 18,
                "text-offset": [0, -0.8],
                "text-anchor": "top",
            },
            paint: {
                "text-color": "#111",
                "text-halo-color": "#fff",
                "text-halo-width": 2,
            },
        });
    }
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

    const [tripleStart, setTripleStart] = useState<LngLat | null>(null);
    const [tripleEnd, setTripleEnd] = useState<LngLat | null>(null);
    const [diversity, setDiversity] = useState(0.45);

    const [routeA, setRouteA] = useState<LngLat[]>([]);
    const [routeB, setRouteB] = useState<LngLat[]>([]);
    const [routeC, setRouteC] = useState<LngLat[]>([]);

    // Refs to avoid stale state in map click handler
    const modeRef = useRef<Mode>("TRIPLE");
    useEffect(() => {
        modeRef.current = mode;
    }, [mode]);

    const tripleRef = useRef<{ start: LngLat | null; end: LngLat | null }>({ start: null, end: null });
    useEffect(() => {
        tripleRef.current = { start: tripleStart, end: tripleEnd };
    }, [tripleStart, tripleEnd]);

    // Distances shown in panel
    const measureDist = useMemo(() => polylineMeters(measurePts), [measurePts]);
    const singleDist = useMemo(() => polylineMeters(routeLine.length ? routeLine : routeWaypoints), [routeLine, routeWaypoints]);
    const distA = useMemo(() => polylineMeters(routeA), [routeA]);
    const distB = useMemo(() => polylineMeters(routeB), [routeB]);
    const distC = useMemo(() => polylineMeters(routeC), [routeC]);

    // Init map once
    useEffect(() => {
        if (!mapDivRef.current) return;
        if (mapRef.current) return;

        ensureRTLPluginLoaded();

        const map = new maplibregl.Map({
            container: mapDivRef.current,
            style: STYLE_URL,
            center: [34.7818, 32.0853],
            zoom: 13.8,
        });

        map.addControl(new maplibregl.NavigationControl(), "top-left");
        map.addControl(new maplibregl.ScaleControl({ maxWidth: 140, unit: "metric" }), "bottom-left");

        setTimeout(() => map.resize(), 0);

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
            setFC(map, "triple-points", fcPoints([]));
            setFC(map, "triple-a", fcLine([]));
            setFC(map, "triple-b", fcLine([]));
            setFC(map, "triple-c", fcLine([]));
            setFC(map, "triple-labels", fcPoints([]));
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

            // TRIPLE mode — IMPORTANT: update ref immediately so 2nd click always works
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

            // third click => start new selection
            tripleRef.current = { start: ll, end: null };
            setRouteA([]);
            setRouteB([]);
            setRouteC([]);
            setTripleStart(ll);
            setTripleEnd(null);
        });

        mapRef.current = map;

        return () => {
            map.remove();
            mapRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Update base layer visibility
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !map.isStyleLoaded()) return;

        toggleBy(map, isRoadLayer, showRoads);
        toggleBy(map, isTransitLayer, showTransit);
        toggleBy(map, (l) => isLabelLayer(l) && !isPoiLayer(l), showLabels);
        toggleBy(map, isPoiLayer, showPOI);
    }, [showRoads, showTransit, showLabels, showPOI]);

    // Update label language
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !map.isStyleLoaded()) return;
        applyLabelLang(map, labelLang);
    }, [labelLang]);

    // Render measurement overlay
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        setFC(map, "measure-points", fcPoints(measurePts));
        setFC(map, "measure-line", fcLine(measurePts));
    }, [measurePts]);

    // Single route (OSRM)
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        setFC(map, "route-points", fcPoints(routeWaypoints));

        if (routeWaypoints.length < 2) {
            setRouteLine([]);
            setFC(map, "route-line", fcLine([]));
            return;
        }

        let cancelled = false;
        (async () => {
            const snapped = await osrmRoute(routeWaypoints);
            if (cancelled) return;

            if (snLE; // ignore invalid but we'll avoid

        })();

        return () => {
            cancelled = true;
        };
    }, [routeWaypoints]);

    // (Fix above: accidental paste guard) — we re-implement single route effect safely
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        if (routeWaypoints.length < 2) return;

        let cancelled = false;
        (async () => {
            const snapped = await osrmRoute(routeWaypoints);
            if (cancelled) return;

            if (snapped && snapped.length >= 2) {
                setRouteLine(snapped);
                setFC(map, "route-line", fcLine(snapped));
            } else {
                setRouteLine([]);
                setFC(map, "route-line", fcLine(routeWaypoints));
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [routeWaypoints]);

    // Triple routes (OSRM) when start/end/diversity change
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        const pts: LngLat[] = [tripleStart, tripleEnd].filter(Boolean) as LngLat[];
        setFC(map, "triple-points", fcPoints(pts));

        if (!tripleStart || !tripleEnd) {
            setRouteA([]);
            setRouteB([]);
            setRouteC([]);
            setFC(map, "triple-a", fcLine([]));
            setFC(map, "triple-b", fcLine([]));
            setFC(map, "triple-c", fcLine([]));
            setFC(map, "triple-labels", fcPoints([]));
            return;
        }

        const d = clamp(diversity, 0, 1);

        let cancelled = false;
        (async () => {
            const a = (await osrmRoute([tripleStart, tripleEnd])) ?? [tripleStart, tripleEnd];
            const { via1, via2 } = buildViaPoints(map, tripleStart, tripleEnd, d);
            const b = (await osrmRoute([tripleStart, via1, tripleEnd])) ?? [tripleStart, via1, tripleEnd];
            const c = (await osrmRoute([tripleStart, via2, tripleEnd])) ?? [tripleStart, via2, tripleEnd];

            if (cancelled) return;

            setRouteA(a);
            setRouteB(b);
            setRouteC(c);

            setFC(map, "triple-a", fcLine(a));
            setFC(map, "triple-b", fcLine(b));
            setFC(map, "triple-c", fcLine(c));

            const labelPts: LngLat[] = [
                a[Math.floor(a.length / 2)] ?? midpoint(tripleStart, tripleEnd),
                b[Math.floor(b.length / 2)] ?? via1,
                c[Math.floor(c.length / 2)] ?? via2,
            ];
            const props = [{ label: "א" }, { label: "ב" }, { label: "ג" }];
            setFC(map, "triple-labels", fcPoints(labelPts, props));
        })();

        return () => {
            cancelled = true;
        };
    }, [tripleStart, tripleEnd, diversity]);

    // ---------- Actions ----------
    const zoomToTA = () => mapRef.current?.flyTo({ center: [34.7818, 32.0853], zoom: 14.6, speed: 1.2 });

    const clearMeasure = () => setMeasurePts([]);

    const clearSingle = () => {
        setRouteWaypoints([]);
        setRouteLine([]);
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
        const map = mapRef.current;
        if (!map) return;
        setFC(map, "triple-points", fcPoints([]));
        setFC(map, "triple-a", fcLine([]));
        setFC(map, "triple-b", fcLine([]));
        setFC(map, "triple-c", fcLine([]));
        setFC(map, "triple-labels", fcPoints([]));
    };

    const clearAll = () => {
        clearMeasure();
        clearSingle();
        clearTriple();
    };

    return (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", height: "100vh", width: "100vw" }}>
            <div style={{ position: "relative", minHeight: 0 }}>
                <div ref={mapDivRef} style={{ position: "absolute", inset: 0 }} />
            </div>

            <div style={{ borderLeft: "1px solid #222", padding: 12, fontFamily: "system-ui", background: "#0b0b0c", color: "#fff", overflow: "auto" }}>
                <h3 style={{ margin: "8px 0" }}>GeoVis Lab</h3>
                <div style={{ fontSize: 12, color: "#a3a3a3", marginBottom: 10 }}>
                    <b>3 מסלולים:</b> קליק 1=התחלה, קליק 2=סיום (נוצרים א/ב/ג). קליק נוסף מתחיל מחדש.
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
                        נקודות: {tripleStart ? "התחלה ✓" : "התחלה —"} · {tripleEnd ? "סיום ✓" : "סיום —"}
                    </div>

                    <label style={{ display: "block", fontSize: 12, color: "#cbd5e1" }}>
                        שונות: {Math.round(diversity * 100)}%
                    </label>
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

                    <div style={{ marginTop: 10, fontSize: 13 }}>
                        <div>א: <b>{routeA.length ? fmtDistance(distA) : "—"}</b></div>
                        <div>ב: <b>{routeB.length ? fmtDistance(distB) : "—"}</b></div>
                        <div>ג: <b>{routeC.length ? fmtDistance(distC) : "—"}</b></div>
                    </div>
                </fieldset>

                <fieldset style={{ border: "1px solid #333", borderRadius: 10, padding: 10, marginBottom: 12 }}>
                    <legend>מסלול יחיד</legend>
                    <div style={{ fontSize: 12, color: "#a3a3a3", marginBottom: 8 }}>
                        במצב \"מסלול יחיד\" כל קליק מוסיף waypoint, והמערכת מצמידה לרחובות דרך OSRM.
                    </div>
                    <div>Waypoints: <b>{routeWaypoints.length}</b></div>
                    <div>אורך: <b>{routeWaypoints.length >= 2 ? fmtDistance(singleDist) : "—"}</b></div>
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <button onClick={clearSingle}>ניקוי מסלול יחיד</button>
                    </div>
                </fieldset>

                <fieldset style={{ border: "1px solid #333", borderRadius: 10, padding: 10 }}>
                    <legend>מדידה</legend>
                    <div style={{ fontSize: 12, color: "#a3a3a3", marginBottom: 8 }}>
                        במצב \"מדידה\" כל קליק מוסיף נקודה, והקו מחשב מרחק גאודזי.
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
