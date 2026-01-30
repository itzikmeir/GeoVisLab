import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

type LngLat = [number, number];

const MAPTILER_KEY = "mpLN2pWAtDH8gsonXvRt";
const STYLE_URL = `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`;

// Routes styling
const ROUTE_COLOR = "#4AA3FF";
const ROUTE_OPACITY = 0.6;
const OUTLINE_OPACITY = 0.25;

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
        setPlugin(
            "https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.2.3/mapbox-gl-rtl-text.js",
            () => { },
            true
        );
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
        features: [
            { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } },
        ],
    };
}

function setFC(map: maplibregl.Map, sourceId: string, data: any) {
    const s = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
    if (s) s.setData(data);
}

function pickTextFontFromStyle(map: maplibregl.Map): any {
    const layers = map.getStyle()?.layers ?? [];
    const sample = layers.find((l: any) => l.type === "symbol" && l?.layout?.["text-font"]) as any;
    // אצלך ראינו שזה יוצא: ['Roboto Italic','Noto Sans Italic']
    // אבל בפועל זה עובד טוב יותר כשמשתמשים ב-Regular אם קיים.
    // נשמור את מה שיש בסטייל, ואם זה איטליק ננסה Regular:
    const tf = sample?.layout?.["text-font"] ?? ["Roboto Italic", "Noto Sans Italic"];
    if (Array.isArray(tf) && tf.length) {
        const maybeRegular = tf.map((x: string) =>
            x.includes("Italic") ? x.replace("Italic", "Regular") : x
        );
        return maybeRegular;
    }
    return tf;
}

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

    // Shadow
    ctx.beginPath();
    ctx.ellipse(0, 16, 10, 4, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fill();

    // Pin body
    ctx.beginPath();
    ctx.moveTo(0, 18);
    ctx.bezierCurveTo(10, 10, 14, 3, 14, -4);
    ctx.arc(0, -4, 14, 0, Math.PI, true);
    ctx.bezierCurveTo(-14, 3, -10, 10, 0, 18);
    ctx.closePath();
    ctx.fillStyle = "#e11d48";
    ctx.fill();

    // Inner white circle
    ctx.beginPath();
    ctx.arc(0, -4, 5.2, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    ctx.restore();

    const img = ctx.getImageData(0, 0, size, size);
    map.addImage("end-pin", { width: size, height: size, data: img.data }, { pixelRatio: 2 });
}

function ensureOverlay(map: maplibregl.Map) {
    const addSrc = (id: string) => {
        if (!map.getSource(id)) {
            map.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        }
    };

    addSrc("start-end");
    addSrc("triple-a");
    addSrc("triple-b");
    addSrc("triple-c");
    addSrc("triple-labels");

    const fontStack = pickTextFontFromStyle(map);

    try {
        ensurePinImage(map);
    } catch { }

    const addRouteWithOutline = (id: string, width: number) => {
        const outlineId = `${id}-outline`;

        if (!map.getLayer(outlineId)) {
            map.addLayer({
                id: outlineId,
                type: "line",
                source: id,
                layout: { "line-cap": "round", "line-join": "round" },
                paint: {
                    "line-color": "#0b1220",
                    "line-width": width + 2,
                    "line-opacity": OUTLINE_OPACITY,
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
                    "line-width": width,
                    "line-opacity": ROUTE_OPACITY,
                },
            });
        }
    };

    addRouteWithOutline("triple-a", 7);
    addRouteWithOutline("triple-b", 7);
    addRouteWithOutline("triple-c", 7);

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
                "icon-size": 1.5,
                "icon-anchor": "bottom",
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
            },
        });
    }

    const addTextLayer = (
        id: string,
        source: string,
        filter: any,
        size: number,
        offset: [number, number]
    ) => {
        if (map.getLayer(id)) return;
        map.addLayer({
            id,
            type: "symbol",
            source,
            filter,
            layout: {
                "symbol-placement": "point",
                "text-field": ["to-string", ["get", "label"]],
                "text-font": fontStack,
                "text-size": size,
                "text-anchor": "top",
                "text-offset": offset,
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
    };

    // START/END labels
    addTextLayer("start-label", "start-end", ["==", ["get", "kind"], "start"], 18, [0, 1.0]);
    addTextLayer("end-label", "start-end", ["==", ["get", "kind"], "end"], 18, [0, 1.1]);

    // A/B/C labels
    if (!map.getLayer("triple-labels")) {
        map.addLayer({
            id: "triple-labels",
            type: "symbol",
            source: "triple-labels",
            layout: {
                "symbol-placement": "point",
                "text-field": ["to-string", ["get", "label"]],
                "text-font": fontStack,
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

    // Ensure order: labels above routes
    try { map.moveLayer("triple-labels"); } catch { }
    try { map.moveLayer("start-label"); } catch { }
    try { map.moveLayer("end-label"); } catch { }
    try { map.moveLayer("start-circle"); } catch { }
    try { map.moveLayer("end-pin"); } catch { }
}

function midpoint(a: LngLat, b: LngLat): LngLat {
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}
function rotate90(dx: number, dy: number): [number, number] {
    return [-dy, dx];
}

export default function App() {
    const mapDivRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<maplibregl.Map | null>(null);

    const [start, setStart] = useState<LngLat | null>(null);
    const [end, setEnd] = useState<LngLat | null>(null);
    const [diversity, setDiversity] = useState(0.35);
    const [isRouting, setIsRouting] = useState(false);

    // Refs כדי שהקליק לא “יתקע” על ערכים ישנים
    const startRef = useRef<LngLat | null>(null);
    const endRef = useRef<LngLat | null>(null);
    useEffect(() => {
        startRef.current = start;
        endRef.current = end;
    }, [start, end]);

    const canRoute = useMemo(() => !!start && !!end, [start, end]);

    // ✅ INIT MAP — חשוב: [] בלבד, כדי שלא יהבהב בכל קליק
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

        // Silent missing images (כולל " " + exit_2 וכו')
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
            // init empty
            setFC(map, "start-end", fcPoints([]));
            setFC(map, "triple-a", fcLine([]));
            setFC(map, "triple-b", fcLine([]));
            setFC(map, "triple-c", fcLine([]));
            setFC(map, "triple-labels", fcPoints([]));
        });

        map.on("click", (ev) => {
            const ll: LngLat = [ev.lngLat.lng, ev.lngLat.lat];
            const s = startRef.current;
            const t = endRef.current;

            // 1) set start
            if (!s) {
                setStart(ll);
                setEnd(null);
                return;
            }
            // 2) set end
            if (!t) {
                setEnd(ll);
                return;
            }
            // 3) reset with new start
            setStart(ll);
            setEnd(null);
        });

        mapRef.current = map;
        return () => {
            map.remove();
            mapRef.current = null;
        };
    }, []);

    // Update start/end source
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

    // Compute 3 routes + labels א/ב/ג
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        if (!canRoute || !start || !end) return;

        let cancelled = false;

        (async () => {
            setIsRouting(true);

            const b = map.getBounds();
            const widthLng = Math.abs(b.getEast() - b.getWest());
            const heightLat = Math.abs(b.getNorth() - b.getSouth());
            const offset = diversity * 0.20 * Math.min(widthLng, heightLat);

            const mid = midpoint(start, end);
            const dx = end[0] - start[0];
            const dy = end[1] - start[1];
            const [px, py] = rotate90(dx, dy);
            const len = Math.sqrt(px * px + py * py) || 1;
            const ux = px / len;
            const uy = py / len;

            const via1: LngLat = [mid[0] + ux * offset, mid[1] + uy * offset];
            const via2: LngLat = [mid[0] - ux * offset, mid[1] - uy * offset];

            const rA = await osrmRoute([start, end]); // א
            const rB = await osrmRoute([start, via1, end]); // ב
            const rC = await osrmRoute([start, via2, end]); // ג

            if (cancelled) return;

            const a = rA ?? [start, end];
            const bLine = rB ?? [start, via1, end];
            const cLine = rC ?? [start, via2, end];

            setFC(map, "triple-a", fcLine(a));
            setFC(map, "triple-b", fcLine(bLine));
            setFC(map, "triple-c", fcLine(cLine));

            const labelPts: LngLat[] = [
                a[Math.floor(a.length / 2)] ?? mid,
                bLine[Math.floor(bLine.length / 2)] ?? via1,
                cLine[Math.floor(cLine.length / 2)] ?? via2,
            ];
            const labelProps = [{ label: "א" }, { label: "ב" }, { label: "ג" }];
            setFC(map, "triple-labels", fcPoints(labelPts, labelProps));

            setIsRouting(false);
        })();

        return () => {
            cancelled = true;
            setIsRouting(false);
        };
    }, [canRoute, start, end, diversity]);

    const reset = () => {
        setStart(null);
        setEnd(null);
        const map = mapRef.current;
        if (!map) return;
        setFC(map, "start-end", fcPoints([]));
        setFC(map, "triple-a", fcLine([]));
        setFC(map, "triple-b", fcLine([]));
        setFC(map, "triple-c", fcLine([]));
        setFC(map, "triple-labels", fcPoints([]));
    };

    return (
        <div style={{ display: "flex", width: "100vw", height: "100vh", overflow: "hidden" }}>
            {/* MAP */}
            <div style={{ flex: 1, position: "relative" }}>
                <div ref={mapDivRef} style={{ width: "100%", height: "100%" }} />
            </div>

            {/* RIGHT PANEL (כמו קודם) */}
            <div
                style={{
                    width: 380,
                    background: "#0b0f17",
                    color: "#e8eefc",
                    padding: 16,
                    borderLeft: "1px solid rgba(255,255,255,0.08)",
                    fontFamily: "system-ui, Arial",
                    direction: "rtl",
                }}
            >
                <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 6 }}>GeoVis Lab</div>
                <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 14 }}>
                    קליק 1 = <b>מוצא</b> · קליק 2 = <b>יעד</b> · קליק נוסף מתחיל מחדש
                </div>

                <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12 }}>
                    <div style={{ fontWeight: 700, marginBottom: 10 }}>שונות (diversity)</div>
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={diversity}
                        onChange={(e) => setDiversity(parseFloat(e.target.value))}
                        style={{ width: "100%" }}
                    />
                    <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
                        {Math.round(diversity * 100)}%
                    </div>

                    {isRouting && (
                        <div style={{ marginTop: 12, fontSize: 13, fontWeight: 700 }}>
                            מחשב מסלולים…
                        </div>
                    )}
                </div>

                <button
                    onClick={reset}
                    style={{
                        marginTop: 14,
                        width: "100%",
                        padding: "10px 12px",
                        borderRadius: 12,
                        border: "1px solid rgba(255,255,255,0.15)",
                        background: "transparent",
                        color: "#e8eefc",
                        cursor: "pointer",
                        fontWeight: 800,
                    }}
                >
                    איפוס
                </button>
            </div>
        </div>
    );
}
