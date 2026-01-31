import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// ---- Export screen (participant) helpers ----
// File System Access API is ! available in all browsers; we type it loosely to avoid TS build errors.
declare global {
    interface Window {
        showDirectoryPicker?: (options?: any) => Promise<any>;
    }
}
type ExportVizType = "STACKED" | "RADAR" | "HEATMAP";
type ExportSaveMode = "downloads" | "directory";

function safeFileName(input: string) {
    const base = (input || "scenario").trim();
    const cleaned = base
        .replace(/[\\/:*?"<>|]+/g, "-")
        .replace(/\s+/g, "_")
        .slice(0, 80);
    return cleaned || "scenario";
}

function buildParticipantHtml(args: {
    scenarioName: string;
    taskText: string;
    recommendedRoute: "A" | "B" | "C";
    vizType: ExportVizType;
    baseMapDataUrl: string;
    mapView: { center: LngLat; zoom: number; bearing: number; pitch: number; width: number; height: number };
    start: LngLat | null;
    end: LngLat | null;
    routes: Record<"A" | "B" | "C", LngLat[]>;
    manualParks: { id: string; ring: LngLat[] }[];
    catTrafficSegs: { id: string; coords: LngLat[] }[];
    catTollSegs: { id: string; coords: LngLat[] }[];
    catTollLabels: { coord: LngLat; side: "left" | "right" }[];
    catCommZones: { id: string; ring: LngLat[]; radiusM: number }[];
    routeScores: any[];
}) {
    const payload = {
        scenarioName: args.scenarioName,
        recommendedRoute: args.recommendedRoute,
        vizType: args.vizType,
        taskText: args.taskText,
        baseMapDataUrl: args.baseMapDataUrl,
        mapView: args.mapView,
        start: args.start,
        end: args.end,
        routes: args.routes,
        manualParks: args.manualParks,
        catTrafficSegs: args.catTrafficSegs,
        catTollSegs: args.catTollSegs,
        catTollLabels: args.catTollLabels,
        catCommZones: args.catCommZones,
        routeScores: args.routeScores,
        colors: {
            routePalette: { A: "#3B82F6", B: "#F59E0B", C: "#A855F7" },
            traffic: { color: "#FF0022" },
            toll: { color: "#FFE100" },
            comm: { fill: "rgba(170,60,255,0.28)", outline: "rgba(170,60,255,0.65)" },
            parks: { fill: "#00FF66", outline: "rgba(0,90,50,0.9)", opacity: 0.95 },
        },
    };
    const payloadJson = JSON.stringify(payload);

    // Important: keep a fully-standalone HTML without external dependencies.
    return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${String(args.scenarioName).replace(/</g, "&lt;")}</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; font-family: Arial, sans-serif; background: #0b0f17; color: #e8eefc; overflow: hidden; font-size: 16px; }

  .root { height: 100%; display: flex; flex-direction: column; gap: 10px; padding: 10px; }
  .panel { border: 2px solid rgba(255,255,255,0.16); background: rgba(11,15,23,0.96); box-shadow: 0 10px 24px rgba(0,0,0,0.35); border-radius: 12px; }

  .top { flex: 1; min-height: 0; display: flex; gap: 10px; direction: ltr; }

  .mapPanel { flex: 1; min-width: 0; position: relative; overflow: hidden; }
  #mapViewport { position: absolute; inset: 0; overflow: hidden; background: #0b0f17; }
  #mapStage { position: absolute; left: 0; top: 0; transform-origin: 0 0; user-select: none; touch-action: none; }
  #baseImg, #overlaySvg { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
  #baseImg { object-fit: contain; image-rendering: auto; }
  #overlaySvg { pointer-events: auto; }

  .ctrlCol { position: absolute; left: 10px; top: 10px; display: flex; flex-direction: column; gap: 8px; z-index: 80; }
  .ctrlBtn { width: 46px; height: 46px; border-radius: 12px; border: 2px solid rgba(255,255,255,0.16); background: rgba(11,15,23,0.92); cursor: pointer; display: flex; align-items: center; justify-content: center; color: #e8eefc; }
  .ctrlBtn svg { width: 22px; height: 22px; }
  .ctrlBtn:active { transform: translateY(1px); }

  .filterBtn { position: absolute; left: 10px; bottom: 10px; width: 56px; height: 56px; border-radius: 12px; border: 2px solid rgba(255,255,255,0.16); background: rgba(11,15,23,0.92); cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 90; color: #e8eefc; }
  .filterBtn svg { width: 26px; height: 26px; }
  .filterBtn.active::after { content: ""; position: absolute; right: 9px; top: 9px; width: 10px; height: 10px; border-radius: 999px; background: #F59E0B; border: 2px solid rgba(232,238,252,0.95); }

  .mapLegend { position: absolute; right: 10px; bottom: 10px; width: 172px; padding: 10px 10px; border-radius: 12px; direction: rtl; text-align: right; pointer-events: none; z-index: 85; }
  .mapLegend .row { display: flex; align-items: center; gap: 10px; margin-bottom: 7px; font-size: 12px; }
  .mapLegend .miniLine { width: 34px; height: 0; border-top: 4px solid rgba(255,255,255,0.25); }

  .taskPanel { width: 390px; max-width: 42vw; padding: 14px; overflow: auto; direction: rtl; text-align: right; }
  .h { font-weight: 900; font-size: 19px; margin: 0 0 10px; }
  .muted { opacity: 0.9; font-size: 14px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
  .sep { height: 1px; background: rgba(255,255,255,0.12); margin: 12px 0; }

  .recommendBox { padding: 10px 12px; border: 1px solid rgba(255,255,255,0.16); border-radius: 12px; background: rgba(255,255,255,0.06); }
  .recommendValue { font-weight: 900; font-size: 20px; }

  .pickedBox { padding: 10px 12px; border: 2px solid rgba(255,255,255,0.12); border-radius: 0; background: transparent; font-weight: 900; display: flex; justify-content: space-between; align-items: center; }

  .btnPrimary { width: 100%; padding: 13px 12px; border-radius: 12px; border: 2px solid rgba(255,255,255,0.18); background: rgba(59,130,246,0.45); color: #e8eefc; cursor: pointer; font-weight: 900; font-family: Arial, sans-serif; font-size: 16px; }
  .btnPrimary:active { transform: translateY(1px); }

  .btnGhost { padding: 10px 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.06); color: #e8eefc; cursor: pointer; font-weight: 900; font-family: Arial, sans-serif; }

  .bottom { height: 260px; min-height: 210px; display: flex; gap: 10px; direction: ltr; }

  .legendPanel { width: 250px; padding: 12px; overflow: auto; direction: rtl; text-align: right; }

  .bottomRight { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }

  .routeTabs { padding: 10px; direction: rtl; text-align: right; display: flex; gap: 10px; align-items: center; }
  .tabBtn { flex: 1; padding: 10px 0; border-radius: 12px; border: 2px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.04); color: #e8eefc; cursor: pointer; font-weight: 900; font-family: Arial, sans-serif; }
  .tabBtn.active { background: rgba(140,203,255,0.22); border-color: rgba(140,203,255,0.55); }

  .split { flex: 1; min-height: 0; display: flex; gap: 10px; }
  .vizPanel { flex: 1; min-width: 0; padding: 12px; overflow: auto; direction: rtl; text-align: right; }
  .ganttPanel { flex: 0 0 33%; min-width: 320px; max-width: 520px; padding: 12px; overflow: auto; direction: rtl; text-align: right; }

  .legendItem { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; font-size: 13px; }
  .swatch { width: 14px; height: 14px; border-radius: 2px; border: 2px solid rgba(255,255,255,0.28); }

  /* Viz */
  .vizRow { display: flex; gap: 10px; flex-wrap: wrap; }
  .vizCard { width: 240px; min-width: 220px; border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 10px 12px; background: rgba(255,255,255,0.06); }
  .vizCardTitle { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .segBadge { width: 26px; height: 26px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; background: rgba(140,203,255,0.18); border: 1px solid rgba(140,203,255,0.5); font-weight: 900; }

  .heatTable { border-collapse: collapse; width: 100%; font-size: 12px; table-layout: fixed; }
  .heatTable th, .heatTable td { border: 1px solid rgba(255,255,255,0.12); padding: 6px; text-align: center; }
  .heatTable th { font-weight: 900; background: rgba(255,255,255,0.06); }

  .ganttRow { display: grid; grid-template-columns: 44px 1fr; gap: 10px; align-items: center; margin-bottom: 10px; cursor: pointer; }
  .ganttRow:hover .ganttBars { border-color: rgba(140,203,255,0.55); }
  .ganttLabel { font-weight: 900; font-size: 16px; text-align: center; }
  .ganttBars { display: flex; flex-direction: row-reverse; width: 100%; height: 28px; border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.04); overflow: hidden; }
  .ganttSeg { height: 100%; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 12px; color: #0b1220; border-left: 1px solid rgba(0,0,0,0.15); user-select: none; }
  .ganttHint { font-size: 12px; opacity: 0.75; margin-top: 10px; }

  /* Modals */
  .modalBackdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: none; align-items: center; justify-content: center; z-index: 9999; }
  .modalBackdrop.show { display: flex; }
  .modal { width: 560px; max-width: 94vw; background: #0b0f17; border: 2px solid rgba(255,255,255,0.16); border-radius: 16px; padding: 14px; direction: rtl; text-align: right; font-family: Arial, sans-serif; }
  .modalTitle { font-weight: 900; margin-bottom: 10px; font-size: 16px; }
  .modalGrid { display: grid; gap: 10px; }
  .layerRow { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border: 1px solid rgba(255,255,255,0.12); border-radius: 14px; background: rgba(255,255,255,0.06); }
  .layerLeft { display: flex; gap: 10px; align-items: center; }
  .eyeBtn { width: 42px; height: 34px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.06); color: #e8eefc; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .eyeBtn svg { width: 22px; height: 22px; }
  .layerState { font-size: 12px; opacity: 0.85; }
  .actionsRow { display: flex; gap: 10px; flex-wrap: wrap; justify-content: space-between; }

  /* Toast */
  .toast { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); background: rgba(11,15,23,0.96); border: 2px solid rgba(255,255,255,0.14); border-radius: 14px; padding: 10px 12px; min-width: 260px; max-width: 92vw; text-align: center; opacity: 0; pointer-events: none; transition: opacity 180ms ease; z-index: 99999; }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
<div class="root">

  <div class="top">
    <div class="mapPanel panel">
      <div id="mapViewport">
        <div id="mapStage">
          <img id="baseImg" alt="מפה" />
          <svg id="overlaySvg" xmlns="http://www.w3.org/2000/svg"></svg>
        </div>
      </div>

      <div class="ctrlCol">
        <button class="ctrlBtn" id="zoomIn" title="התקרב" aria-label="התקרב">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
        </button>
        <button class="ctrlBtn" id="zoomOut" title="התרחק" aria-label="התרחק">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>
        </button>
        <button class="ctrlBtn" id="fitView" title="FIT TO SCREEN" aria-label="FIT TO SCREEN">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 7V4h3"/><path d="M20 7V4h-3"/><path d="M4 17v3h3"/><path d="M20 17v3h-3"/>
            <rect x="7" y="7" width="10" height="10" rx="2"/>
          </svg>
        </button>
      </div>

      <button class="filterBtn" id="filterBtn" title="סינון" aria-label="סינון">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 4h18l-7 8v6l-4 2v-8L3 4z" />
        </svg>
      </button>

      <div class="mapLegend panel" id="mapLegend">
        <div style="font-weight:900;margin-bottom:8px;opacity:0.95">מקרא מפה</div>

        <div class="row">
          <div style="display:flex;gap:6px;align-items:center">
            <div style="width:16px;height:0;border-top:4px solid #3B82F6"></div><div style="font-weight:900;font-size:12px">א</div>
            <div style="width:16px;height:0;border-top:4px solid #F59E0B"></div><div style="font-weight:900;font-size:12px">ב</div>
            <div style="width:16px;height:0;border-top:4px solid #A855F7"></div><div style="font-weight:900;font-size:12px">ג</div>
          </div>
          <div style="font-weight:700">מסלולים</div>
        </div>

        <div class="row"><div style="width:34px;height:0;border-top:4px dashed #FF0022"></div><div style="font-weight:700">עומס</div></div>

        <div class="row">
          <div style="display:flex;gap:6px;align-items:center">
            <div style="width:34px;height:0;border-top:4px solid #FFE100"></div>
            <div style="width:18px;height:18px;border-radius:999px;background:#FFE100;border:1px solid rgba(11,18,32,0.9);display:flex;align-items:center;justify-content:center;font-weight:900;color:#0b1220">₪</div>
          </div>
          <div style="font-weight:700">כביש אגרה</div>
        </div>

        <div class="row"><div style="width:18px;height:12px;border-radius:2px;background:#00FF66;border:2px solid rgba(0,90,50,0.9)"></div><div style="font-weight:700">נוף/פארק</div></div>
        <div class="row" style="margin-bottom:0"><div style="width:18px;height:18px;border-radius:999px;background:rgba(170,60,255,0.28);border:2px solid rgba(170,60,255,0.65)"></div><div style="font-weight:700">אזור תקשורת</div></div>
      </div>
    </div>

    <div class="taskPanel panel">
      <div class="h">מטלה</div>
      <div class="muted" id="taskText"></div>

      <div class="sep"></div>

      <div class="h">דרישות</div>
      <div class="muted">טקסט ממלא מקום – הדרישות יוגדרו בהמשך.</div>

      <div class="sep"></div>

      <div class="recommendBox">
        <div style="font-weight:900;margin-bottom:6px">המלצת מערכת</div>
        <div class="recommendValue" id="recommendedRoute">—</div>
      </div>

      <div class="sep"></div>

      <div class="muted" style="margin-bottom:10px">ניתן לבחור מסלול בלחיצה על הקו במפה (או על תגית א/ב/ג).</div>

      <div class="pickedBox">
        <div>מסלול נבחר</div>
        <div style="font-size:20px" id="pickedRoute">—</div>
      </div>

      <div style="height:12px"></div>
      <button class="btnPrimary" id="confirmBtn">אישור בחירה</button>

      <div class="sep"></div>
      <div class="muted" id="choiceHint">&nbsp;</div>
    </div>
  </div>

  <div class="bottom">
    <div class="legendPanel panel">
      <div class="h" style="margin-bottom:8px">מקרא ויזואליזציה</div>
      <div class="legendItem"><div class="swatch" style="background:#FF0022"></div><div>מהירות (עומסים)</div></div>
      <div class="legendItem"><div class="swatch" style="background:#FFE100"></div><div>חסכון (אגרה)</div></div>
      <div class="legendItem"><div class="swatch" style="background:#00FF66"></div><div>נוף (פארקים)</div></div>
      <div class="legendItem"><div class="swatch" style="background:rgba(170,60,255,0.75)"></div><div>קליטה (תקשורת)</div></div>
    </div>

    <div class="bottomRight">
      <div class="routeTabs panel" id="routeTabs">
        <button class="tabBtn" data-id="A">מסלול א</button>
        <button class="tabBtn" data-id="B">מסלול ב</button>
        <button class="tabBtn" data-id="C">מסלול ג</button>
      </div>

      <div class="split">
        <div class="vizPanel panel">
          <div class="h" style="margin-bottom:8px">ויזואליזציות</div>
          <div id="viz"></div>
        </div>

        <div class="ganttPanel panel">
          <div class="h" style="margin-bottom:8px">זמני מקטעים (בשניות) בחלוקה למסלולים</div>
          <div id="gantt"></div>
          <div class="ganttHint">בחר מסלול כדי להדגיש אותו.</div>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="modalBackdrop" id="filterBackdrop">
  <div class="modal" role="dialog" aria-modal="true" aria-label="סינון">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px">
      <div class="modalTitle">סינון שכבות</div>
      <button class="btnGhost" id="closeFilter">סגור</button>
    </div>

    <div class="actionsRow" style="margin-bottom:10px">
      <button class="btnGhost" id="showAll">הצג הכל</button>
      <button class="btnGhost" id="hideAll">הסתר הכל</button>
    </div>

    <div class="modalGrid" id="layerRows"></div>

    <div style="margin-top:10px" class="muted">טיפ: ניתן להסתיר שכבות כדי להתמקד בקריטריונים במטלה.</div>
  </div>
</div>

<div class="modalBackdrop" id="confirmBackdrop">
  <div class="modal" role="dialog" aria-modal="true" aria-label="אישור בחירה">
    <div class="modalTitle">אישור בחירה</div>
    <div class="muted" id="confirmText"></div>
    <div id="confirmWarn" class="muted" style="margin-top:10px; padding: 10px 12px; border-radius: 12px; border: 1px solid rgba(245,158,11,0.55); background: rgba(245,158,11,0.10); display:none"></div>

    <div class="actionsRow" style="margin-top:12px">
      <button class="btnPrimary" id="confirmYes" style="width:auto;flex:1">אישור</button>
      <button class="btnGhost" id="confirmNo" style="width:auto;flex:1">ביטול</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const DATA = ${payloadJson};

const taskTextEl = document.getElementById('taskText');
const pickedEl = document.getElementById('pickedRoute');
const confirmBtn = document.getElementById('confirmBtn');
const recommendedEl = document.getElementById('recommendedRoute');
const vizEl = document.getElementById('viz');
const ganttEl = document.getElementById('gantt');
const choiceHint = document.getElementById('choiceHint');

const baseImg = document.getElementById('baseImg');
const overlaySvg = document.getElementById('overlaySvg');
const mapViewport = document.getElementById('mapViewport');
const mapStage = document.getElementById('mapStage');

const zoomInBtn = document.getElementById('zoomIn');
const zoomOutBtn = document.getElementById('zoomOut');
const fitViewBtn = document.getElementById('fitView');

const filterBtn = document.getElementById('filterBtn');
const filterBackdrop = document.getElementById('filterBackdrop');
const closeFilter = document.getElementById('closeFilter');
const layerRows = document.getElementById('layerRows');
const showAllBtn = document.getElementById('showAll');
const hideAllBtn = document.getElementById('hideAll');

const confirmBackdrop = document.getElementById('confirmBackdrop');
const confirmText = document.getElementById('confirmText');
const confirmWarn = document.getElementById('confirmWarn');
const confirmYes = document.getElementById('confirmYes');
const confirmNo = document.getElementById('confirmNo');

const toast = document.getElementById('toast');

const tabsWrap = document.getElementById('routeTabs');

function hebRoute(r){ return r === 'A' ? 'א' : r === 'B' ? 'ב' : 'ג'; }

taskTextEl.textContent = DATA.taskText || '';
recommendedEl.textContent = 'מסלול ' + hebRoute(DATA.recommendedRoute);
choiceHint.textContent = '';

let picked = null;

// -----------------------------
// Offline map viewer (image + SVG overlays)
// -----------------------------

baseImg.src = DATA.baseMapDataUrl || '';

const VIEW = DATA.mapView || { center: [34.7818, 32.0853], zoom: 13.8, bearing: 0, pitch: 0, width: 800, height: 600 };

// Stage is pixel-accurate (prevents distortion). Viewport scales it while keeping aspect ratio.
mapStage.style.width = VIEW.width + 'px';
mapStage.style.height = VIEW.height + 'px';
baseImg.style.width = '100%';
baseImg.style.height = '100%';
overlaySvg.setAttribute('viewBox', '0 0 ' + VIEW.width + ' ' + VIEW.height);
overlaySvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

function lngLatToWorld(lng, lat, zoom){
  const d2r = Math.PI / 180;
  const sin = Math.sin(lat * d2r);
  const worldSize = 512 * Math.pow(2, zoom);
  const x = (lng + 180) / 360 * worldSize;
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldSize;
  return { x, y };
}

const centerWorld = lngLatToWorld(VIEW.center[0], VIEW.center[1], VIEW.zoom);
function project(ll){
  const w = lngLatToWorld(ll[0], ll[1], VIEW.zoom);
  return { x: (w.x - centerWorld.x) + VIEW.width / 2, y: (w.y - centerWorld.y) + VIEW.height / 2 };
}

function el(name, attrs){
  const n = document.createElementNS('http://www.w3.org/2000/svg', name);
  if(attrs){ for(const k in attrs){ n.setAttribute(k, String(attrs[k])); } }
  return n;
}

function ensureClosed(ring){
  if(!ring || ring.length < 3) return ring || [];
  const a = ring[0];
  const b = ring[ring.length-1];
  if(a[0] === b[0] && a[1] === b[1]) return ring;
  return ring.concat([a]);
}

// Route offsets reduce overlap artifacts (keeps route color uniform on the screen)
const routeOffsetX = { A: -6, B: 0, C: 6 };
const routeOffsetY = { A: 0, B: 0, C: 0 };

function pathFromLine(coords, rid){
  if(!coords || coords.length < 2) return '';
  let d = '';
  for(let i=0;i<coords.length;i++){
    const p0 = project(coords[i]);
    const p = { x: p0.x + (rid ? routeOffsetX[rid] : 0), y: p0.y + (rid ? routeOffsetY[rid] : 0) };
    d += (i===0 ? 'M' : 'L') + p.x.toFixed(2) + ' ' + p.y.toFixed(2) + ' ';
  }
  return d.trim();
}

function pathFromRing(ring){
  if(!ring || ring.length < 3) return '';
  let d = '';
  for(let i=0;i<ring.length;i++){
    const p = project(ring[i]);
    d += (i===0 ? 'M' : 'L') + p.x.toFixed(2) + ' ' + p.y.toFixed(2) + ' ';
  }
  d += 'Z';
  return d;
}

// SVG groups (order matters)
const gAll = el('g', { id: 'g_all' });
const gComm = el('g', { id: 'g_comm' });
const gParks = el('g', { id: 'g_parks' });
const gToll = el('g', { id: 'g_toll' });
const gRoutes = el('g', { id: 'g_routes' });
const gTraffic = el('g', { id: 'g_traffic' });
const gStartEnd = el('g', { id: 'g_startend' });
const gSeg = el('g', { id: 'g_seg' });

overlaySvg.appendChild(gAll);
gAll.appendChild(gComm);
gAll.appendChild(gParks);
gAll.appendChild(gToll);
gAll.appendChild(gRoutes);
gAll.appendChild(gTraffic); // always on top of routes so it isn't hidden

// start/end + segments on top
gAll.appendChild(gStartEnd);
gAll.appendChild(gSeg);

// Pointer-events: allow route selection, prevent other overlays from blocking
[gComm,gParks,gToll,gTraffic,gStartEnd,gSeg].forEach(g=>{ g.style.pointerEvents = 'none'; });
gRoutes.style.pointerEvents = 'auto';

// Filters (parks removed by request)
const filters = { routes: true, traffic: true, toll: true, comm: true };

function applyFilters(){
  gRoutes.style.display = filters.routes ? '' : 'none';
  gTraffic.style.display = filters.traffic ? '' : 'none';
  gToll.style.display = filters.toll ? '' : 'none';
  gComm.style.display = filters.comm ? '' : 'none';

  const anyOff = !filters.routes || !filters.traffic || !filters.toll || !filters.comm;
  if(anyOff) filterBtn.classList.add('active'); else filterBtn.classList.remove('active');
}

function renderFilterRows(){
  layerRows.innerHTML = '';
  const rows = [
    { key: 'routes', label: 'מסלולים' },
    { key: 'traffic', label: 'עומסי תנועה' },
    { key: 'toll', label: 'כבישי אגרה' },
    { key: 'comm', label: 'אזורי תקשורת' },
  ];

  rows.forEach((r)=>{
    const row = document.createElement('div');
    row.className = 'layerRow';

    const left = document.createElement('div');
    left.className = 'layerLeft';

    const btn = document.createElement('button');
    btn.className = 'eyeBtn';
    btn.setAttribute('data-key', r.key);
    btn.setAttribute('aria-label', 'toggle ' + r.key);

    const on = filters[r.key];
    btn.innerHTML = on ? eyeOpenSvg() : eyeClosedSvg();

    btn.addEventListener('click', (e)=>{
      e.preventDefault();
      filters[r.key] = !filters[r.key];
      renderFilterRows();
      applyFilters();
    });

    const name = document.createElement('div');
    name.style.fontWeight = '900';
    name.textContent = r.label;

    left.appendChild(btn);
    left.appendChild(name);

    const state = document.createElement('div');
    state.className = 'layerState';
    state.textContent = filters[r.key] ? 'מוצג' : 'מוסתר';

    row.appendChild(left);
    row.appendChild(state);
    layerRows.appendChild(row);
  });
}

function eyeOpenSvg(){
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
}
function eyeClosedSvg(){
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.73 21.73 0 0 1 5.06-5.94"/><path d="M1 1l22 22"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a21.82 21.82 0 0 1-3.17 4.25"/><path d="M14.12 14.12A3 3 0 0 1 9.88 9.88"/></svg>';
}

// Categories drawing
function drawCategories(){
  (DATA.catCommZones || []).forEach((z)=>{
    const ring = ensureClosed(z.ring);
    const p = el('path', { d: pathFromRing(ring), fill: DATA.colors.comm.fill, stroke: DATA.colors.comm.outline, 'stroke-width': 2, 'fill-opacity': 0.7 });
    gComm.appendChild(p);
  });

  (DATA.manualParks || []).forEach((p0)=>{
    const ring = ensureClosed(p0.ring);
    const p = el('path', { d: pathFromRing(ring), fill: DATA.colors.parks.fill, stroke: DATA.colors.parks.outline, 'stroke-width': 2, 'fill-opacity': DATA.colors.parks.opacity });
    gParks.appendChild(p);
  });

  (DATA.catTollSegs || []).forEach((l)=>{
    const d = pathFromLine(l.coords, null);
    if(!d) return;
    const main = el('path', { d, fill: 'none', stroke: DATA.colors.toll.color, 'stroke-width': 5, 'stroke-opacity': 0.95, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    gToll.appendChild(main);
  });

  (DATA.catTollLabels || []).forEach((lab)=>{
    const p = project(lab.coord);
    const g = el('g');
    const c = el('circle', { cx: p.x, cy: p.y, r: 9, fill: DATA.colors.toll.color, stroke: 'rgba(11,18,32,0.9)', 'stroke-width': 1.5 });
    const t = el('text', { x: p.x, y: (p.y + 5), 'text-anchor': 'middle', 'font-size': 14, 'font-weight': 900, 'font-family': 'Arial, sans-serif', fill: '#0b1220' });
    t.textContent = '₪';
    g.appendChild(c);
    g.appendChild(t);
    gToll.appendChild(g);
  });

  // Traffic (always on top of routes)
  (DATA.catTrafficSegs || []).forEach((l)=>{
    const d = pathFromLine(l.coords, null);
    if(!d) return;
    const glow = el('path', { d, fill: 'none', stroke: DATA.colors.traffic.color, 'stroke-width': 8, 'stroke-opacity': 0.32, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    const main = el('path', { d, fill: 'none', stroke: DATA.colors.traffic.color, 'stroke-width': 4, 'stroke-opacity': 0.95, 'stroke-dasharray': '6 6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    gTraffic.appendChild(glow);
    gTraffic.appendChild(main);
  });
}

// Routes
const routeEls = { A: null, B: null, C: null };
const routeBadgeEls = { A: null, B: null, C: null };

function drawRoutes(){
  const palette = (DATA.colors && DATA.colors.routePalette) ? DATA.colors.routePalette : { A:'#3B82F6', B:'#F59E0B', C:'#A855F7' };

  for(const id of ['A','B','C']){
    const coords = (DATA.routes && DATA.routes[id]) ? DATA.routes[id] : [];
    const d = pathFromLine(coords, id);
    if(!d) continue;

    // halo
    const outline = el('path', { d, fill: 'none', stroke: 'rgba(0,0,0,0.35)', 'stroke-width': 12, 'stroke-opacity': 0.25, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    gRoutes.appendChild(outline);

    // main
    const main = el('path', { d, fill: 'none', stroke: palette[id], 'stroke-width': 7, 'stroke-opacity': 0.55, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'data-id': id });
    gRoutes.appendChild(main);

    // hit
    const hit = el('path', { d, fill: 'none', stroke: 'rgba(0,0,0,0)', 'stroke-width': 20, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'data-id': id });
    hit.style.pointerEvents = 'stroke';
    hit.addEventListener('click', (e)=>{ e.stopPropagation(); setPicked(id); });
    hit.addEventListener('mouseenter', ()=>{ mapViewport.style.cursor = 'pointer'; });
    hit.addEventListener('mouseleave', ()=>{ mapViewport.style.cursor = ''; });
    gRoutes.appendChild(hit);

    routeEls[id] = main;

    // badge near midpoint (always visible)
    const mid = pickPointAlongLine(coords, 0.55, id);
    if(mid){
      const g = makeRouteBadge(mid.x, mid.y, id);
      g.addEventListener('click', (e)=>{ e.stopPropagation(); setPicked(id); });
      g.addEventListener('mouseenter', ()=>{ mapViewport.style.cursor = 'pointer'; });
      g.addEventListener('mouseleave', ()=>{ mapViewport.style.cursor = ''; });
      gRoutes.appendChild(g);
      routeBadgeEls[id] = g;
    }
  }
}

function makeRouteBadge(x, y, id){
  const palette = (DATA.colors && DATA.colors.routePalette) ? DATA.colors.routePalette : { A:'#3B82F6', B:'#F59E0B', C:'#A855F7' };
  const g = el('g', { 'data-id': id });
  g.style.pointerEvents = 'all';
  const bg = el('rect', { x: x-15, y: y-15, width: 30, height: 30, rx: 10, ry: 10, fill: palette[id], stroke: 'rgba(0,0,0,0.25)', 'stroke-width': 2 });
  const tx = el('text', { x, y: y+6, 'text-anchor': 'middle', 'font-size': 18, 'font-weight': 900, 'font-family': 'Arial, sans-serif', fill: '#0b1220' });
  tx.textContent = hebRoute(id);
  g.appendChild(bg);
  g.appendChild(tx);
  return g;
}

function pickPointAlongLine(coords, t01, rid){
  if(!coords || coords.length < 2) return null;
  const pts = coords.map((c)=>{
    const p0 = project(c);
    return { x: p0.x + (rid ? routeOffsetX[rid] : 0), y: p0.y + (rid ? routeOffsetY[rid] : 0) };
  });
  const cum = [0];
  for(let i=1;i<pts.length;i++) cum[i] = cum[i-1] + Math.hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
  const total = cum[cum.length-1] || 1;
  const target = total * clamp(t01,0,1);
  let i=1;
  while(i<cum.length && cum[i] < target) i++;
  const i0 = Math.max(0, i-1);
  const i1 = Math.min(pts.length-1, i);
  const segLen = (cum[i1]-cum[i0]) || 1;
  const a = clamp((target - cum[i0]) / segLen, 0, 1);
  return { x: pts[i0].x + (pts[i1].x-pts[i0].x)*a, y: pts[i0].y + (pts[i1].y-pts[i0].y)*a };
}

function drawStartEnd(){
  if(DATA.start){
    const p0 = project(DATA.start);
    const p = { x: p0.x, y: p0.y };
    const c = el('circle', { cx: p.x, cy: p.y, r: 11, fill: '#ffffff', stroke: '#0b1220', 'stroke-width': 4 });
    gStartEnd.appendChild(c);
    drawTag(p.x + 14, p.y - 14, 'מוצא');
  }
  if(DATA.end){
    const p0 = project(DATA.end);
    const p = { x: p0.x, y: p0.y };
    const pin = el('path', {
      d: \`M \${p.x} \${p.y-18} C \${p.x+9} \${p.y-18}, \${p.x+14} \${p.y-11}, \${p.x+14} \${p.y-3} C \${p.x+14} \${p.y+7}, \${p.x+7} \${p.y+14}, \${p.x} \${p.y+22} C \${p.x-7} \${p.y+14}, \${p.x-14} \${p.y+7}, \${p.x-14} \${p.y-3} C \${p.x-14} \${p.y-11}, \${p.x-9} \${p.y-18}, \${p.x} \${p.y-18} Z\`,
      fill: '#d11111',
      stroke: '#0b1220',
      'stroke-width': 2.5,
      'fill-opacity': 0.98,
    });
    const dot = el('circle', { cx: p.x, cy: p.y-4, r: 4.2, fill: '#ffffff', stroke: 'rgba(0,0,0,0.25)', 'stroke-width': 1 });
    gStartEnd.appendChild(pin);
    gStartEnd.appendChild(dot);
    drawTag(p.x + 14, p.y - 18, 'יעד');
  }
}

function drawTag(x, y, txt){
  const padX = 8;
  const padY = 6;
  const w = txt.length * 9 + padX*2;
  const h = 26;
  const r = el('rect', { x: x, y: y, width: w, height: h, rx: 10, ry: 10, fill: 'rgba(11,15,23,0.92)', stroke: 'rgba(255,255,255,0.16)', 'stroke-width': 2 });
  const t = el('text', { x: x + w/2, y: y + 18, 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 900, 'font-family': 'Arial, sans-serif', fill: '#e8eefc' });
  t.textContent = txt;
  gStartEnd.appendChild(r);
  gStartEnd.appendChild(t);
}

function clearSeg(){ while(gSeg.firstChild) gSeg.removeChild(gSeg.firstChild); }

function drawSegmentsFor(routeId){
  clearSeg();
  const coords = (DATA.routes && DATA.routes[routeId]) ? DATA.routes[routeId] : [];
  if(!coords || coords.length < 2) return;

  // segment centers at 1/6, 1/2, 5/6 + boundary ticks at 1/3, 2/3
  const centers = [1/6, 3/6, 5/6];
  const bounds = [2/6, 4/6];

  centers.forEach((t, idx)=>{
    const p = pickPointAlongLine(coords, t, routeId);
    if(!p) return;
    const g = el('g');
    const cc = el('circle', { cx: p.x, cy: p.y, r: 11, fill: 'rgba(255,255,255,0.92)', stroke: '#0b1220', 'stroke-width': 2 });
    const tt = el('text', { x: p.x, y: p.y+5, 'text-anchor':'middle', 'font-size': 12, 'font-weight': 900, 'font-family':'Arial, sans-serif', fill:'#0b1220' });
    tt.textContent = String(idx+1);
    g.appendChild(cc);
    g.appendChild(tt);
    gSeg.appendChild(g);
  });

  bounds.forEach((t)=>{
    const p = pickPointAlongLine(coords, t, routeId);
    if(!p) return;
    // approximate tangent by sampling slightly around t
    const pA = pickPointAlongLine(coords, clamp(t-0.01,0,1), routeId);
    const pB = pickPointAlongLine(coords, clamp(t+0.01,0,1), routeId);
    if(!pA || !pB) return;
    const dx = pB.x - pA.x;
    const dy = pB.y - pA.y;
    const len = Math.hypot(dx,dy) || 1;
    const nx = -dy/len;
    const ny = dx/len;
    const L = 12;
    const x1 = p.x - nx*L;
    const y1 = p.y - ny*L;
    const x2 = p.x + nx*L;
    const y2 = p.y + ny*L;

    const shadow = el('line', { x1, y1, x2, y2, stroke: 'rgba(0,0,0,0.55)', 'stroke-width': 5, 'stroke-linecap': 'round' });
    const line = el('line', { x1, y1, x2, y2, stroke: 'rgba(255,255,255,0.92)', 'stroke-width': 3, 'stroke-linecap': 'round' });
    gSeg.appendChild(shadow);
    gSeg.appendChild(line);
  });
}

function updateRouteStyles(){
  const palette = (DATA.colors && DATA.colors.routePalette) ? DATA.colors.routePalette : { A:'#3B82F6', B:'#F59E0B', C:'#A855F7' };
  for(const id of ['A','B','C']){
    const isSel = picked === id;
    const main = routeEls[id];
    if(main){
      main.setAttribute('stroke', palette[id]);
      main.setAttribute('stroke-opacity', isSel ? '0.95' : '0.55');
      main.setAttribute('stroke-width', isSel ? '10' : '7');
    }

    const tab = tabsWrap.querySelector('[data-id="' + id + '"]');
    if(tab){
      if(isSel) tab.classList.add('active'); else tab.classList.remove('active');
    }
  }
}

function setPicked(id){
  if(!id) return;
  picked = id;
  pickedEl.textContent = 'מסלול ' + hebRoute(id);

  // hint about recommendation mismatch
  if(String(picked) !== String(DATA.recommendedRoute)){
    choiceHint.textContent = 'שים לב: מסלול זה שונה מהמלצת המערכת.';
  } else {
    choiceHint.textContent = '';
  }

  updateRouteStyles();
  renderGantt();
  renderViz();
  drawSegmentsFor(id);
}

// Tabs events
[tabsWrap.querySelector('[data-id="A"]'), tabsWrap.querySelector('[data-id="B"]'), tabsWrap.querySelector('[data-id="C"]')].forEach((b)=>{
  if(!b) return;
  b.addEventListener('click', ()=> setPicked(b.getAttribute('data-id')));
});

// -----------------------------
// Pan/Zoom behavior (no black edges; drag only when zoomed)
// -----------------------------
let fitScale = 1;
let scale = 1; // user scale (>=1)
let panX = 0;
let panY = 0;

function getViewportSize(){
  const r = mapViewport.getBoundingClientRect();
  return { w: r.width, h: r.height, left: r.left, top: r.top };
}

function clampPan(){
  const { w, h } = getViewportSize();
  const contentW = VIEW.width * fitScale * scale;
  const contentH = VIEW.height * fitScale * scale;

  // X
  if(contentW <= w){
    panX = (w - contentW) / 2;
  } else {
    panX = clamp(panX, w - contentW, 0);
  }

  // Y
  if(contentH <= h){
    panY = (h - contentH) / 2;
  } else {
    panY = clamp(panY, h - contentH, 0);
  }
}

function applyTransform(){
  clampPan();
  const actual = fitScale * scale;
  mapStage.style.transform = 'translate(' + panX.toFixed(2) + 'px,' + panY.toFixed(2) + 'px) scale(' + actual.toFixed(6) + ')';
}

function computeFit(){
  const { w, h } = getViewportSize();
  fitScale = Math.min(w / VIEW.width, h / VIEW.height);
  scale = 1;
  applyTransform();
}

function zoomAt(clientX, clientY, factor){
  const { w, h, left, top } = getViewportSize();
  const cx = clientX - left;
  const cy = clientY - top;

  const beforeScale = fitScale * scale;
  const nextUser = clamp(scale * factor, 1, 6);
  const afterScale = fitScale * nextUser;

  // coordinates in stage space
  const sx = (cx - panX) / beforeScale;
  const sy = (cy - panY) / beforeScale;

  // keep the point under cursor
  panX = cx - sx * afterScale;
  panY = cy - sy * afterScale;
  scale = nextUser;

  applyTransform();
}

let isDrag = false;
let lastX = 0;
let lastY = 0;

mapViewport.addEventListener('pointerdown', (e)=>{
  if(scale <= 1.0001) return; // no drag when centered/fit
  isDrag = true;
  lastX = e.clientX;
  lastY = e.clientY;
  mapViewport.setPointerCapture(e.pointerId);
});
mapViewport.addEventListener('pointermove', (e)=>{
  if(!isDrag) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  panX += dx;
  panY += dy;
  applyTransform();
});
mapViewport.addEventListener('pointerup', (e)=>{
  isDrag = false;
  try { mapViewport.releasePointerCapture(e.pointerId); } catch(_e){}
});
mapViewport.addEventListener('wheel', (e)=>{
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 0.89;
  zoomAt(e.clientX, e.clientY, factor);
}, { passive: false });

zoomInBtn.addEventListener('click', ()=>{
  const { left, top, w, h } = getViewportSize();
  zoomAt(left + w/2, top + h/2, 1.12);
});
zoomOutBtn.addEventListener('click', ()=>{
  const { left, top, w, h } = getViewportSize();
  zoomAt(left + w/2, top + h/2, 0.89);
});
fitViewBtn.addEventListener('click', ()=> computeFit());

window.addEventListener('resize', ()=>{
  // keep current scale but recompute fitScale && pan
  const { w, h } = getViewportSize();
  const nextFit = Math.min(w / VIEW.width, h / VIEW.height);
  if(!isFinite(nextFit) || nextFit <= 0) return;
  // adjust pan proportionally to new fit
  const beforeActual = fitScale * scale;
  const afterActual = nextFit * scale;
  if(beforeActual > 0){
    panX = panX * (afterActual / beforeActual);
    panY = panY * (afterActual / beforeActual);
  }
  fitScale = nextFit;
  applyTransform();
});

// -----------------------------
// Confirm (organic modal)
// -----------------------------
function showToast(msg){
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(()=> toast.classList.remove('show'), 2200);
}

function openConfirm(){
  if(!picked){ showToast('נא לבחור מסלול לפני אישור.'); return; }

  confirmText.textContent = 'בחרת את מסלול ' + hebRoute(picked) + '. האם אתה בטוח?';
  if(String(picked) !== String(DATA.recommendedRoute)){
    confirmWarn.style.display = '';
    confirmWarn.textContent = 'שים לב: המלצת המערכת היא מסלול ' + hebRoute(DATA.recommendedRoute) + '.';
  } else {
    confirmWarn.style.display = 'none';
  }

  confirmBackdrop.classList.add('show');
}

function closeConfirm(){ confirmBackdrop.classList.remove('show'); }

confirmBtn.addEventListener('click', openConfirm);
confirmNo.addEventListener('click', closeConfirm);
confirmBackdrop.addEventListener('click', (e)=>{ if(e.target === confirmBackdrop) closeConfirm(); });

confirmYes.addEventListener('click', ()=>{
  const out = { scenarioName: DATA.scenarioName, selectedRoute: picked };
  try { localStorage.setItem('participant_choice', JSON.stringify(out)); } catch(e){}
  console.log('participant_choice', out);
  closeConfirm();
  showToast('הבחירה נשמרה. ניתן לעבור לשאלון.');
});

// -----------------------------
// Filter modal
// -----------------------------
filterBtn.addEventListener('click', ()=>{ renderFilterRows(); filterBackdrop.classList.add('show'); });
closeFilter.addEventListener('click', ()=> filterBackdrop.classList.remove('show'));
filterBackdrop.addEventListener('click', (e)=>{ if(e.target === filterBackdrop) filterBackdrop.classList.remove('show'); });

showAllBtn.addEventListener('click', ()=>{ filters.routes = filters.traffic = filters.toll = filters.comm = true; renderFilterRows(); applyFilters(); });
hideAllBtn.addEventListener('click', ()=>{ filters.routes = filters.traffic = filters.toll = filters.comm = false; renderFilterRows(); applyFilters(); });

// -----------------------------
// Visualizations
// -----------------------------
function renderViz(){
  const type = DATA.vizType;
  vizEl.innerHTML = '';
  const scores = Array.isArray(DATA.routeScores) ? DATA.routeScores : [];

  if(type === 'RADAR'){
    const rid = picked || DATA.recommendedRoute || 'A';
    const segs = [1,2,3];
    const wrap = document.createElement('div');
    wrap.className = 'vizRow';

    segs.forEach((s)=>{
      const card = document.createElement('div');
      card.className = 'vizCard';
      const head = document.createElement('div');
      head.className = 'vizCardTitle';
      head.innerHTML = '<div style="font-weight:900">מקטע ' + s + '</div><div class="segBadge">' + s + '</div>';
      card.appendChild(head);

      const w=210, h=210;
      const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.setAttribute('width', String(w));
      svg.setAttribute('height', String(h));
      svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);

      const cx=w/2, cy=h/2, R=78;
      const cats=['speed','economy','scenic','comm'];
      const label=['מהירות','חסכון','נוף','קליטה'];

      function getVal(cat){
        const hit = scores.find(x=> String(x.route)===String(rid) && Number(x.segment)===Number(s));
        if(!hit) return 50;
        const v = (cat==='speed'? hit.speedScore : cat==='economy'? hit.economyScore : cat==='scenic'? hit.scenicScore : hit.commScore);
        return Number(v||0);
      }

      for(let r=1;r<=4;r++){
        const rr=R*(r/4);
        const poly=[];
        for(let i=0;i<cats.length;i++){
          const ang = (-Math.PI/2) + i*(2*Math.PI/cats.length);
          poly.push((cx+Math.cos(ang)*rr).toFixed(2)+','+(cy+Math.sin(ang)*rr).toFixed(2));
        }
        const p = document.createElementNS('http://www.w3.org/2000/svg','polygon');
        p.setAttribute('points', poly.join(' '));
        p.setAttribute('fill','none');
        p.setAttribute('stroke','rgba(255,255,255,0.18)');
        p.setAttribute('stroke-width','1');
        svg.appendChild(p);
      }

      for(let i=0;i<cats.length;i++){
        const ang=(-Math.PI/2)+i*(2*Math.PI/cats.length);
        const x2=cx+Math.cos(ang)*R;
        const y2=cy+Math.sin(ang)*R;
        const l=document.createElementNS('http://www.w3.org/2000/svg','line');
        l.setAttribute('x1',cx); l.setAttribute('y1',cy); l.setAttribute('x2',x2); l.setAttribute('y2',y2);
        l.setAttribute('stroke','rgba(255,255,255,0.18)'); l.setAttribute('stroke-width','1');
        svg.appendChild(l);

        const tx=document.createElementNS('http://www.w3.org/2000/svg','text');
        const lx=cx+Math.cos(ang)*(R+22);
        const ly=cy+Math.sin(ang)*(R+22);
        tx.setAttribute('x',lx); tx.setAttribute('y',ly);
        tx.setAttribute('text-anchor','middle');
        tx.setAttribute('font-size','12');
        tx.setAttribute('font-family','Arial, sans-serif');
        tx.setAttribute('fill','rgba(232,238,252,0.92)');
        tx.textContent=label[i];
        svg.appendChild(tx);
      }

      const pts=[];
      for(let i=0;i<cats.length;i++){
        const val=clamp(getVal(cats[i]),0,100)/100;
        const ang=(-Math.PI/2)+i*(2*Math.PI/cats.length);
        pts.push((cx+Math.cos(ang)*R*val).toFixed(2)+','+(cy+Math.sin(ang)*R*val).toFixed(2));
      }
      const poly=document.createElementNS('http://www.w3.org/2000/svg','polygon');
      poly.setAttribute('points',pts.join(' '));
      poly.setAttribute('fill','rgba(140,203,255,0.18)');
      poly.setAttribute('stroke','rgba(140,203,255,0.85)');
      poly.setAttribute('stroke-width','2');
      svg.appendChild(poly);

      card.appendChild(svg);
      wrap.appendChild(card);
    });

    vizEl.appendChild(wrap);
    return;
  }

  if(type === 'HEATMAP'){
    const table = document.createElement('table');
    table.className = 'heatTable';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>קטגוריה</th><th>מקטע 1</th><th>מקטע 2</th><th>מקטע 3</th></tr>';
    table.appendChild(thead);

    const cats = [
      { key:'speedScore', label:'מהירות' },
      { key:'economyScore', label:'חסכון' },
      { key:'scenicScore', label:'נוף' },
      { key:'commScore', label:'קליטה' },
    ];
    const rid = picked || DATA.recommendedRoute || 'A';
    const tbody = document.createElement('tbody');

    for(const c of cats){
      const tr = document.createElement('tr');
      const td0 = document.createElement('td');
      td0.textContent = c.label;
      tr.appendChild(td0);

      for(const seg of [1,2,3]){
        const td = document.createElement('td');
        const hit = scores.find(x=> String(x.route)===String(rid) && Number(x.segment)===Number(seg));
        const val = hit ? Number(hit[c.key] || 0) : 0;
        const a = clamp(val,0,100) / 100;
        td.style.background = 'rgba(140,203,255,' + (0.08 + a*0.35).toFixed(3) + ')';
        td.textContent = String(val.toFixed ? val.toFixed(0) : val);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    vizEl.appendChild(table);
    return;
  }

  // STACKED (! normalized)
  const rid = picked || DATA.recommendedRoute || 'A';
  const wrap = document.createElement('div');
  wrap.className = 'vizRow';

  for(const seg of [1,2,3]){
    const hit = scores.find(x=> String(x.route)===String(rid) && Number(x.segment)===Number(seg)) || {};
    const speed = Number(hit.speedScore || 0);
    const eco = Number(hit.economyScore || 0);
    const scenic = Number(hit.scenicScore || 0);
    const comm = Number(hit.commScore || 0);

    const card = document.createElement('div');
    card.className = 'vizCard';
    const head = document.createElement('div');
    head.className = 'vizCardTitle';
    head.innerHTML = '<div style="font-weight:900">מקטע ' + seg + '</div><div class="segBadge">' + seg + '</div>';
    card.appendChild(head);

    const barWrap = document.createElement('div');
    barWrap.style.display = 'flex';
    barWrap.style.flexDirection = 'column';
    barWrap.style.gap = '6px';

    function row(label, v){
      const r = document.createElement('div');
      r.style.display = 'grid';
      r.style.gridTemplateColumns = '90px 1fr 44px';
      r.style.gap = '10px';
      r.style.alignItems = 'center';
      const l = document.createElement('div'); l.textContent = label; l.style.fontWeight='900'; l.style.opacity='0.9';
      const track = document.createElement('div'); track.style.height='12px'; track.style.background='rgba(255,255,255,0.08)'; track.style.border='1px solid rgba(255,255,255,0.12)';
      const fill = document.createElement('div'); fill.style.height='100%'; fill.style.width = clamp(v,0,100) + '%'; fill.style.background='rgba(140,203,255,0.55)';
      track.appendChild(fill);
      const n = document.createElement('div'); n.textContent = String(v.toFixed ? v.toFixed(0) : v);
      r.appendChild(l); r.appendChild(track); r.appendChild(n);
      return r;
    }

    barWrap.appendChild(row('מהירות', speed));
    barWrap.appendChild(row('חסכון', eco));
    barWrap.appendChild(row('נוף', scenic));
    barWrap.appendChild(row('קליטה', comm));

    card.appendChild(barWrap);
    wrap.appendChild(card);
  }

  vizEl.appendChild(wrap);
}

function renderGantt(){
  ganttEl.innerHTML = '';
  const scores = Array.isArray(DATA.routeScores) ? DATA.routeScores : [];

  function getSegTimes(routeId){
    const t = [1,2,3].map(seg=>{
      const hit = scores.find(x=> String(x.route)===String(routeId) && Number(x.segment)===Number(seg));
      return hit ? Number(hit.timeS || 0) : 0;
    });
    const sum = t.reduce((a,b)=>a+b,0);
    const safe = sum > 0 ? sum : 1;
    return { t, sum: safe };
  }

  const palette = (DATA.colors && DATA.colors.routePalette) ? DATA.colors.routePalette : { A:'#3B82F6', B:'#F59E0B', C:'#A855F7' };

  for(const id of ['A','B','C']){
    const row = document.createElement('div');
    row.className = 'ganttRow';
    row.addEventListener('click', ()=> setPicked(id));

    const lbl = document.createElement('div');
    lbl.className = 'ganttLabel';
    lbl.textContent = hebRoute(id);
    row.appendChild(lbl);

    const bars = document.createElement('div');
    bars.className = 'ganttBars';
    bars.style.borderColor = (picked===id) ? 'rgba(140,203,255,0.65)' : 'rgba(255,255,255,0.14)';

    const { t, sum } = getSegTimes(id);
    for(let i=0;i<3;i++){
      const seg = document.createElement('div');
      seg.className = 'ganttSeg';
      seg.style.width = (t[i] / sum * 100).toFixed(2) + '%';
      seg.style.background = palette[id];
      seg.style.opacity = (picked===id) ? '1' : '0.72';
      seg.textContent = String(i+1);
      bars.appendChild(seg);
    }

    row.appendChild(bars);
    ganttEl.appendChild(row);
  }
}

// init
(function init(){
  drawCategories();
  drawRoutes();
  drawStartEnd();
  applyFilters();
  renderFilterRows();
  computeFit();
  setPicked(DATA.recommendedRoute || 'A');
})();
</script>
</body>
</html>`;
}


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
// Note: If the bbox is outside the current viewport, this may return fewer roads (because they're ! rendered).
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

// ✅ NEW: compute connector endpoint on the BORDER of the route tag square (! center)
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

    // manual parks (drawing + final)
    addSrc("manual-parks");
    addSrc("manual-park-draft-line");
    addSrc("manual-park-draft-points");
    addSrc("manual-park-preview-line");

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

    // MANUAL PARKS (final)
    if (!map.getLayer("manual-parks-fill")) {
        map.addLayer({
            id: "manual-parks-fill",
            type: "fill",
            source: "manual-parks",
            paint: { "fill-color": "#2ecc71", "fill-opacity": 0.55 },
        });
    }
    if (!map.getLayer("manual-parks-outline")) {
        map.addLayer({
            id: "manual-parks-outline",
            type: "line",
            source: "manual-parks",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#1e8f4d", "line-width": 2, "line-opacity": 0.9 },
        });
    }

    // MANUAL PARKS (draft)
    if (!map.getLayer("manual-park-draft-line-layer")) {
        map.addLayer({
            id: "manual-park-draft-line-layer",
            type: "line",
            source: "manual-park-draft-line",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#2ecc71", "line-width": 2.5, "line-opacity": 0.9 },
        });
    }
    if (!map.getLayer("manual-park-preview-line-layer")) {
        map.addLayer({
            id: "manual-park-preview-line-layer",
            type: "line",
            source: "manual-park-preview-line",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#2ecc71", "line-width": 2, "line-opacity": 0.6, "line-dasharray": [1.5, 1.5] as any },
        });
    }
    if (!map.getLayer("manual-park-draft-points-layer")) {
        map.addLayer({
            id: "manual-park-draft-points-layer",
            type: "circle",
            source: "manual-park-draft-points",
            paint: { "circle-radius": 4.5, "circle-color": "#2ecc71", "circle-stroke-width": 2, "circle-stroke-color": "#0b1220" },
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
                "circle-radius": 13,
                "circle-color": "#1d1d1d",
                "circle-opacity": 0.75,
                "circle-stroke-color": "#ffffff",
                "circle-stroke-opacity": 0.35,
                "circle-stroke-width": 1,
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
                    ["==", ["get", "disabled"], true],
                    "rgba(255,255,255,0.25)",
                    "rgba(32,99,244,0.95)",
                ],
                "circle-stroke-width": 2,
                "circle-stroke-color": "#ffffff",
                "circle-opacity": 0.95,
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
                "text-size": 11,
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

type RouteId = BadgeId;
const ROUTE_IDS: RouteId[] = ["A", "B", "C"];
type BadgePoint = { id: BadgeId; label: string; coord: LngLat };
type AnchorPoint = { id: BadgeId; coord: LngLat };

function buildBadgeFC(badges: BadgePoint[]) {
    return fcPoints(
        badges.map((b) => b.coord),
        badges.map((b) => ({ id: b.id, label: b.label }))
    );
}

// ✅ UPDATED: connector uses border-point on the tag frame (! center)
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

type ManualPark = {
    id: string;
    ring: LngLat[]; // ! closed; will be closed for rendering
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

function pointInPolygon(p: LngLat, ring: LngLat[]): boolean {
    // Ray casting in lon/lat space (OK for small areas)
    let inside = false;
    const x = p[0], y = p[1];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

function polylineFromRing(ring: LngLat[]): LngLat[] {
    if (ring.length < 2) return ring;
    const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
    return closed ? ring : [...ring, ring[0]];
}

function isNearManualParks(p: LngLat, parks: ManualPark[], bufferM: number): boolean {
    for (const pk of parks) {
        const ring = pk.ring;
        if (ring.length < 3) continue;
        if (pointInPolygon(p, ring)) return true;
        const line = polylineFromRing(ring);
        const d = pointToPolylineMinDistanceMeters(p, line);
        if (d <= bufferM) return true;
    }
    return false;
}

// Self-intersection guard for drawing parks (planar approx)
type Pt2 = { x: number; y: number };
function toPt2(p: LngLat, latRef: number): Pt2 {
    return { x: p[0] * metersPerDegLng(latRef), y: p[1] * metersPerDegLat() };
}
function segsIntersect(a: Pt2, b: Pt2, c: Pt2, d: Pt2): boolean {
    const orient = (p: Pt2, q: Pt2, r: Pt2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const onSeg = (p: Pt2, q: Pt2, r: Pt2) =>
        Math.min(p.x, r.x) - 1e-9 <= q.x && q.x <= Math.max(p.x, r.x) + 1e-9 &&
        Math.min(p.y, r.y) - 1e-9 <= q.y && q.y <= Math.max(p.y, r.y) + 1e-9;

    const o1 = orient(a, b, c);
    const o2 = orient(a, b, d);
    const o3 = orient(c, d, a);
    const o4 = orient(c, d, b);

    if (o1 === 0 && onSeg(a, c, b)) return true;
    if (o2 === 0 && onSeg(a, d, b)) return true;
    if (o3 === 0 && onSeg(c, a, d)) return true;
    if (o4 === 0 && onSeg(c, b, d)) return true;

    return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

function wouldSelfIntersectOnAdd(points: LngLat[], candidate: LngLat): boolean {
    if (points.length < 2) return false;
    const latRef = (points[0][1] + candidate[1]) / 2;
    const a = toPt2(points[points.length - 1], latRef);
    const b = toPt2(candidate, latRef);

    // check new segment against all non-adjacent segments
    for (let i = 0; i < points.length - 2; i++) {
        const c = toPt2(points[i], latRef);
        const d = toPt2(points[i + 1], latRef);
        if (segsIntersect(a, b, c, d)) return true;
    }
    return false;
}

function wouldSelfIntersectOnClose(points: LngLat[]): boolean {
    if (points.length < 3) return true;
    const latRef = points.reduce((s, p) => s + p[1], 0) / points.length;
    const a = toPt2(points[points.length - 1], latRef);
    const b = toPt2(points[0], latRef);

    // closing segment vs all segments except adjacent to endpoints
    for (let i = 1; i < points.length - 2; i++) {
        const c = toPt2(points[i], latRef);
        const d = toPt2(points[i + 1], latRef);
        if (segsIntersect(a, b, c, d)) return true;
    }
    return false;
}

function ringCentroid(ring: LngLat[]): LngLat {
    if (!ring.length) return [0, 0];
    let sx = 0, sy = 0;
    for (const p of ring) { sx += p[0]; sy += p[1]; }
    return [sx / ring.length, sy / ring.length];
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

function getParkFillLayerIds(map: maplibregl.Map): string[] {
    const layers = map.getStyle()?.layers ?? [];
    return layers
        .filter((l: any) => l?.type === "fill" && isParkLikeLayer(l))
        .map((l: any) => l.id);
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
    manualParks: ManualPark[]
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
            const inScenic = isNearManualParks(mid, manualParks, 20);

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


// =========================
// ✅ Visualizations Modal (additional component, non-invasive)
// =========================
type VizTab = "times" | "bars" | "radar" | "heatmap";

function routeHebrew(id: BadgeId) {
    return id === "A" ? "א" : id === "B" ? "ב" : "ג";
}

function fmtMinSecFromSeconds(s: number) {
    const total = Math.max(0, Math.round(s));
    const mm = Math.floor(total / 60);
    const ss = total % 60;
    return `${mm}:${String(ss).padStart(2, "0")}`;
}

const VIZ_CRITERIA = [
    { key: "speedScore" as const, label: "מהירות", color: "#3B82F6" },   // כחול
    { key: "economyScore" as const, label: "חיסכון", color: "#F59E0B" }, // צהוב
    { key: "scenicScore" as const, label: "נוף", color: "#A855F7" },     // סגול
    { key: "commScore" as const, label: "קליטה", color: "#22C55E" },     // ירוק
] as const;

function contrastText(hex: string) {
    const rgb = hexToRgb(hex);
    if (!rgb) return "#0b0f17";
    // perceived luminance
    const l = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
    return l < 0.55 ? "white" : "#0b0f17";
}

function mixRgb(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, t: number) {
    const tt = clamp01(t);
    const r = Math.round(a.r + (b.r - a.r) * tt);
    const g = Math.round(a.g + (b.g - a.g) * tt);
    const bb = Math.round(a.b + (b.b - a.b) * tt);
    return `rgb(${r},${g},${bb})`;
}

function SegmentCircle({ n }: { n: number }) {
    return (
        <span
            style={{
                width: 22,
                height: 22,
                borderRadius: 999,
                background: SELECTED_ROUTE_COLOR,
                color: "white",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 950,
                fontSize: 12,
                boxShadow: "0 1px 6px rgba(0,0,0,0.25)",
                border: "1px solid rgba(255,255,255,0.25)",
            }}
        >
            {n}
        </span>
    );
}

function SegmentLabel({ n }: { n: number }) {
    return (
        <div style={{ display: "inline-flex", alignItems: "center", gap: 7, justifyContent: "center" }}>
            <span style={{ fontWeight: 900, opacity: 0.9 }}>מקטע</span>
            <SegmentCircle n={n} />
        </div>
    );
}

function RoutePickerRight(props: {
    routeScores: RouteScore[];
    selectedRoute: BadgeId;
    onSelectRoute: (id: BadgeId) => void;
    title?: string;
}) {
    const { routeScores, selectedRoute, onSelectRoute, title } = props;
    const byRoute = useMemo(() => {
        const m = new Map<BadgeId, RouteScore>();
        for (const r of routeScores) m.set(r.route, r);
        return m;
    }, [routeScores]);

    return (
        <div
            style={{
                border: "1px solid rgba(255,255,255,0.10)",
                borderRadius: 14,
                padding: 12,
                background: "rgba(255,255,255,0.04)",
                height: "fit-content",
            }}
        >
            <div style={{ fontWeight: 950, marginBottom: 10, opacity: 0.9 }}>{title ?? "בחירת מסלול"}</div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {(["A", "B", "C"] as BadgeId[]).map((id) => {
                    const r = byRoute.get(id);
                    const isSel = id === selectedRoute;
                    return (
                        <div
                            key={id}
                            onClick={() => onSelectRoute(id)}
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: 10,
                                cursor: "pointer",
                                padding: "8px 10px",
                                borderRadius: 14,
                                border: isSel ? `3px solid ${SELECTED_ROUTE_COLOR}` : "1px solid rgba(255,255,255,0.12)",
                                background: isSel ? "rgba(30,78,216,0.12)" : "rgba(0,0,0,0.0)",
                            }}
                            title="לחץ כדי לבחור מסלול"
                        >
                            <div style={{ fontWeight: 950 }}>מסלול {routeHebrew(id)}</div>
                            <div style={{ opacity: 0.85, fontWeight: 900, fontSize: 12 }}>
                                {r ? fmtMinSecFromSeconds(r.totalTimeS) : "--:--"}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function VisualizationModal(props: {
    open: boolean;
    onClose: () => void;
    routeScores: RouteScore[];
    selectedRoute: BadgeId;
    onSelectRoute: (id: BadgeId) => void;
}) {
    const { open, onClose, routeScores, selectedRoute, onSelectRoute } = props;
    const [tab, setTab] = useState<VizTab>("times");

    const byRoute = useMemo(() => {
        const m = new Map<BadgeId, RouteScore>();
        for (const r of routeScores) m.set(r.route, r);
        return m;
    }, [routeScores]);

    const sel = byRoute.get(selectedRoute) ?? routeScores[0];

    useEffect(() => {
        if (!open) setTab("times");
    }, [open]);

    if (!open) return null;

    const Card = (p: { title: string; subtitle?: string; children: any }) => (
        <div
            style={{
                border: "1px solid rgba(255,255,255,0.10)",
                borderRadius: 16,
                padding: 14,
                background: "rgba(255,255,255,0.04)",
            }}
        >
            <div style={{ fontWeight: 950, fontSize: 15, textAlign: "right" }}>{p.title}</div>
            {p.subtitle ? <div style={{ marginTop: 6, fontSize: 12, opacity: 0.82, textAlign: "right" }}>{p.subtitle}</div> : null}
            <div style={{ marginTop: 12 }}>{p.children}</div>
        </div>
    );

    const ModalButton = (p: { active?: boolean; onClick: () => void; children: any; title?: string }) => (
        <button
            onClick={p.onClick}
            title={p.title}
            style={{
                border: p.active ? `2px solid ${SELECTED_ROUTE_COLOR}` : "1px solid rgba(255,255,255,0.12)",
                borderRadius: 999,
                padding: "8px 12px",
                background: p.active ? "rgba(140,203,255,0.18)" : "rgba(255,255,255,0.06)",
                color: "#e8eefc",
                cursor: "pointer",
                fontWeight: 900,
                fontSize: 13,
                lineHeight: 1,
            }}
        >
            {p.children}
        </button>
    );

    const Empty = () => (
        <div style={{ padding: 12, opacity: 0.85, lineHeight: 1.5 }}>אין עדיין נתונים להצגה. קודם לחץ “הצג תוצאות”.</div>
    );

    // Tab 1: Segment times (stacked horizontal, RTL axis)
    const TabTimes = () => {
        if (!routeScores.length) return <Empty />;

        const maxTotal = Math.max(1, ...routeScores.map((r) => r.totalTimeS || 0));

        // integer minute ticks (0,1,2,3...) – rounded, no decimals
        const maxMin = Math.max(1, Math.ceil(maxTotal / 60));
        const stepCandidates = [1, 2, 3, 5, 10, 15, 20, 30, 60];
        const step = stepCandidates.find((s) => Math.ceil(maxMin / s) <= 6) ?? 1;
        const ticksMin = Array.from({ length: Math.floor(maxMin / step) + 1 }, (_, i) => i * step);
        if (ticksMin[ticksMin.length - 1] !== maxMin) ticksMin.push(maxMin);

        return (
            <Card
                title="זמני מקטעים"
                subtitle="גרף נערם אופקי מימין לשמאל. לחץ על שורה כדי לבחור מסלול."
            >
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {(["A", "B", "C"] as BadgeId[]).map((id) => {
                        const r = byRoute.get(id);
                        if (!r) return null;
                        const isSel = id === selectedRoute;

                        // FIXED height (no jump when selected)
                        const barH = 20;

                        // place segments from RIGHT to LEFT
                        let cum = 0;

                        return (
                            <div
                                key={id}
                                onClick={() => onSelectRoute(id)}
                                style={{
                                    display: "grid",
                                    gridTemplateColumns: "84px 1fr 72px",
                                    gap: 10,
                                    alignItems: "center",
                                    cursor: "pointer",
                                    padding: "8px 10px",
                                    borderRadius: 14,
                                    border: isSel ? `3px solid ${SELECTED_ROUTE_COLOR}` : "1px solid rgba(255,255,255,0.10)",
                                    background: isSel ? "rgba(30,78,216,0.10)" : "transparent",
                                }}
                                title="לחץ כדי לבחור מסלול"
                            >
                                <div style={{ fontWeight: 950, fontSize: 14, textAlign: "right" }}>מסלול {routeHebrew(id)}</div>

                                <div
                                    style={{
                                        position: "relative",
                                        height: barH,
                                        borderRadius: 10,
                                        overflow: "hidden",
                                        border: "1px solid rgba(255,255,255,0.14)",
                                        background: "rgba(0,0,0,0.10)",
                                    }}
                                >
                                    {r.segments.map((s) => {
                                        const wPct = clamp01(s.timeS / maxTotal) * 100;
                                        const rightPct = clamp01(cum / maxTotal) * 100;
                                        cum += s.timeS;

                                        // show label more often, but keep readable
                                        const showLabel = wPct >= 4;

                                        return (
                                            <div
                                                key={s.segment}
                                                style={{
                                                    position: "absolute",
                                                    right: `${rightPct}%`,
                                                    width: `${wPct}%`,
                                                    top: 0,
                                                    bottom: 0,
                                                    background: isSel ? SELECTED_ROUTE_COLOR : ROUTE_COLOR,
                                                    opacity: isSel ? SELECTED_ROUTE_OPACITY : Math.min(0.75, ROUTE_OPACITY + 0.18),
                                                    display: "flex",
                                                    alignItems: "center",
                                                    justifyContent: "center",
                                                    fontWeight: 950,
                                                    color: "white",
                                                    fontSize: 13,
                                                    textShadow: "0 1px 2px rgba(0,0,0,0.40)",
                                                    // thicker segment separators
                                                    borderLeft: "3px solid rgba(255,255,255,0.70)",
                                                    boxSizing: "border-box",
                                                }}
                                                title={`מקטע ${s.segment}: ${fmtMinSecFromSeconds(s.timeS)}`}
                                            >
                                                {showLabel ? String(s.segment) : ""}
                                            </div>
                                        );
                                    })}
                                </div>

                                <div style={{ textAlign: "left", fontWeight: 900, fontSize: 13 }}>{fmtMinSecFromSeconds(r.totalTimeS)}</div>
                            </div>
                        );
                    })}
                </div>

                {/* RTL X axis – aligned to the bar column (NOT the route labels) */}
                <div style={{ marginTop: 12 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "84px 1fr 72px", gap: 10, alignItems: "center" }}>
                        <div />
                        <div style={{ position: "relative", height: 26 }}>
                            <div
                                style={{
                                    position: "absolute",
                                    insetInlineStart: 0,
                                    insetInlineEnd: 0,
                                    top: 12,
                                    height: 2,
                                    background: "rgba(255,255,255,0.20)",
                                }}
                            />
                            {ticksMin.map((tm) => {
                                const tSec = tm * 60;
                                const right = clamp01(tSec / maxTotal) * 100; // 0 at right, max at left
                                return (
                                    <div
                                        key={tm}
                                        style={{
                                            position: "absolute",
                                            right: `${right}%`,
                                            top: 0,
                                            transform: "translateX(50%)",
                                            textAlign: "center",
                                            whiteSpace: "nowrap",
                                        }}
                                    >
                                        <div style={{ width: 2, height: 10, background: "rgba(255,255,255,0.28)", margin: "0 auto" }} />
                                        <div style={{ fontSize: 11, opacity: 0.88, marginTop: 4 }}>{tm}</div>
                                    </div>
                                );
                            })}
                        </div>
                        <div />
                    </div>
                </div>
            </Card>
        );
    };

    // Tab 2: Bars (stacked additive, NOT normalized)
    const TabBars = () => {
        const segs = sel?.segments ?? [];
        if (!segs.length) return <Empty />;

        const chartH = 240;
        const maxTotal = VIZ_CRITERIA.length * 100; // additive, each metric is 0..100

        return (
            <Card title="גרף עמודות" subtitle="גרף עמודות נערמות (נערם מתווסף, לא נירמול ל־100%).">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 220px", gap: 14, alignItems: "start" }}>
                    <div style={{ overflowX: "auto" }}>
                        <div style={{ display: "flex", gap: 14, alignItems: "flex-end", paddingBottom: 6 }}>
                            {segs.map((s) => {
                                let cumH = 0;
                                return (
                                    <div key={s.segment} style={{ width: 180, textAlign: "center" }}>
                                        <div
                                            style={{
                                                height: chartH,
                                                position: "relative",
                                                border: "1px solid rgba(255,255,255,0.12)",
                                                borderRadius: 0,
                                                overflow: "hidden",
                                                background: "rgba(0,0,0,0.10)",
                                            }}
                                        >
                                            {VIZ_CRITERIA.map((c) => {
                                                const v = Math.max(0, Math.min(100, Number((s as any)[c.key] ?? 0)));
                                                const h = (v / maxTotal) * chartH;
                                                const bottom = cumH;
                                                cumH += h;

                                                const showFull = h >= 22;

                                                return (
                                                    <div
                                                        key={c.key}
                                                        style={{
                                                            position: "absolute",
                                                            left: 0,
                                                            right: 0,
                                                            bottom,
                                                            height: h,
                                                            background: c.color,
                                                            opacity: 0.92,
                                                            borderTop: "2px solid rgba(0,0,0,0.14)",
                                                            display: "flex",
                                                            alignItems: "center",
                                                            justifyContent: "space-between",
                                                            paddingInline: 8,
                                                            fontWeight: 950,
                                                            fontSize: 12,
                                                            color: contrastText(c.color),
                                                            boxSizing: "border-box",
                                                            textShadow:
                                                                contrastText(c.color) === "white"
                                                                    ? "0 1px 2px rgba(0,0,0,0.35)"
                                                                    : "none",
                                                            gap: 10,
                                                        }}
                                                        title={`${c.label}: ${Math.round(v)}`}
                                                    >
                                                        {showFull ? (
                                                            <>
                                                                <span style={{ opacity: 0.98 }}>{c.label}</span>
                                                                <span style={{ opacity: 0.98 }}>{Math.round(v)}</span>
                                                            </>
                                                        ) : (
                                                            <span style={{ margin: "0 auto" }}>{Math.round(v)}</span>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>

                                        <div style={{ marginTop: 10, fontWeight: 950 }}>{<SegmentLabel n={s.segment} />}</div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    <RoutePickerRight routeScores={routeScores} selectedRoute={selectedRoute} onSelectRoute={onSelectRoute} />
                </div>
            </Card>
        );
    };

    // Tab 3: Radar – 3 radars (segments 1–3)
    const TabRadar = () => {
        const segsAll = sel?.segments ?? [];
        const segs = segsAll.slice(0, 3);
        if (!segs.length) return <Empty />;

        const size = 240;
        const cx = size / 2;
        const cy = size / 2;
        const rMax = 86;

        const pointAt = (i: number, frac: number) => {
            const ang = -Math.PI / 2 + (i * 2 * Math.PI) / VIZ_CRITERIA.length;
            return { x: cx + Math.cos(ang) * rMax * frac, y: cy + Math.sin(ang) * rMax * frac };
        };

        const polyPoints = (s: SegmentScore) => {
            return VIZ_CRITERIA.map((ax, i) => {
                const v = clamp01(Number((s as any)[ax.key] ?? 0) / 100);
                const p = pointAt(i, v);
                return `${p.x},${p.y}`;
            }).join(" ");
        };

        return (
            <Card title="גרף רדאר" subtitle="3 רדארים (מקטע 1–3). בכל רדאר מוצגים ציוני הקטגוריות.">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 220px", gap: 14, alignItems: "start" }}>
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "space-evenly" }}>
                        {segs.map((s) => (
                            <div
                                key={s.segment}
                                style={{
                                    width: 300,
                                    border: "1px solid rgba(255,255,255,0.10)",
                                    borderRadius: 16,
                                    padding: 12,
                                    background: "rgba(0,0,0,0.06)",
                                }}
                            >
                                <div style={{ fontWeight: 950, marginBottom: 8, textAlign: "right" }}>
                                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                                        <span style={{ fontWeight: 950 }}>מקטע</span>
                                        <SegmentCircle n={s.segment} />
                                    </span>
                                </div>

                                <svg width={size} height={size} style={{ display: "block", margin: "0 auto" }}>
                                    {[0.25, 0.5, 0.75, 1].map((k) => (
                                        <circle
                                            key={k}
                                            cx={cx}
                                            cy={cy}
                                            r={rMax * k}
                                            fill="none"
                                            stroke={k === 1 ? "rgba(255,255,255,0.30)" : "rgba(255,255,255,0.14)"}
                                            strokeWidth={k === 1 ? 1.6 : 1}
                                        />
                                    ))}
                                    {VIZ_CRITERIA.map((ax, i) => {
                                        const p = pointAt(i, 1);
                                        return <line key={ax.key} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="rgba(255,255,255,0.20)" />;
                                    })}

                                    <polygon
                                        points={polyPoints(s)}
                                        fill={SELECTED_ROUTE_COLOR}
                                        fillOpacity={0.20}
                                        stroke={SELECTED_ROUTE_COLOR}
                                        strokeWidth={2}
                                    />

                                    {/* category labels: colored background + score */}
                                    {VIZ_CRITERIA.map((ax, i) => {
                                        const p = pointAt(i, 1.18);
                                        const val = Math.round(Number((s as any)[ax.key] ?? 0));
                                        const bg = ax.color;
                                        const fg = contrastText(bg);
                                        return (
                                            <foreignObject
                                                key={ax.key}
                                                x={p.x - 55}
                                                y={p.y - 13}
                                                width={110}
                                                height={26}
                                            >
                                                <div

                                                    style={{
                                                        width: "110px",
                                                        height: "26px",
                                                        display: "flex",
                                                        alignItems: "center",
                                                        justifyContent: "center",
                                                        gap: 6,
                                                        background: bg,
                                                        color: fg,
                                                        borderRadius: 999,
                                                        fontSize: 11,
                                                        fontWeight: 950,
                                                        boxShadow: "0 1px 6px rgba(0,0,0,0.25)",
                                                        border: "1px solid rgba(255,255,255,0.20)",
                                                        whiteSpace: "nowrap",
                                                        paddingInline: 8,
                                                        boxSizing: "border-box",
                                                    }}
                                                >
                                                    <span>{ax.label}</span>
                                                    <span style={{ opacity: 0.95 }}>{val}</span>
                                                </div>
                                            </foreignObject>
                                        );
                                    })}
                                </svg>
                            </div>
                        ))}
                    </div>

                    <RoutePickerRight routeScores={routeScores} selectedRoute={selectedRoute} onSelectRoute={onSelectRoute} />
                </div>
            </Card>
        );
    };

    // Tab 4: Heatmap table (fixed column widths, NO time column)
    const TabHeatmap = () => {
        const segs = sel?.segments ?? [];
        if (!segs.length) return <Empty />;

        const base = hexToRgb(ROUTE_COLOR) ?? { r: 140, g: 203, b: 255 };
        const white = { r: 255, g: 255, b: 255 };

        const cellBg = (v: number) => {
            // keep background light enough so black numbers remain visible
            const t = clamp01((v ?? 0) / 100);
            const mixT = 0.12 + 0.42 * t; // 0.12..0.54 (never too dark)
            return mixRgb(white, base, mixT);
        };

        const colW = 96;

        return (
            <Card title="מפת חום" subtitle="טבלה עם עמודות ברוחב קבוע. המספרים תמיד בולטים (רקע לא כהה מדי).">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 220px", gap: 14, alignItems: "start" }}>
                    <div style={{ overflowX: "auto" }}>
                        <table
                            style={{
                                width: "max-content",
                                borderCollapse: "separate",
                                borderSpacing: 6,
                                direction: "rtl",
                            }}
                        >
                            <thead>
                                <tr>
                                    <th style={{ textAlign: "right", fontSize: 12, opacity: 0.9, padding: 2, width: 78 }}>
                                        מקטע
                                    </th>
                                    {VIZ_CRITERIA.map((m) => (
                                        <th key={m.key} style={{ textAlign: "center", fontSize: 12, padding: 2, width: colW }}>
                                            <div
                                                style={{
                                                    display: "inline-flex",
                                                    alignItems: "center",
                                                    justifyContent: "center",
                                                    gap: 6,
                                                    background: m.color,
                                                    color: contrastText(m.color),
                                                    borderRadius: 999,
                                                    padding: "4px 10px",
                                                    fontWeight: 950,
                                                    border: "1px solid rgba(255,255,255,0.20)",
                                                    boxShadow: "0 1px 6px rgba(0,0,0,0.18)",
                                                    whiteSpace: "nowrap",
                                                }}
                                            >
                                                {m.label}
                                            </div>
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {segs.map((s) => (
                                    <tr key={s.segment}>
                                        <td style={{ padding: 2, textAlign: "right", width: 78 }}>
                                            <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                                                <span style={{ fontWeight: 900, opacity: 0.9 }}>מקטע</span>
                                                <SegmentCircle n={s.segment} />
                                            </div>
                                        </td>

                                        {VIZ_CRITERIA.map((m) => {
                                            const val = Math.round(Number((s as any)[m.key] ?? 0));
                                            return (
                                                <td key={m.key} style={{ padding: 2, width: colW }}>
                                                    <div
                                                        style={{
                                                            background: cellBg(val),
                                                            borderRadius: 10,
                                                            padding: "8px 6px",
                                                            textAlign: "center",
                                                            fontWeight: 950,
                                                            color: "rgba(8,10,14,0.92)",
                                                            border: "1px solid rgba(0,0,0,0.10)",
                                                        }}
                                                        title={`${m.label}: ${val}`}
                                                    >
                                                        {val}
                                                    </div>
                                                </td>
                                            );
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <RoutePickerRight routeScores={routeScores} selectedRoute={selectedRoute} onSelectRoute={onSelectRoute} />
                </div>
            </Card>
        );
    };

    return (
        <div
            style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.60)",
                zIndex: 9999,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 16,
            }}
            onClick={onClose}
        >
            <div
                style={{
                    width: "min(1080px, 96vw)",
                    maxHeight: "92vh",
                    overflow: "auto",
                    borderRadius: 18,
                    background: "#0b0f17",
                    color: "#e8eefc",
                    border: "1px solid rgba(255,255,255,0.10)",
                    boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <div style={{ padding: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                    <div style={{ fontWeight: 950, fontSize: 16 }}>ויזואליזציות</div>
                    <button
                        onClick={onClose}
                        style={{
                            padding: "8px 12px",
                            borderRadius: 10,
                            border: "1px solid rgba(255,255,255,0.14)",
                            background: "rgba(255,255,255,0.06)",
                            color: "white",
                            cursor: "pointer",
                            fontWeight: 900,
                        }}
                    >
                        סגור
                    </button>
                </div>

                <div
                    style={{
                        padding: "10px 14px",
                        borderBottom: "1px solid rgba(255,255,255,0.10)",
                        display: "flex",
                        gap: 10,
                        flexWrap: "wrap",
                    }}
                >
                    <ModalButton active={tab === "times"} onClick={() => setTab("times")}>
                        זמני מקטעים
                    </ModalButton>
                    <ModalButton active={tab === "bars"} onClick={() => setTab("bars")}>
                        גרף עמודות
                    </ModalButton>
                    <ModalButton active={tab === "radar"} onClick={() => setTab("radar")}>
                        גרף רדאר
                    </ModalButton>
                    <ModalButton active={tab === "heatmap"} onClick={() => setTab("heatmap")}>
                        מפת חום
                    </ModalButton>
                </div>

                <div style={{ padding: 14, overflow: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
                    {tab === "times" && <TabTimes />}
                    {tab === "bars" && <TabBars />}
                    {tab === "radar" && <TabRadar />}
                    {tab === "heatmap" && <TabHeatmap />}
                </div>
            </div>
        </div>
    );
}


export default function App() {
    const mapDivRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<maplibregl.Map | null>(null);

    const [mapStyleTick, setMapStyleTick] = useState(0);

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

    // --- Export results to CSV (for external Excel analysis) ---
    const exportResultsToCsv = useCallback(() => {
        if (!routeScores || routeScores.length === 0) {
            alert("אין נתונים לייצוא. לחץ/י קודם על 'הצג תוצאות' כדי לחשב נתונים.");
            return;
        }

        const delim = ";"; // safer for Excel locales where decimal separator is ','
        const esc = (v: any) => {
            const s = v === null || v === undefined ? "" : String(v);
            // Escape quotes; wrap when needed (delimiter/newline/quotes)
            const needsWrap = s.includes('"') || s.includes("\n") || s.includes("\r") || s.includes(delim);
            const out = s.replace(/"/g, '""');
            return needsWrap ? `"${out}"` : out;
        };

        const header = [
            "מסלול",
            "מקטע",
            "אורך_מטר",
            "זמן_שניות",
            "זמן_דקות",
            "מהירות_0_100",
            "חסכוני_0_100",
            "נופי_0_100",
            "מחובר_0_100",
            "עומס_share",
            "אגרה_share",
            "נוף_share",
            "קליטה_share",
            "Winner",
        ];

        const lines: string[] = [];
        lines.push(header.map(esc).join(delim));

        const safeNum = (n: any, digits = 2) => {
            const x = typeof n === "number" && Number.isFinite(n) ? n : NaN;
            if (!Number.isFinite(x)) return "";
            return digits === 0 ? String(Math.round(x)) : x.toFixed(digits);
        };

        const weightedAvg = (pairs: Array<{ w: number; v: number }>) => {
            const wSum = pairs.reduce((acc, p) => acc + (Number.isFinite(p.w) ? p.w : 0), 0);
            if (wSum <= 0) return 0;
            const num = pairs.reduce((acc, p) => acc + (Number.isFinite(p.w) ? p.w : 0) * (Number.isFinite(p.v) ? p.v : 0), 0);
            return num / wSum;
        };

        // Sort A,B,C if present
        const order: Record<string, number> = { A: 1, B: 2, C: 3 };
        const sorted = [...routeScores].sort((a: any, b: any) => (order[a.route] ?? 99) - (order[b.route] ?? 99));

        sorted.forEach((rs: any) => {
            const segs: any[] = Array.isArray(rs.segments) ? rs.segments : [];
            segs.forEach((seg: any) => {
                const segLabel = seg.label ?? (typeof seg.segmentIndex === "number" ? `מקטע ${seg.segmentIndex + 1}` : "");
                lines.push(
                    [
                        rs.route ?? "",
                        segLabel,
                        safeNum(seg.lengthM, 0),
                        safeNum(seg.timeS, 0),
                        safeNum((seg.timeS ?? 0) / 60, 2),
                        safeNum(seg.speedScore, 2),
                        safeNum(seg.econScore, 2),
                        safeNum(seg.scenicScore, 2),
                        safeNum(seg.commScore, 2),
                        safeNum(seg.trafficShare, 3),
                        safeNum(seg.tollShare, 3),
                        safeNum(seg.scenicShare, 3),
                        safeNum(seg.commShare, 3),
                        seg.winner ?? "",
                    ].map(esc).join(delim)
                );
            });

            // Add a summary row per route (weighted by length)
            const totalLenM = segs.reduce((acc, s) => acc + (typeof s.lengthM === "number" ? s.lengthM : 0), 0);
            const totalTimeS = segs.reduce((acc, s) => acc + (typeof s.timeS === "number" ? s.timeS : 0), 0);
            const avgSpeed = weightedAvg(segs.map((s) => ({ w: typeof s.lengthM === "number" ? s.lengthM : 0, v: typeof s.speedScore === "number" ? s.speedScore : 0 })));
            const avgEcon = weightedAvg(segs.map((s) => ({ w: typeof s.lengthM === "number" ? s.lengthM : 0, v: typeof s.econScore === "number" ? s.econScore : 0 })));
            const avgScenic = weightedAvg(segs.map((s) => ({ w: typeof s.lengthM === "number" ? s.lengthM : 0, v: typeof s.scenicScore === "number" ? s.scenicScore : 0 })));
            const avgComm = weightedAvg(segs.map((s) => ({ w: typeof s.lengthM === "number" ? s.lengthM : 0, v: typeof s.commScore === "number" ? s.commScore : 0 })));

            lines.push(
                [
                    rs.route ?? "",
                    "סה\"כ",
                    safeNum(totalLenM, 0),
                    safeNum(totalTimeS, 0),
                    safeNum(totalTimeS / 60, 2),
                    safeNum(avgSpeed, 2),
                    safeNum(avgEcon, 2),
                    safeNum(avgScenic, 2),
                    safeNum(avgComm, 2),
                    "",
                    "",
                    "",
                    "",
                    "",
                ].map(esc).join(delim)
            );
        });

        const csvText = "\uFEFF" + lines.join("\n"); // UTF-8 BOM for Hebrew in Excel
        const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        a.download = `geovis_results_${stamp}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }, [routeScores]);



    // --- Task Builder (אוטומציה ליצירת דילמות לפי מטלה) ---
    type TaskCat = "מהיר" | "חסכוני" | "נופי" | "מחובר" | "None";
    type TaskScope = "כל המקטעים" | "מקטע 1" | "מקטע 2" | "מקטע 3";
    type TaskDifficulty = "High" | "Medium" | "Low";
    type TaskMode = "Weighted" | "Lexicographic";

    const TASK_CAT_OPTIONS: TaskCat[] = ["מהיר", "חסכוני", "נופי", "מחובר"];
    const TASK_SCOPE_OPTIONS: TaskScope[] = ["כל המקטעים", "מקטע 1", "מקטע 2", "מקטע 3"];
    const TASK_DIFFICULTY_OPTIONS: TaskDifficulty[] = ["High", "Medium", "Low"];
    const TASK_MODE_OPTIONS: TaskMode[] = ["Weighted", "Lexicographic"];

    // גלובלי: קטגוריה ראשית/משנית + תחום המקטעים
    const [taskPrimaryCat, setTaskPrimaryCat] = useState<TaskCat>("מחובר");
    const [taskPrimaryScope, setTaskPrimaryScope] = useState<TaskScope>("כל המקטעים");
    const [taskSecondaryCat, setTaskSecondaryCat] = useState<TaskCat>("None");

    // לוקאלי: אופציונלי – קטגוריה במקטע ספציפי
    const [taskLocalEnabled, setTaskLocalEnabled] = useState<boolean>(false);
    const [taskLocalCat, setTaskLocalCat] = useState<TaskCat>("נופי");
    const [taskLocalSegment, setTaskLocalSegment] = useState<1 | 2 | 3>(3);

    // רמת קושי/שונות (כמה התוצאות קרובות)
    const [taskDifficulty, setTaskDifficulty] = useState<TaskDifficulty>("Medium");

    // איך מדרגים (משוקלל מול לקסיגרפי)
    const [taskMode, setTaskMode] = useState<TaskMode>("Weighted");

    // משקולות (במצב משוקלל)
    const [taskWPrimary, setTaskWPrimary] = useState<number>(3);
    const [taskWSecondary, setTaskWSecondary] = useState<number>(2);
    const [taskWTime, setTaskWTime] = useState<number>(1);

    // שער פסילה: אם קטגוריה "חובה" לא קיימת (למשל 0% כיסוי), המסלול נפסל – אלא אם אין אף מסלול שעובר את השער.
    const [taskGateMinFrac, setTaskGateMinFrac] = useState<number>(0);

    // שובר שוויון
    const [taskTieBreaker, setTaskTieBreaker] = useState<"זמן" | "מהירות">("זמן");

    // אפשר לבחור ידנית על מי "נרצה" לפייבר – אחרת אוטומטי (בחירה לפי זמן בסיסי)
    const [taskFavorRoute, setTaskFavorRoute] = useState<"Auto" | RouteId>("Auto");

    // תוצאה
    const [taskWinnerRoute, setTaskWinnerRoute] = useState<RouteId | null>(null);
    const [taskWinnerNote, setTaskWinnerNote] = useState<string>("");
    // ---- Export participant screen ----
    const [exportOpen, setExportOpen] = useState(false);
    const [exportScenarioName, setExportScenarioName] = useState(() => {
        const d = new Date();
        const ymd = d.toISOString().slice(0, 10);
        return `Scenario_${ymd}_${Date.now()}`;
    });
    const [exportTaskText, setExportTaskText] = useState(
        "בחר את המסלול המיטבי לאור הדרישות. ניתן לעיין במפה ובפירוט המקטעים למטה לפני קבלת החלטה."
    );
    const [exportVizType, setExportVizType] = useState<ExportVizType>("STACKED");
    const [exportRecommendedRoute, setExportRecommendedRoute] = useState<"A" | "B" | "C">("A");

    const [exportSaveMode, setExportSaveMode] = useState<ExportSaveMode>("downloads");
    const [exportDirHandle, setExportDirHandle] = useState<any>(null);
    const [exportSavePath, setExportSavePath] = useState<string>("Downloads");
    const [exportLastSaved, setExportLastSaved] = useState<string>("");

    // Visualizations modal
    const [showVisualizations, setShowVisualizations] = useState(false);

    // Manual parks (user drawn)
    const [showBaseParks, setShowBaseParks] = useState(true);
    const [showManualParks, setShowManualParks] = useState(true);

    // Right-panel helpers
    const [showLayerManager, setShowLayerManager] = useState(false);
    const [showCatSettings, setShowCatSettings] = useState(false);

    const [manualParks, setManualParks] = useState<ManualPark[]>([]);
    const manualParksRef = useRef<ManualPark[]>([]);
    useEffect(() => { manualParksRef.current = manualParks; }, [manualParks]);

    const manualParkMarkersRef = useRef<Record<string, maplibregl.Marker>>({});
    const manualParkIdSeqRef = useRef(1);

    const [isDrawingPark, setIsDrawingPark] = useState(false);
    const isDrawingParkRef = useRef(false);
    useEffect(() => { isDrawingParkRef.current = isDrawingPark; }, [isDrawingPark]);

    const [draftParkPts, setDraftParkPts] = useState<LngLat[]>([]);
    const draftParkPtsRef = useRef<LngLat[]>([]);
    useEffect(() => { draftParkPtsRef.current = draftParkPts; }, [draftParkPts]);
    const draftMouseRef = useRef<LngLat | null>(null);

    // Keep manual parks geojson in sync
    useEffect(() => {
        updateManualParksSource();

        // keep markers in sync (add missing markers, remove obsolete)
        const map = mapRef.current;
        if (!map) return;

        const currentIds = new Set(manualParks.map((p) => p.id));
        // remove stale markers
        for (const id of Object.keys(manualParkMarkersRef.current)) {
            if (!currentIds.has(id)) {
                try { manualParkMarkersRef.current[id].remove(); } catch { }
                delete manualParkMarkersRef.current[id];
            }
        }
        // add markers for new parks
        for (const p of manualParks) {
            if (!manualParkMarkersRef.current[p.id]) addManualParkMarker(p);
        }

        syncManualParkMarkersVisibility();
    }, [manualParks, updateManualParksSource, addManualParkMarker, syncManualParkMarkersVisibility]);

    useEffect(() => {
        updateManualParkDraftSources();
    }, [draftParkPts, updateManualParkDraftSources]);

    // Toggle manual parks layer visibility
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const vis = showManualParks ? "visible" : "none";
        for (const id of ["manual-parks-fill", "manual-parks-outline", "manual-park-draft-line-layer", "manual-park-draft-points-layer", "manual-park-preview-line-layer"]) {
            if (map.getLayer(id)) {
                try { map.setLayoutProperty(id, "visibility", vis); } catch { }
            }
        }
        syncManualParkMarkersVisibility();
    }, [showManualParks, syncManualParkMarkersVisibility]);

    // Toggle base parks by switching visibility of detected park fill layers
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const vis = showBaseParks ? "visible" : "none";
        for (const id of parkLayerIdsRef.current) {
            if (map.getLayer(id)) {
                try { map.setLayoutProperty(id, "visibility", vis); } catch { }
            }
        }
    }, [showBaseParks]);

    // Keyboard controls while drawing
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (!isDrawingParkRef.current) return;

            if (e.key === "Escape") {
                e.preventDefault();
                setDraftParkPts([]);
                draftMouseRef.current = null;
                setIsDrawingPark(false);
                return;
            }

            if (e.key === "Delete" || e.key === "Backspace") {
                e.preventDefault();
                setDraftParkPts((prev) => prev.slice(0, Math.max(0, prev.length - 1)));
                return;
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    // Cursor while drawing
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        try { map.getCanvas().style.cursor = isDrawingPark ? "crosshair" : ""; } catch { }
    }, [isDrawingPark]);

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

    const layerFilterActive = useMemo(() => {
        // Any deviation from defaults is considered an active filter/override
        const allOn =
            showRoads &&
            showTransit &&
            showLabels &&
            showPOI &&
            showBaseParks &&
            showManualParks &&
            showCatTraffic &&
            showCatToll &&
            showCatComm;
        return !allOn;
    }, [showRoads, showTransit, showLabels, showPOI, showBaseParks, showManualParks, showCatTraffic, showCatToll, showCatComm]);

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
            try { ensureOverlay(map); } catch { }

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
                    manualParksRef.current
                );
                setRouteScores(scores);
                setShowResults(false);
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

    // ----------------------
    // Task → Auto scenario generation (entities + balancing)
    // ----------------------

    const taskScopeToSegIdx = (scope: TaskScope): number[] => {
        switch (scope) {
            case "מקטע 1":
                return [0];
            case "מקטע 2":
                return [1];
            case "מקטע 3":
                return [2];
            case "כל המקטעים":
            default:
                return [0, 1, 2];
        }
    };

    const segValue01 = (seg: SegmentScore, cat: TaskCat): number => {
        switch (cat) {
            case "מהיר":
                // מהירות: משתמשים בציון (0..100) וממירים ל-0..1
                return clamp01(seg.speedScore / 100);
            case "חסכוני":
                return clamp01(seg.economyScore / 100);
            case "נופי":
                return clamp01(seg.scenicScore / 100);
            case "מחובר":
                // כאן חשוב: "האם בכלל קיימת קליטה" נוח יותר דרך fracComm (0..1)
                return clamp01(seg.fracComm);
            case "None":
            default:
                return 0;
        }
    };

    const segScore0100 = (seg: SegmentScore, cat: TaskCat): number => {
        switch (cat) {
            case "מהיר":
                return seg.speedScore;
            case "חסכוני":
                return seg.economyScore;
            case "נופי":
                return seg.scenicScore;
            case "מחובר":
                // נשמור עקביות: 0..100 לפי fracComm
                return Math.round(100 * clamp01(seg.fracComm));
            case "None":
            default:
                return 0;
        }
    };

    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const min = (xs: number[]) => (xs.length ? xs.reduce((a, b) => (b < a ? b : a), xs[0]) : 0);

    const split3 = (line: LngLat[]) => {
        const { i1, i2 } = findSplitIndices3(line);
        const s1 = line.slice(0, i1 + 1);
        const s2 = line.slice(i1, i2 + 1);
        const s3 = line.slice(i2);
        return [s1, s2, s3] as const;
    };

    const makeSquareRing = (center: LngLat, sizeM: number): LngLat[] => {
        const h = sizeM / 2;
        const a = offsetMeters(center, -h, -h);
        const b = offsetMeters(center, +h, -h);
        const c = offsetMeters(center, +h, +h);
        const d = offsetMeters(center, -h, +h);
        return [a, b, c, d, a];
    };

    const applyTaskScenario = useCallback(() => {
        const map = mapRef.current;
        const lines = tripleLinesRef.current;
        if (!map) return;
        if (!lines.A.length || !lines.B.length || !lines.C.length) return;

        // --- 0) Base scores (no entities) ---
        const baseScores = computeRouteScores(map, lines, [], [], [], manualParksRef.current);
        const byTime = [...baseScores].sort((a, b) => a.totalTimeS - b.totalTimeS);
        const autoFav: RouteId = (byTime[1]?.route || byTime[0]?.route || "A") as RouteId; // median time
        const favored: RouteId = (taskFavorRoute === "Auto" ? autoFav : taskFavorRoute) as RouteId;
        const others = (ROUTE_IDS as RouteId[]).filter((r) => r !== favored);
        const othersByTime = [...others].sort((ra, rb) => {
            const ta = baseScores.find((x) => x.route === ra)?.totalTimeS ?? 0;
            const tb = baseScores.find((x) => x.route === rb)?.totalTimeS ?? 0;
            return ta - tb;
        });
        const runnerUp = othersByTime[0] || others[0] || "B";
        const third = othersByTime[1] || others[1] || "C";

        // --- 1) Target gaps (difficulty) ---
        const gap = (() => {
            switch (taskDifficulty) {
                case "High":
                    return { top2: 0.03, top3: 0.07, primaryDelta: 0.05 };
                case "Low":
                    return { top2: 0.15, top3: 0.30, primaryDelta: 0.25 };
                case "Medium":
                default:
                    return { top2: 0.08, top3: 0.18, primaryDelta: 0.12 };
            }
        })();

        // --- 2) Desired 0..1 strength for primary category ---
        const primaryStrength = {
            [favored]: 0.70,
            [runnerUp]: clamp01(0.70 - gap.primaryDelta),
            [third]: clamp01(0.70 - gap.primaryDelta * 1.6),
        } as Record<RouteId, number>;

        // Optional secondary: smaller separation
        const secondaryStrength = {
            [favored]: 0.55,
            [runnerUp]: 0.50,
            [third]: 0.45,
        } as Record<RouteId, number>;

        // Local requirement: highest on favored on that segment
        const localStrength = {
            [favored]: 0.75,
            [runnerUp]: 0.55,
            [third]: 0.45,
        } as Record<RouteId, number>;

        const scopeIdx = taskScopeToSegIdx(taskPrimaryScope);

        // --- 3) Build entities (comm zones / parks / toll / traffic) ---
        let newCommZones: { id: string; ring: LngLat[]; radiusM: number }[] = [];
        const parksNow = manualParksRef.current;
        let newTollSegs: { id: string; coords: LngLat[] }[] = [];
        let newTollLabels: { coord: LngLat; side: "left" | "right" }[] = [];

        const sampleDists = (segLen: number) => [0.08, 0.2, 0.32, 0.44, 0.56, 0.68, 0.8, 0.92].map((t) => t * segLen);

        const addCategoryAtSamples = (
            route: RouteId,
            segLine: LngLat[],
            strength01: number,
            cat: TaskCat,
            segKey: string
        ) => {
            if (cat === "None") return;
            const segLen = polylineMeters(segLine);
            if (segLen <= 1) return;


            const segCum = cumulativeDistances(segLine);
            const dists = sampleDists(segLen);
            const n = Math.max(0, Math.min(8, Math.round(strength01 * 8)));
            const pick = dists.slice(0, n);

            for (let i = 0; i < pick.length; i++) {
                const center = pointAtDistance(segLine, segCum, pick[i]);
                const idBase = `${route}_${segKey}_${cat}_${i}`;

                if (cat === "מחובר") {
                    const radiusM = 220;
                    const ring = circleRing(center, radiusM, 24);
                    newCommZones.push({ id: `c_${idBase}`, ring, radiusM });
                } else if (cat === "נופי") {
                    // פארקים מוזנים ידנית — לא מייצרים כאן אובייקטים אוטומטיים.
                } else if (cat === "חסכוני") {
                    // כדי להוריד חסכוני – שמים אגרה; לכן כאן נשים אגרה דווקא על מסלולים שאינם מועדפים.
                    // בפועל נשתמש בזה רק כשמבקשים *לא* חסכוני. כשמבקשים חסכוני, נשאיר ללא אגרות.
                    const start = max2(0, pick[i] - 60);
                    const end = min2(segLen, pick[i] + 60);
                    const coords = subLineBetweenMeters(segLine, start, end);
                    newTollSegs.push({ id: `t_${idBase}`, coords });
                    if (i == 0) {
                        newTollLabels.push({ coord: center, side: "right" });
                    }
                }
            }
        };

        // Primary/secondary/global/local → place entities
        for (const rid of ROUTE_IDS as RouteId[]) {
            const segs = split3(lines[rid]);

            for (let si = 0; si < 3; si++) {
                const segLine = segs[si];
                const segKey = `seg${si + 1}`;

                // Primary: only within requested scope; outside scope we still place a small amount for realism
                const pStrength = scopeIdx.includes(si) ? primaryStrength[rid] : clamp01(primaryStrength[rid] * 0.25);
                addCategoryAtSamples(rid, segLine, pStrength, taskPrimaryCat, segKey);

                // Secondary (soft) across the same scope by default
                if (taskSecondaryCat !== "None") {
                    const sStrength = scopeIdx.includes(si) ? secondaryStrength[rid] : clamp01(secondaryStrength[rid] * 0.2);
                    addCategoryAtSamples(rid, segLine, sStrength, taskSecondaryCat, `sec_${segKey}`);
                }

                // Local requirement
                if (taskLocalEnabled && taskLocalSegment === (si + 1)) {
                    addCategoryAtSamples(rid, segLine, localStrength[rid], taskLocalCat, `local_${segKey}`);
                }
            }
        }

        // If primary is "חסכוני": do NOT add tolls on the favored route; instead push tolls to others.
        if (taskPrimaryCat === "חסכוני") {
            // wipe tolls created by primary (if any)
            newTollSegs = [];
            newTollLabels = [];
            for (const rid of [runnerUp, third]) {
                const segs = split3(lines[rid]);
                // add toll on ~50% of segment 2 (looks like a toll road section)
                const segLine = segs[1];
                const segLen = polylineMeters(segLine);
                if (segLen > 1) {
                    const start = segLen * 0.25;
                    const end = segLen * 0.65;
                    const coords = subLineBetweenMeters(segLine, start, end);
                    const id = `toll_${rid}_seg2`;
                    newTollSegs.push({ id, coords });
                    newTollLabels.push({ coord: pointAtDistance(segLine, cumulativeDistances(segLine), (start + end) / 2), side: "right" });
                }
            }
        }

        // --- 4) Time balancing via traffic (slow down fast routes so that favored is fastest-but-!-too-much) ---
        const SPEED_FREE_KMH = 30;
        const SPEED_TRAFFIC_KMH = 10;
        const vFree = (SPEED_FREE_KMH * 1000) / 3600;
        const vTraffic = (SPEED_TRAFFIC_KMH * 1000) / 3600;
        const extraSecPerM = (1 / vTraffic) - (1 / vFree);

        // compute scores without traffic first
        const preTrafficScores = computeRouteScores(map, lines, [], newTollSegs, newCommZones, parksNow);
        const tFav = preTrafficScores.find((x) => x.route === favored)?.totalTimeS ?? 0;
        const targetRunner = tFav * (1 + gap.top2);
        const targetThird = tFav * (1 + gap.top3);

        const targetTime: Record<RouteId, number> = {
            A: preTrafficScores.find((x) => x.route === "A")?.totalTimeS ?? 0,
            B: preTrafficScores.find((x) => x.route === "B")?.totalTimeS ?? 0,
            C: preTrafficScores.find((x) => x.route === "C")?.totalTimeS ?? 0,
        };
        targetTime[favored] = tFav;
        targetTime[runnerUp] = max2(targetRunner, targetTime[runnerUp]);
        targetTime[third] = max2(targetThird, targetTime[third]);

        const newTrafficSegs: { id: string; coords: LngLat[] }[] = [];

        const addTrafficForRoute = (rid: RouteId, desiredTotalTime: number) => {
            const rs = preTrafficScores.find((x) => x.route === rid);
            if (!rs) return;
            const deltaS = desiredTotalTime - rs.totalTimeS;
            if (deltaS <= 0.5) return;
            const routeLine = lines[rid];
            const routeLen = polylineMeters(routeLine);
            if (routeLen <= 10) return;

            const neededMeters = clamp(deltaS / extraSecPerM, 0, routeLen * 0.85);
            const frac = clamp01(neededMeters / routeLen);
            const segs = split3(routeLine);

            for (let si = 0; si < 3; si++) {
                const segLine = segs[si];
                const segLen = polylineMeters(segLine);
                if (segLen <= 1) continue;
                const n = Math.max(0, Math.min(8, round((frac * segLen / routeLen) * 24))); // a few chunks per segment
                if (n <= 0) continue;
                const dists = sampleDists(segLen);
                const pick = dists.slice(0, min2(n, len(dists)));
                for (let i = 0; i < pick.length; i++) {
                    const start = max2(0, pick[i] - 80);
                    const end = min2(segLen, pick[i] + 80);
                    const coords = subLineBetweenMeters(segLine, start, end);
                    newTrafficSegs.push({ id: `tr_${rid}_s${si + 1}_${i}`, coords });
                }
            }
        };

        // Utility helpers used above but ! global in this file:
        function clamp(v: number, lo: number, hi: number) {
            return Math.max(lo, Math.min(hi, v));
        }
        function clamp01(v: number) {
            return clamp(v, 0, 1);
        }
        function round(v: number) {
            return Math.round(v);
        }
        function max2(a: number, b: number) {
            return a > b ? a : b;
        }
        function min2(a: number, b: number) {
            return a < b ? a : b;
        }
        function len<T>(x: T[]) {
            return x.length;
        }

        addTrafficForRoute(runnerUp, targetTime[runnerUp]);
        addTrafficForRoute(third, targetTime[third]);

        // --- 5) Commit entities + recompute scores ---
        setCatTrafficSegs(newTrafficSegs);
        setCatTollSegs(newTollSegs);
        setCatTollLabels(newTollLabels);
        setCatCommZones(newCommZones);

        const finalScores = computeRouteScores(map, lines, newTrafficSegs, newTollSegs, newCommZones, parksNow);
        setRouteScores(finalScores);
        setShowResults(false);

        // --- 6) Decide winner (task mode) ---
        const allTimes = finalScores.map((x) => x.totalTimeS);
        const tMin = Math.min(...allTimes);
        const tMax = Math.max(...allTimes);
        const timeScore = (t: number) => (tMax <= tMin + 1e-6 ? 100 : ((tMax - t) / (tMax - tMin)) * 100);

        const primaryIdx = taskScopeToSegIdx(taskPrimaryScope);

        // gating: if no route passes, disable gate for that dimension
        const gatePassPrimaryBest = Math.max(
            ...finalScores.map((r) => min(primaryIdx.map((i) => segValue01(r.segments[i], taskPrimaryCat))))
        );
        const enforcePrimaryGate = taskPrimaryCat !== "None" && gatePassPrimaryBest > taskGateMinFrac + 1e-9

        const gatePassLocalBest = taskLocalEnabled ? Math.max(...finalScores.map((r) => segValue01(r.segments[taskLocalSegment - 1], taskLocalCat))) : 0
        const enforceLocalGate = taskLocalEnabled && taskLocalCat !== "None" && gatePassLocalBest > taskGateMinFrac + 1e-9

        type Cand = { rid: RouteId; score: number; note: string }

        const candidates: Cand[] = []
        for (const rs of finalScores as any) {
            const rid: RouteId = rs.route

            const primaryScores = primaryIdx.map((i: number) => segScore0100(rs.segments[i], taskPrimaryCat))
            const primaryGateVals = primaryIdx.map((i: number) => segValue01(rs.segments[i], taskPrimaryCat))
            const primaryAvg = avg(primaryScores)
            const primaryMin = min(primaryGateVals)

            const secondaryScores = primaryIdx.map((i: number) => segScore0100(rs.segments[i], taskSecondaryCat))
            const secondaryAvg = avg(secondaryScores)

            const localScore = taskLocalEnabled ? segScore0100(rs.segments[taskLocalSegment - 1], taskLocalCat) : 0
            const localGate = taskLocalEnabled ? segValue01(rs.segments[taskLocalSegment - 1], taskLocalCat) : 0

            const passPrimary = (!enforcePrimaryGate) || (primaryMin > taskGateMinFrac + 1e-9)
            const passLocal = (!enforceLocalGate) || (localGate > taskGateMinFrac + 1e-9)

            let utility = 0
            let note = ''

            if (taskMode == "Lexicographic") {
                // סדר: קודם לוקאלי (אם יש), אחר כך ראשי, אחר כך משני, ושובר שוויון לפי זמן
                const lex1 = taskLocalEnabled ? (passLocal ? 1 : 0) : 1
                const lex2 = passPrimary ? 1 : 0
                const tScore = timeScore(rs.totalTimeS)
                // מכפילים כדי לשמור סדר חשיבות
                utility = lex1 * 10_000 + lex2 * 1_000 + localScore * 5 + primaryAvg * 2 + secondaryAvg * 0.5 + tScore * 0.2
                note = "LEX"
            } else {
                const tScore = timeScore(rs.totalTimeS)
                utility = (passLocal ? 1 : 0) * 1_000 + (passPrimary ? 1 : 0) * 100 + taskWPrimary * primaryAvg + taskWSecondary * secondaryAvg + (taskLocalEnabled ? taskWPrimary * localScore : 0) + taskWTime * tScore
                note = "W"
            }

            candidates.push({ rid, score: utility, note })
        }

        // pick best
        candidates.sort((a, b) => b.score - a.score)
        const winner = candidates[0]?.rid ?? favored
        const note = `פייבורט: ${favored} • מצב: ${taskMode} • הזוכה: ${winner}`
        setTaskWinnerRoute(winner)
        setTaskWinnerNote(note)

        // also select it on the map
        setSelectedRoute(winner)
    }, [
        mapRef,
        tripleLinesRef,
        taskPrimaryCat,
        taskPrimaryScope,
        taskSecondaryCat,
        taskLocalEnabled,
        taskLocalCat,
        taskLocalSegment,
        taskDifficulty,
        taskMode,
        taskWPrimary,
        taskWSecondary,
        taskWTime,
        taskGateMinFrac,
        taskFavorRoute,
        setCatTrafficSegs,
        setCatTollSegs,
        setCatTollLabels,
        setCatCommZones,
        setManualParks,
        setRouteScores,
        setShowResults,
        setTaskWinnerRoute,
        setTaskWinnerNote,
        setSelectedRoute,
    ])

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

            setMapStyleTick((t) => t + 1);

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
                    if (isDrawingParkRef.current) return;
                    const feats = map.queryRenderedFeatures(ev.point, { layers: ["triple-badges", "triple-badge-text"] });
                    const f = feats?.[0] as any;
                    const id = (f?.properties?.id as BadgeId | undefined) ?? null;
                    if (!id) return;

                    // Select route when clicking || dragging badge
                    setSelectedRoute(id);
                    selectedRouteRef.current = id;
                    try { applySelectedRouteStyles(map, id); } catch { }
                    try { applySelectedTagStyle(map, id); } catch { }
                    try { bringSelectedRouteAboveOthers(map, id); } catch { }

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
            try { ensureOverlay(map); } catch { }
            try { emphasizeParks(map); } catch { }
            parkLayerIdsRef.current = getParkFillLayerIds(map);
            setMapStyleTick((t) => t + 1);
        });

        map.on("click", (ev) => {
            const ll: LngLat = [ev.lngLat.lng, ev.lngLat.lat];

            // Manual park drawing has priority over other interactions
            if (isDrawingParkRef.current) {
                tryAddParkVertex(ll);
                return;
            }
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

        // Manual park drawing: preview segment to cursor
        map.on("mousemove", (ev) => {
            if (!isDrawingParkRef.current) return;
            draftMouseRef.current = [ev.lngLat.lng, ev.lngLat.lat];
            updateManualParkDraftSources();
        });

        // Manual park drawing: double click closes polygon
        map.on("dblclick", (ev) => {
            if (!isDrawingParkRef.current) return;
            ev.preventDefault();
            try {
                // finish only if valid
                finishParkPolygon();
                updateManualParkDraftSources();
            } catch { }
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
        try { ensureOverlay(map); } catch { }

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

    function updateManualParksSource() {
        const map = mapRef.current;
        if (!map) return;

        const features = manualParksRef.current
            .filter((p) => p.ring.length >= 3)
            .map((p) => ({
                type: "Feature" as const,
                properties: { id: p.id },
                geometry: {
                    type: "Polygon" as const,
                    coordinates: [[...p.ring, p.ring[0]]],
                },
            }));

        setFC(map, "manual-parks", { type: "FeatureCollection", features });
    }

    function updateManualParkDraftSources() {
        const map = mapRef.current;
        if (!map) return;

        const pts = draftParkPtsRef.current;
        setFC(map, "manual-park-draft-points", fcPoints(pts));

        if (pts.length >= 2) {
            setFC(map, "manual-park-draft-line", fcLine(pts));
        } else {
            setFC(map, "manual-park-draft-line", fcLine([]));
        }

        // preview: last point -> mouse
        if (isDrawingParkRef.current && pts.length >= 1 && draftMouseRef.current) {
            setFC(map, "manual-park-preview-line", fcLine([pts[pts.length - 1], draftMouseRef.current]));
        } else {
            setFC(map, "manual-park-preview-line", fcLine([]));
        }
    }

    const removeManualParkById = useCallback((id: string) => {
        setManualParks((prev) => prev.filter((p) => p.id !== id));

        const mk = manualParkMarkersRef.current[id];
        if (mk) {
            try { mk.remove(); } catch { }
            delete manualParkMarkersRef.current[id];
        }
    }, []);

    const clearManualParks = useCallback(() => {
        setManualParks([]);

        // remove markers
        for (const id of Object.keys(manualParkMarkersRef.current)) {
            try { manualParkMarkersRef.current[id].remove(); } catch { }
        }
        manualParkMarkersRef.current = {};

        // stop drawing + clear draft
        setIsDrawingPark(false);
        setDraftParkPts([]);
        draftMouseRef.current = null;

        const map = mapRef.current;
        if (map) {
            setFC(map, "manual-parks", fcPolygons([]));
            setFC(map, "manual-park-draft-line", fcLine([]));
            setFC(map, "manual-park-draft-points", fcPoints([]));
            setFC(map, "manual-park-preview-line", fcLine([]));
        }
    }, []);

    function syncManualParkMarkersVisibility() {
        const show = showManualParks;
        for (const id of Object.keys(manualParkMarkersRef.current)) {
            const el = manualParkMarkersRef.current[id]?.getElement();
            if (el) el.style.display = show ? "block" : "none";
        }
    }

    function addManualParkMarker(park: ManualPark) {
        const map = mapRef.current;
        if (!map) return;

        // remove existing marker with same id
        const existing = manualParkMarkersRef.current[park.id];
        if (existing) {
            try { existing.remove(); } catch { }
            delete manualParkMarkersRef.current[park.id];
        }

        const c = ringCentroid(park.ring);
        const el = document.createElement("button");
        el.type = "button";
        el.textContent = "×";
        el.title = "מחק פארק";
        el.style.width = "22px";
        el.style.height = "22px";
        el.style.borderRadius = "999px";
        el.style.border = "1px solid rgba(255,255,255,0.65)";
        el.style.background = "rgba(10,14,22,0.95)";
        el.style.color = "white";
        el.style.fontSize = "16px";
        el.style.lineHeight = "18px";
        el.style.cursor = "pointer";
        el.style.boxShadow = "0 2px 10px rgba(0,0,0,0.35)";
        el.style.display = showManualParks ? "block" : "none";
        el.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            removeManualParkById(park.id);
        });

        const mk = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat(c as any).addTo(map);
        manualParkMarkersRef.current[park.id] = mk;
    }

    const tryAddParkVertex = useCallback((pt: LngLat) => {
        setDraftParkPts((prev) => {
            // ignore too-close duplicate clicks
            if (prev.length > 0 && haversineMeters(prev[prev.length - 1], pt) < 2) return prev;

            // prevent self-intersection
            if (wouldSelfIntersectOnAdd(prev, pt)) return prev;

            return [...prev, pt];
        });
    }, []);

    const finishParkPolygon = useCallback(() => {
        const pts = draftParkPtsRef.current;

        if (pts.length < 3) return;

        // prevent invalid close (self intersection)
        if (wouldSelfIntersectOnClose(pts)) return;

        const id = `mp-${Date.now()}-${manualParkIdSeqRef.current++}`;
        const park: ManualPark = { id, ring: pts };

        setManualParks((prev) => [...prev, park]);
        addManualParkMarker(park);

        // reset draft + exit draw
        setDraftParkPts([]);
        draftMouseRef.current = null;
        setIsDrawingPark(false);
    }, [addManualParkMarker]);

    const clearTriple = () => {
        clearManualParks();
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

    const clearAllRoutes = () => {
        // keep this resilient: clear what exists, ignore failures
        try { clearSingle(); } catch { }
        try { clearMeasure(); } catch { }
        try { clearTriple(); } catch { }
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

    // ✅ Route selection from RIGHT PANEL (A/B/C)
    // Apply selection immediately on the map (! only via effects), so it always feels responsive.
    const selectRouteFromPanel = useCallback(
        (id: BadgeId) => {
            setSelectedRoute(id);
            selectedRouteRef.current = id;

            const map = mapRef.current;
            if (!map || !map.isStyleLoaded()) return;

            try { applySelectedRouteStyles(map, id); } catch { }
            try { applySelectedTagStyle(map, id); } catch { }
            try { bringSelectedRouteAboveOthers(map, id); } catch { }

            const lines = tripleLinesRef.current;
            const line = id === "A" ? lines.A : id === "B" ? lines.B : lines.C;
            try { renderSegmentsForLine(map, line ?? []); } catch { }
        },
        [renderSegmentsForLine]
    );

    const updateSelectedRouteOnMapForEdit = useCallback(
        (map: maplibregl.Map, route: BadgeId, newLine: LngLat[]) => {
            setFC(map, routeSourceId(route), fcLine(newLine));

            // Update anchor (for connector line)
            const newAnchor = midpointOnLine(newLine);
            const nextAnchors = anchorsRef.current.map((a) => (a.id === route ? { ...a, coord: newAnchor } : a));
            setAnchors(nextAnchors);

            // Rebuild connector lines using current badge positions
            const curBadges = badgesRef.current;
            if (nextAnchors.length && curBadges.length) {
                setFC(map, "triple-badge-lines", buildConnectorFC(map, nextAnchors, curBadges));
            }

            // Ensure selected route stays on top
            bringSelectedRouteAboveOthers(map, route);
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

        // redraw junctions && segments
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

    // build junction markers when entering edit mode (|| when route selection changes)
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        let cancelled = false;

        const run = () => {
            if (cancelled) return;
            try { ensureOverlay(map); } catch { }

            if (!isEditMode) {
                // hide markers when ! editing
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
        };

        if (!map.isStyleLoaded()) {
            const onReady = () => run();
            try { map.once("idle", onReady); } catch { }
            try { map.once("load", onReady); } catch { }
            return () => {
                cancelled = true;
                try { map.off("idle", onReady); } catch { }
                try { map.off("load", onReady); } catch { }
            };
        }

        run();
        return () => { cancelled = true; };
    }, [isEditMode, selectedRoute, calcNonce, mapStyleTick]);

    // ---------- End route edit mode ----------

    // ---- Export participant screen handlers ----
    const chooseExportFolder = useCallback(async () => {
        const picker = (window as any).showDirectoryPicker as undefined | ((opts?: any) => Promise<any>);
        if (!picker) {
            alert("בחירת תיקייה לשמירה אינה נתמכת בדפדפן זה. הקובץ יירד כהורדה רגילה (Downloads).");
            setExportSaveMode("downloads");
            setExportDirHandle(null);
            setExportSavePath("Downloads");
            return;
        }
        try {
            const handle = await picker({ mode: "readwrite" });
            if (handle) {
                setExportDirHandle(handle);
                setExportSaveMode("directory");
                setExportSavePath(String(handle.name || "Selected folder"));
            }
        } catch {
            // canceled
        }
    }, []);

    const resetExportSavePath = useCallback(() => {
        setExportSaveMode("downloads");
        setExportDirHandle(null);
        setExportSavePath("Downloads");
    }, []);

    const downloadHtml = useCallback((html: string, fileName: string) => {
        const blob = new Blob([html], { type: "text/html;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }, []);

    const exportParticipantHtml = useCallback(async () => {
        const map = mapRef.current;
        if (!map) {
            alert("המפה עדיין לא מוכנה.");
            return;
        }

        // Capture an offline base-map snapshot (streets only) for the exported HTML.
        const EXPORT_HIDE_LAYERS: string[] = [
            // routes + tags + segments
            'triple-a', 'triple-b', 'triple-c', 'triple-a-outline', 'triple-b-outline', 'triple-c-outline',
            'triple-badge-lines', 'triple-badges', 'triple-badge-text',
            'triple-seg-ticks', 'triple-seg-circles', 'triple-seg-text',

            // categories
            'cat-traffic', 'cat-traffic-glow',
            'cat-toll', 'cat-toll-label-bg', 'cat-toll-label-text',
            'cat-comm-fill', 'cat-comm-outline',
            'manual-parks-fill', 'manual-parks-outline',

            // start/end
            'start-circle', 'end-pin', 'start-label-bg', 'end-label-bg', 'start-label', 'end-label',
        ];

        const prevVis = new Map<string, any>();
        for (const id of EXPORT_HIDE_LAYERS) {
            try {
                if (map.getLayer(id)) prevVis.set(id, map.getLayoutProperty(id, 'visibility'));
            } catch { }
        }
        for (const id of EXPORT_HIDE_LAYERS) {
            try {
                if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
            } catch { }
        }

        // wait for render to settle
        await new Promise<void>((res) => {
            try {
                map.once('idle', () => res());
                map.triggerRepaint();
            } catch {
                res();
            }
        });

        let baseMapDataUrl = '';
        try {
            baseMapDataUrl = map.getCanvas().toDataURL('image/png');
        } catch {
            // if export fails due to browser limitations, still continue with an empty background
            baseMapDataUrl = '';
        }
        if (baseMapDataUrl && baseMapDataUrl.length < 2000) baseMapDataUrl = "";

        // restore visibility
        for (const id of EXPORT_HIDE_LAYERS) {
            try {
                if (map.getLayer(id)) {
                    const v = prevVis.has(id) ? prevVis.get(id) : 'visible';
                    map.setLayoutProperty(id, 'visibility', v ?? 'visible');
                }
            } catch { }
        }

        let canvas = map.getCanvas();
        let viewW = canvas.width;
        let viewH = canvas.height;

        // Fallback: if capture failed, render an offscreen base map && capture it (export-time only; participant HTML stays offline)
        if (!baseMapDataUrl) {
            try {
                const off = document.createElement("div");
                off.style.position = "fixed";
                off.style.left = "-10000px";
                off.style.top = "0";
                off.style.width = map.getContainer().clientWidth + "px";
                off.style.height = map.getContainer().clientHeight + "px";
                off.style.opacity = "0";
                off.style.pointerEvents = "none";
                document.body.appendChild(off);

                const offMap = new maplibregl.Map({
                    container: off,
                    style: STYLE_URL,
                    center: map.getCenter(),
                    zoom: map.getZoom(),
                    bearing: 0,
                    pitch: 0,
                    interactive: false,
                    attributionControl: false,
                    preserveDrawingBuffer: true,
                } as any);

                await new Promise<void>((res) => {
                    let done = false;
                    const finish = () => { if (done) return; done = true; res(); };
                    try { offMap.once("idle", finish); } catch { }
                    try { offMap.once("load", () => setTimeout(finish, 250)); } catch { }
                    setTimeout(finish, 4000);
                });

                try {
                    baseMapDataUrl = offMap.getCanvas().toDataURL("image/png");
                    canvas = offMap.getCanvas();
                    viewW = canvas.width;
                    viewH = canvas.height;
                } catch {
                    // ignore
                }

                try { offMap.remove(); } catch { }
                try { off.remove(); } catch { }
            } catch {
                // ignore
            }
        }
        const c = map.getCenter();
        const mapView = {
            center: [c.lng, c.lat] as LngLat,
            zoom: map.getZoom(),
            bearing: 0,
            pitch: 0,
            width: viewW,
            height: viewH,
        };

        const getLine = (rid: "A" | "B" | "C") => {
            const l = (tripleLinesRef.current as any)?.[rid] as LngLat[] | undefined;
            return Array.isArray(l) ? l : [];
        };

        const routes = {
            A: getLine("A"),
            B: getLine("B"),
            C: getLine("C"),
        } as const;

        const html = buildParticipantHtml({
            scenarioName: exportScenarioName,
            taskText: exportTaskText,
            recommendedRoute: exportRecommendedRoute,
            vizType: exportVizType,
            baseMapDataUrl,
            mapView,
            start,
            end,
            routes,
            manualParks: manualParksRef.current || [],
            catTrafficSegs,
            catTollSegs,
            catTollLabels,
            catCommZones,
            routeScores,
        });

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const fileName = `${safeFileName(exportScenarioName)}_${stamp}.html`;

        // Save via directory picker (preferred) || fallback to Downloads.
        try {
            if (exportSaveMode === "directory" && exportDirHandle) {
                const fileHandle = await exportDirHandle.getFileHandle(fileName, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(html);
                await writable.close();

                const where = `${exportSavePath}/${fileName}`;
                setExportLastSaved(where);
                alert(`הקובץ נשמר בתיקייה שנבחרה: ${where}`);
                return;
            }
        } catch {
            // fall back to download
        }

        downloadHtml(html, fileName);
        const where = `Downloads/${fileName}`;
        setExportLastSaved(where);
        alert(`הקובץ ירד כהורדה רגילה: ${where}`);
    }, [
        catCommZones,
        catTollLabels,
        catTollSegs,
        catTrafficSegs,
        downloadHtml,
        end,
        exportDirHandle,
        exportRecommendedRoute,
        exportSaveMode,
        exportSavePath,
        exportScenarioName,
        exportTaskText,
        exportVizType,
        routeScores,
        start,
    ]);

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
                            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                <button
                                    onClick={exportResultsToCsv}
                                    disabled={!routeScores || routeScores.length === 0}
                                    title={
                                        !routeScores || routeScores.length === 0
                                            ? "אין נתונים לייצוא"
                                            : "ייצוא טבלת התוצאות לקובץ CSV"
                                    }
                                    style={{
                                        padding: "6px 10px",
                                        borderRadius: 8,
                                        border: "1px solid rgba(255,255,255,0.15)",
                                        background:
                                            !routeScores || routeScores.length === 0
                                                ? "rgba(255,255,255,0.03)"
                                                : "rgba(255,255,255,0.10)",
                                        color: "white",
                                        cursor:
                                            !routeScores || routeScores.length === 0 ? "not-allowed" : "pointer",
                                        opacity: !routeScores || routeScores.length === 0 ? 0.55 : 1,
                                    }}
                                >
                                    ייצא CSV
                                </button>
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

                {/* Map data row */}
                <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                    <div style={{ fontWeight: 900, marginBottom: 10 }}>נתוני מפה</div>
                    <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 800, marginBottom: 6 }}>שפה במפה</div>
                            <select
                                value={lang}
                                onChange={(e) => setLang(e.target.value as Lang)}
                                style={{
                                    width: "100%",
                                    padding: "10px 12px",
                                    borderRadius: 10,
                                    border: "1px solid rgba(255,255,255,0.15)",
                                    background: "rgba(255,255,255,0.06)",
                                    color: "#e8eefc",
                                    fontWeight: 800,
                                    outline: "none",
                                    direction: "rtl",
                                }}
                            >
                                <option value="he">עברית</option>
                                <option value="en">English</option>
                            </select>
                        </div>

                        <button
                            onClick={() => setShowLayerManager(true)}
                            style={{
                                padding: "10px 12px",
                                borderRadius: 10,
                                border: "1px solid rgba(255,255,255,0.15)",
                                background: "rgba(255,255,255,0.06)",
                                color: "#e8eefc",
                                cursor: "pointer",
                                fontWeight: 900,
                                whiteSpace: "nowrap",
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                            }}
                            title={layerFilterActive ? "יש שכבות/קטגוריות מוסתרות" : "כל השכבות מוצגות"}
                        >
                            ניהול שכבות
                            {layerFilterActive && <span style={{ width: 10, height: 10, borderRadius: 999, background: "#F59E0B", display: "inline-block" }} />}
                        </button>
                    </div>

                    <div style={{ fontSize: 12, opacity: 0.75, marginTop: 8, lineHeight: 1.35 }}>
                        טיפ: שכבות בסיס וקטגוריות מרחביות ניתנות לניהול מתוך החלון.
                    </div>
                </div>

                {/* Layer manager modal */}
                {showLayerManager && (
                    <div
                        style={{
                            position: "fixed",
                            inset: 0,
                            background: "rgba(0,0,0,0.55)",
                            zIndex: 9999,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            padding: 16,
                            fontFamily: "Arial, sans-serif",
                            direction: "rtl",
                        }}
                        onMouseDown={() => setShowLayerManager(false)}
                    >
                        <div
                            style={{
                                width: 520,
                                maxWidth: "100%",
                                maxHeight: "90vh",
                                overflow: "auto",
                                background: "#0b0f17",
                                border: "1px solid rgba(255,255,255,0.15)",
                                borderRadius: 14,
                                boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
                                padding: 14,
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                        >
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
                                <div style={{ fontWeight: 900, fontSize: 16 }}>ניהול שכבות</div>
                                <button
                                    onClick={() => setShowLayerManager(false)}
                                    style={{
                                        border: "1px solid rgba(255,255,255,0.15)",
                                        background: "rgba(255,255,255,0.06)",
                                        color: "#e8eefc",
                                        borderRadius: 10,
                                        padding: "8px 10px",
                                        cursor: "pointer",
                                        fontWeight: 900,
                                    }}
                                    title="סגור"
                                >
                                    ✕
                                </button>
                            </div>

                            <div style={{ fontWeight: 900, marginBottom: 8 }}>שכבות בסיס</div>
                            <div style={{ display: "grid", gap: 8 }}>
                                {[
                                    { key: "roads", label: "כבישים", v: showRoads, set: setShowRoads },
                                    { key: "transit", label: "תחבורה", v: showTransit, set: setShowTransit },
                                    { key: "labels", label: "תוויות", v: showLabels, set: setShowLabels },
                                    { key: "poi", label: "נקודות עניין", v: showPOI, set: setShowPOI },
                                ].map((it) => (
                                    <label key={it.key} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                                        <input type="checkbox" checked={it.v} onChange={(e) => it.set(e.target.checked)} />
                                        <span style={{ fontWeight: 800 }}>{it.label}</span>
                                    </label>
                                ))}
                            </div>

                            <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.12)" }}>
                                <div style={{ fontWeight: 900, marginBottom: 8 }}>קטגוריות מרחביות</div>
                                <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>
                                    הצגה/הסתרה של שכבות קטגוריות (זמין אחרי חישוב 3 מסלולים).
                                </div>

                                <div style={{ display: "grid", gap: 8 }}>
                                    {[
                                        { key: "traffic", label: "עומס תנועה", v: showCatTraffic, set: setShowCatTraffic, disabled: !tripleComputed },
                                        { key: "toll", label: "כבישי אגרה", v: showCatToll, set: setShowCatToll, disabled: !tripleComputed },
                                        { key: "comm", label: "תקשורת טובה", v: showCatComm, set: setShowCatComm, disabled: !tripleComputed },
                                        { key: "baseParks", label: "פארקים במפה", v: showBaseParks, set: setShowBaseParks, disabled: false },
                                        { key: "manualParks", label: "פארקים ידניים", v: showManualParks, set: setShowManualParks, disabled: false },
                                    ].map((it) => (
                                        <label
                                            key={it.key}
                                            style={{ display: "flex", alignItems: "center", gap: 8, cursor: it.disabled ? "not-allowed" : "pointer", opacity: it.disabled ? 0.6 : 1 }}
                                        >
                                            <input type="checkbox" checked={it.v} disabled={it.disabled} onChange={(e) => it.set(e.target.checked)} />
                                            <span style={{ fontWeight: 800 }}>{it.label}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                )}

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
                                title={isTriple ? "לחץ כדי להפעיל/לבטל בחירת מוצא/יעד" : "בחר מצב"}
                            >
                                {b.label}
                            </button>
                        );
                    })}
                </div>

                {/* TRIPLE flow */}
                {mode === "TRIPLE" && (
                    <>
                        <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                            <div style={{ fontWeight: 900, marginBottom: 6 }}>שלב 1: בחירת מוצא ויעד</div>
                            <div style={{ fontSize: 13, opacity: 0.86, lineHeight: 1.45 }}>
                                לחץ על <b>3 מסלולים</b> כדי להפעיל בחירה (הכפתור מודגש). קליק ראשון במפה = <b>מוצא</b>, קליק שני = <b>יעד</b>.
                                לאחר בחירת יעד הבחירה ננעלת כדי למנוע קליקים בטעות.
                            </div>
                        </div>

                        <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                            <div style={{ fontWeight: 900, marginBottom: 6 }}>שלב 2: פרמטרים וחישוב</div>

                            <div style={{ fontWeight: 800, marginBottom: 8 }}>שונות</div>
                            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                                <input
                                    type="range"
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    value={diversity}
                                    onChange={(e) => setDiversity(parseFloat(e.target.value))}
                                    style={{ flex: 1 }}
                                />
                                <input
                                    type="number"
                                    min={0}
                                    max={100}
                                    value={Math.round(diversity * 100)}
                                    onChange={(e) => {
                                        const v = Math.max(0, Math.min(100, Number(e.target.value || 0)));
                                        setDiversity(v / 100);
                                    }}
                                    style={{
                                        width: 80,
                                        padding: "8px 10px",
                                        borderRadius: 10,
                                        border: "1px solid rgba(255,255,255,0.15)",
                                        background: "rgba(255,255,255,0.06)",
                                        color: "#e8eefc",
                                        fontWeight: 900,
                                        direction: "ltr",
                                    }}
                                    title="אחוז שונות"
                                />
                            </div>

                            <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                                <button
                                    onClick={() => setCalcNonce((n) => n + 1)}
                                    disabled={!canTriple || isRoutingTriple}
                                    style={{
                                        flex: 1,
                                        padding: "10px 12px",
                                        borderRadius: 12,
                                        border: "1px solid rgba(255,255,255,0.15)",
                                        background: !canTriple ? "rgba(255,255,255,0.06)" : "rgba(140,203,255,0.22)",
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
                                    onClick={clearAllRoutes}
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
                                    title="נקה את כל המסלולים/מדידה"
                                >
                                    ניקוי
                                </button>
                            </div>

                            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 10, lineHeight: 1.35 }}>
                                אחרי חישוב אפשר <b>לגרור</b> דגלונים (A/B/C) ולראות עדכונים.
                            </div>
                        </div>

                        <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                            <div style={{ fontWeight: 900, marginBottom: 6 }}>שלב 3: בחירת מסלול</div>
                            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>חלוקת מקטעים (1/2/3 + טיקים) מוצגת רק למסלול שנבחר.</div>

                            <div style={{ fontWeight: 800, marginBottom: 8 }}>מסלול נבחר</div>
                            <div style={{ display: "flex", gap: 10, marginBottom: 4 }}>
                                {[
                                    { id: "A" as const, label: "א" },
                                    { id: "B" as const, label: "ב" },
                                    { id: "C" as const, label: "ג" },
                                ].map((r) => (
                                    <button
                                        key={r.id}
                                        onClick={() => selectRouteFromPanel(r.id)}
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
                        </div>

                        <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                            <div style={{ fontWeight: 900, marginBottom: 6 }}>שלב 4: עריכת מסלולים</div>

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
                                    title="מצב עריכה: לחץ על עיגולים במסלול כדי למחוק/להחזיר צמתים"
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

                                    <div style={{ display: "flex", gap: 10, marginBottom: 2 }}>
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
                        </div>

                        <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                            <div style={{ fontWeight: 900, marginBottom: 8 }}>שלב 5: הגדרת מטלה + פריסת ישויות אוטומטית</div>

                            <div style={{ fontSize: 13, opacity: 0.92, lineHeight: 1.45 }}>
                                כאן אתה מגדיר את המטלה לנבדק (גלובלית/לוקאלית). בלחיצה על <b>"החל"</b>, המערכת תפרוס ישויות מרחביות על המפה
                                (בועות קליטה/פארקים/אגרות) ותאזן את זמני המסלולים ע"י הוספת עומסים – כדי לייצר דילמה ריאליסטית.
                            </div>

                            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10, marginTop: 10 }}>
                                <div>
                                    <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>קריטריון ראשי</div>
                                    <select
                                        value={taskPrimaryCat}
                                        onChange={(e) => setTaskPrimaryCat(e.target.value as any)}
                                        style={{ width: "100%", padding: 8, borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.25)", color: "white" }}
                                    >
                                        {TASK_CAT_OPTIONS.map((c) => (
                                            <option key={c} value={c}>
                                                {c}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <div>
                                    <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>תחום הקריטריון הראשי</div>
                                    <select
                                        value={taskPrimaryScope}
                                        onChange={(e) => setTaskPrimaryScope(e.target.value as any)}
                                        style={{ width: "100%", padding: 8, borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.25)", color: "white" }}
                                    >
                                        {TASK_SCOPE_OPTIONS.map((sc) => (
                                            <option key={sc} value={sc}>
                                                {sc}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <div>
                                    <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>קריטריון משני (אופציונלי)</div>
                                    <select
                                        value={taskSecondaryCat}
                                        onChange={(e) => setTaskSecondaryCat(e.target.value as any)}
                                        style={{ width: "100%", padding: 8, borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.25)", color: "white" }}
                                    >
                                        <option value="None">None</option>
                                        {TASK_CAT_OPTIONS.map((c) => (
                                            <option key={c} value={c}>
                                                {c}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <div>
                                    <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>שובר שוויון</div>
                                    <select
                                        value={taskTieBreaker}
                                        onChange={(e) => setTaskTieBreaker(e.target.value as any)}
                                        style={{ width: "100%", padding: 8, borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.25)", color: "white" }}
                                    >
                                        <option value="זמן">זמן קצר יותר</option>
                                        <option value="מהירות">מהירות (ציון)</option>
                                    </select>
                                </div>
                            </div>

                            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10, marginTop: 10 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <input type="checkbox" checked={taskLocalEnabled} onChange={(e) => setTaskLocalEnabled(e.target.checked)} />
                                    <div style={{ fontSize: 13 }}>הוסף דרישה לוקאלית (מקטע ספציפי)</div>
                                </div>

                                <div />

                                <div style={{ opacity: taskLocalEnabled ? 1 : 0.5 }}>
                                    <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>קריטריון לוקאלי</div>
                                    <select
                                        disabled={!taskLocalEnabled}
                                        value={taskLocalCat}
                                        onChange={(e) => setTaskLocalCat(e.target.value as any)}
                                        style={{ width: "100%", padding: 8, borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.25)", color: "white" }}
                                    >
                                        {TASK_CAT_OPTIONS.map((c) => (
                                            <option key={c} value={c}>
                                                {c}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <div style={{ opacity: taskLocalEnabled ? 1 : 0.5 }}>
                                    <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>מקטע לוקאלי</div>
                                    <select
                                        disabled={!taskLocalEnabled}
                                        value={taskLocalSegment}
                                        onChange={(e) => setTaskLocalSegment(parseInt(e.target.value, 10) as any)}
                                        style={{ width: "100%", padding: 8, borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.25)", color: "white" }}
                                    >
                                        <option value={1}>מקטע 1</option>
                                        <option value={2}>מקטע 2</option>
                                        <option value={3}>מקטע 3</option>
                                    </select>
                                </div>
                            </div>

                            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10, marginTop: 10 }}>
                                <div>
                                    <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>Desired discriminability</div>
                                    <select
                                        value={taskDifficulty}
                                        onChange={(e) => setTaskDifficulty(e.target.value as any)}
                                        style={{ width: "100%", padding: 8, borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.25)", color: "white" }}
                                    >
                                        {TASK_DIFFICULTY_OPTIONS.map((d) => (
                                            <option key={d} value={d}>
                                                {d}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <div>
                                    <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>Scoring mode</div>
                                    <select
                                        value={taskMode}
                                        onChange={(e) => setTaskMode(e.target.value as any)}
                                        style={{ width: "100%", padding: 8, borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.25)", color: "white" }}
                                    >
                                        {TASK_MODE_OPTIONS.map((m) => (
                                            <option key={m} value={m}>
                                                {m}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 10, alignItems: "end" }}>
                                <div>
                                    <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>משקל ראשי</div>
                                    <input
                                        type="number"
                                        value={taskWPrimary}
                                        onChange={(e) => setTaskWPrimary(parseFloat(e.target.value || "0"))}
                                        style={{ width: "100%", padding: 8, borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.25)", color: "white" }}
                                    />
                                </div>
                                <div>
                                    <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>משקל משני</div>
                                    <input
                                        type="number"
                                        value={taskWSecondary}
                                        onChange={(e) => setTaskWSecondary(parseFloat(e.target.value || "0"))}
                                        style={{ width: "100%", padding: 8, borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.25)", color: "white" }}
                                    />
                                </div>
                                <div>
                                    <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>משקל זמן</div>
                                    <input
                                        type="number"
                                        value={taskWTime}
                                        onChange={(e) => setTaskWTime(parseFloat(e.target.value || "0"))}
                                        style={{ width: "100%", padding: 8, borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.25)", color: "white" }}
                                    />
                                </div>
                            </div>

                            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10, marginTop: 10 }}>
                                <div>
                                    <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>Gate threshold (0..1)</div>
                                    <input
                                        type="number"
                                        step={0.01}
                                        min={0}
                                        max={1}
                                        value={taskGateMinFrac}
                                        onChange={(e) => setTaskGateMinFrac(parseFloat(e.target.value || "0"))}
                                        style={{ width: "100%", padding: 8, borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.25)", color: "white" }}
                                    />
                                </div>
                                <div>
                                    <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>מסלול מועדף (אופציונלי)</div>
                                    <select
                                        value={taskFavorRoute}
                                        onChange={(e) => setTaskFavorRoute(e.target.value as any)}
                                        style={{ width: "100%", padding: 8, borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.25)", color: "white" }}
                                    >
                                        <option value="Auto">Auto</option>
                                        <option value="A">A</option>
                                        <option value="B">B</option>
                                        <option value="C">C</option>
                                    </select>
                                </div>
                            </div>

                            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
                                <button
                                    onClick={() => applyTaskScenario()}
                                    style={{
                                        padding: "10px 12px",
                                        borderRadius: 12,
                                        border: "1px solid rgba(255,255,255,0.18)",
                                        background: "rgba(17, 134, 255, 0.35)",
                                        color: "white",
                                        fontWeight: 900,
                                        cursor: "pointer",
                                    }}
                                >
                                    החל מטלה והפק ישויות
                                </button>

                                <div style={{ fontSize: 13, opacity: 0.92 }}>
                                    {taskWinnerRoute ? (
                                        <>
                                            מסלול מומלץ: <b>{taskWinnerRoute}</b>
                                            <span style={{ opacity: 0.75 }}> • {taskWinnerNote}</span>
                                        </>
                                    ) : (
                                        <span style={{ opacity: 0.7 }}>בחר הגדרות ולחץ "החל" כדי לייצר תרחיש.</span>
                                    )}
                                </div>
                            </div>
                        </div>
                        <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                                <div>
                                    <div style={{ fontWeight: 900, marginBottom: 4 }}>שלב 6: קטגוריות מרחביות</div>
                                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                                        נוצרו: <b>{catTrafficSegs.length}</b> עומס, <b>{catTollSegs.length}</b> אגרה, <b>{catCommZones.length}</b> תקשורת · פארקים ידניים: <b>{manualParks.length}</b>
                                    </div>
                                </div>

                                <button
                                    onClick={() => {
                                        if (!tripleComputed) return;
                                        setShowCatSettings((s) => !s);
                                    }}
                                    disabled={!tripleComputed}
                                    style={{
                                        padding: "10px 12px",
                                        borderRadius: 12,
                                        border: "1px solid rgba(255,255,255,0.15)",
                                        background: tripleComputed ? "rgba(140,203,255,0.18)" : "rgba(255,255,255,0.06)",
                                        color: "#e8eefc",
                                        cursor: tripleComputed ? "pointer" : "not-allowed",
                                        fontWeight: 900,
                                        whiteSpace: "nowrap",
                                    }}
                                    title={!tripleComputed ? "קודם חישוב 3 מסלולים" : "פתח חלון הגדרות קטגוריות"}
                                >
                                    {showCatSettings ? "סגור" : "הגדר ישויות"}
                                </button>
                            </div>
                        </div>

                        <div>
                            <div style={{ fontWeight: 900, marginBottom: 8 }}>שלב 7: תוצאות וויזואליזציות</div>
                            <div style={{ display: "flex", gap: 10 }}>
                                <button
                                    onClick={() => {
                                        const next = !showResults;

                                        // אם פותחים ואין עדיין ציונים – נחשב על בסיס ה־state הנוכחי
                                        if (next && routeScores.length == 0) {
                                            const mapNow = mapRef.current;
                                            if (mapNow) {
                                                const scores = computeRouteScores(
                                                    mapNow,
                                                    tripleLinesRef.current,
                                                    catTrafficSegs,
                                                    catTollSegs,
                                                    catCommZones,
                                                    manualParksRef.current
                                                );
                                                setRouteScores(scores);
                                            }
                                        }

                                        setShowResults(next);
                                    }}
                                    disabled={!tripleComputed}
                                    style={{
                                        flex: 1,
                                        padding: "10px 12px",
                                        borderRadius: 12,
                                        border: "1px solid rgba(255,255,255,0.15)",
                                        background: showResults ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.06)",
                                        color: "#e8eefc",
                                        cursor: tripleComputed ? "pointer" : "not-allowed",
                                        fontWeight: 900,
                                    }}
                                >
                                    {showResults ? "הסתר תוצאות" : "הצג תוצאות"}
                                </button>

                                <button
                                    onClick={() => setShowVisualizations(true)}
                                    disabled={!routeScores.length}
                                    style={{
                                        flex: 1,
                                        padding: "10px 12px",
                                        borderRadius: 12,
                                        border: "1px solid rgba(255,255,255,0.15)",
                                        background: routeScores.length ? "rgba(140,203,255,0.18)" : "rgba(255,255,255,0.06)",
                                        color: "#e8eefc",
                                        cursor: routeScores.length ? "pointer" : "not-allowed",
                                        fontWeight: 900,
                                    }}
                                    title={!routeScores.length ? "קודם 'הצג תוצאות' כדי ליצור נתוני ויזואליזציה" : "פתח חלון ויזואליזציות"}
                                >
                                    ויזואליזציות
                                </button>
                            </div>
                        </div>

                        {/* Spatial categories settings modal (TRIPLE) */}
                        {showCatSettings && (
                            <div
                                style={{
                                    position: "fixed",
                                    inset: 0,
                                    background: "rgba(0,0,0,0.55)",
                                    zIndex: 10000,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    padding: 16,
                                    fontFamily: "Arial, sans-serif",
                                    direction: "rtl",
                                }}
                                onMouseDown={() => setShowCatSettings(false)}
                            >
                                <div
                                    style={{
                                        width: 720,
                                        maxWidth: "100%",
                                        maxHeight: "90vh",
                                        overflow: "auto",
                                        background: "#0b0f17",
                                        border: "1px solid rgba(255,255,255,0.15)",
                                        borderRadius: 14,
                                        boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
                                        padding: 14,
                                    }}
                                    onMouseDown={(e) => e.stopPropagation()}
                                >
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
                                        <div style={{ fontWeight: 900, fontSize: 16 }}>הגדרת קטגוריות מרחביות</div>
                                        <button
                                            onClick={() => setShowCatSettings(false)}
                                            style={{
                                                border: "1px solid rgba(255,255,255,0.15)",
                                                background: "rgba(255,255,255,0.06)",
                                                color: "#e8eefc",
                                                borderRadius: 10,
                                                padding: "8px 10px",
                                                cursor: "pointer",
                                                fontWeight: 900,
                                            }}
                                            title="סגור"
                                        >
                                            ✕
                                        </button>
                                    </div>

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

                                    {/* Manual parks controls */}
                                    <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.12)" }}>
                                        <div style={{ fontWeight: 800, marginBottom: 8, textAlign: "right" }}>פארקים ידניים</div>

                                        <button
                                            onClick={() => {
                                                const next = !isDrawingPark;
                                                setIsDrawingPark(next);
                                                if (next) {
                                                    setDraftParkPts([]);
                                                    draftMouseRef.current = null;
                                                } else {
                                                    setDraftParkPts([]);
                                                    draftMouseRef.current = null;
                                                }
                                            }}
                                            disabled={!tripleComputed}
                                            style={{
                                                width: "100%",
                                                padding: "10px 12px",
                                                marginTop: 6,
                                                borderRadius: 10,
                                                border: "1px solid rgba(255,255,255,0.15)",
                                                background: isDrawingPark ? "rgba(46,204,113,0.25)" : "rgba(255,255,255,0.06)",
                                                color: "#e8eefc",
                                                cursor: tripleComputed ? "pointer" : "not-allowed",
                                                textAlign: "right",
                                                fontWeight: 900,
                                            }}
                                            title={!tripleComputed ? "יש לחשב מסלולים לפני יצירת פארקים ידניים" : isDrawingPark ? "מצב ציור פעיל (דאבל קליק לסגירה, ESC לביטול)" : "הוסף פוליגון פארק ידני"}
                                        >
                                            {isDrawingPark ? "סיים ציור" : "הוסף פארק"}
                                        </button>

                                        <button
                                            onClick={() => clearManualParks()}
                                            disabled={manualParks.length === 0 && draftParkPts.length === 0}
                                            style={{
                                                width: "100%",
                                                padding: "10px 12px",
                                                marginTop: 8,
                                                borderRadius: 10,
                                                border: "1px solid rgba(255,255,255,0.15)",
                                                background: "rgba(255,255,255,0.06)",
                                                color: "#e8eefc",
                                                cursor: manualParks.length === 0 && draftParkPts.length === 0 ? "not-allowed" : "pointer",
                                                textAlign: "right",
                                                fontWeight: 900,
                                            }}
                                        >
                                            נקה פארקים ידניים
                                        </button>

                                        {isDrawingPark && (
                                            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85, textAlign: "right", lineHeight: 1.5 }}>
                                                קליק: הוסף נקודה · דאבל־קליק: סגור פוליגון · Delete: חזור צעד · ESC: ביטול
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}
                    </>
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

                {/* Export participant screen */}
                <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>ייצוא מסך לנבדק</div>
                    <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 10, lineHeight: 1.45 }}>
                        יצירת קובץ <b>HTML</b> עצמאי להצגת התרחיש לנבדק (מפה + בחירת מסלול + פירוט מקטעים).
                    </div>

                    <button
                        onClick={() => setExportOpen(true)}
                        style={{
                            width: "100%",
                            padding: "10px 12px",
                            borderRadius: 12,
                            border: "1px solid rgba(255,255,255,0.15)",
                            background: "rgba(140,203,255,0.18)",
                            color: "#e8eefc",
                            cursor: "pointer",
                            fontWeight: 900,
                            textAlign: "right",
                        }}
                    >
                        פתיחת חלון ייצוא
                    </button>

                    {exportLastSaved && (
                        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8, lineHeight: 1.4 }}>
                            נשמר לאחרונה: <b>{exportLastSaved}</b>
                        </div>
                    )}
                </div>

                {exportOpen && (
                    <div
                        style={{
                            position: "fixed",
                            inset: 0,
                            background: "rgba(0,0,0,0.55)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            zIndex: 9999,
                            fontFamily: "Arial, sans-serif",
                        }}
                        onMouseDown={() => setExportOpen(false)}
                    >
                        <div
                            style={{
                                width: 720,
                                maxWidth: "92vw",
                                maxHeight: "92vh",
                                overflowY: "auto",
                                overflowX: "hidden",
                                background: "#0b0f17",
                                border: "1px solid rgba(255,255,255,0.14)",
                                borderRadius: 16,
                                padding: 14,
                                direction: "rtl",
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                        >
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
                                <div style={{ fontWeight: 900, fontSize: 16 }}>ייצוא מסך לנבדק</div>
                                <button
                                    onClick={() => setExportOpen(false)}
                                    style={{
                                        padding: "8px 10px",
                                        borderRadius: 10,
                                        border: "1px solid rgba(255,255,255,0.15)",
                                        background: "rgba(255,255,255,0.06)",
                                        color: "#e8eefc",
                                        cursor: "pointer",
                                        fontWeight: 900,
                                    }}
                                >
                                    סגור
                                </button>
                            </div>

                            <div style={{ display: "grid", gap: 12 }}>
                                <div>
                                    <div style={{ fontWeight: 800, marginBottom: 6 }}>שם תרחיש</div>
                                    <input
                                        maxLength={120}
                                        value={exportScenarioName}
                                        onChange={(e) => setExportScenarioName(e.target.value)}
                                        style={{
                                            width: "100%",
                                            padding: "10px 12px",
                                            borderRadius: 10,
                                            border: "1px solid rgba(255,255,255,0.15)",
                                            background: "rgba(0,0,0,0.25)",
                                            color: "#e8eefc",
                                            outline: "none",
                                            fontFamily: "Arial, sans-serif",
                                            textOverflow: "ellipsis",
                                            overflow: "hidden",
                                            whiteSpace: "nowrap",
                                        }}
                                    />
                                </div>

                                <div>
                                    <div style={{ fontWeight: 800, marginBottom: 6 }}>טקסט מטלה</div>
                                    <textarea
                                        maxLength={1200}
                                        value={exportTaskText}
                                        onChange={(e) => setExportTaskText(e.target.value)}
                                        rows={4}
                                        style={{
                                            width: "100%",
                                            padding: "10px 12px",
                                            borderRadius: 10,
                                            border: "1px solid rgba(255,255,255,0.15)",
                                            background: "rgba(0,0,0,0.25)",
                                            color: "#e8eefc",
                                            outline: "none",
                                            resize: "vertical",
                                            fontFamily: "Arial, sans-serif",
                                            lineHeight: 1.4,
                                        }}
                                    />
                                </div>

                                <div>
                                    <div style={{ fontWeight: 800, marginBottom: 6 }}>דרישות</div>
                                    <div
                                        style={{
                                            padding: "10px 12px",
                                            borderRadius: 10,
                                            border: "1px dashed rgba(255,255,255,0.22)",
                                            background: "rgba(255,255,255,0.04)",
                                            color: "rgba(232,238,252,0.85)",
                                            fontFamily: "Arial, sans-serif",
                                            lineHeight: 1.4,
                                        }}
                                    >
                                        טקסט ממלא מקום – הדרישות יוגדרו בהמשך.
                                    </div>
                                </div>

                                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                                    <div style={{ flex: 1, minWidth: 220 }}>
                                        <div style={{ fontWeight: 800, marginBottom: 6 }}>תנאי ויזואליזציה</div>
                                        <select
                                            value={exportVizType}
                                            onChange={(e) => setExportVizType(e.target.value as ExportVizType)}
                                            style={{
                                                width: "100%",
                                                padding: "10px 12px",
                                                borderRadius: 10,
                                                border: "1px solid rgba(255,255,255,0.15)",
                                                background: "rgba(0,0,0,0.25)",
                                                color: "#e8eefc",
                                                outline: "none",
                                                fontFamily: "Arial, sans-serif",
                                            }}
                                        >
                                            <option value="STACKED">גרף בר נערם</option>
                                            <option value="RADAR">גרף רדאר</option>
                                            <option value="HEATMAP">טבלת מפת חום</option>
                                        </select>
                                    </div>

                                    <div style={{ flex: 1, minWidth: 220 }}>
                                        <div style={{ fontWeight: 800, marginBottom: 6 }}>מסלול מומלץ</div>
                                        <select
                                            value={exportRecommendedRoute}
                                            onChange={(e) => setExportRecommendedRoute(e.target.value as "A" | "B" | "C")}
                                            style={{
                                                width: "100%",
                                                padding: "10px 12px",
                                                borderRadius: 10,
                                                border: "1px solid rgba(255,255,255,0.15)",
                                                background: "rgba(0,0,0,0.25)",
                                                color: "#e8eefc",
                                                outline: "none",
                                                fontFamily: "Arial, sans-serif",
                                            }}
                                        >
                                            <option value="A">מסלול א</option>
                                            <option value="B">מסלול ב</option>
                                            <option value="C">מסלול ג</option>
                                        </select>
                                    </div>
                                </div>

                                <div>
                                    <div style={{ fontWeight: 800, marginBottom: 6 }}>נתיב שמירה</div>
                                    <div
                                        style={{
                                            display: "grid",
                                            gridTemplateColumns: "1fr auto",
                                            gap: 10,
                                            alignItems: "center",
                                            padding: "10px 12px",
                                            borderRadius: 10,
                                            border: "1px solid rgba(255,255,255,0.12)",
                                            background: "rgba(255,255,255,0.04)",
                                        }}
                                    >
                                        <div style={{ minWidth: 0 }}>
                                            <input
                                                value={exportSavePath}
                                                onChange={(e) => setExportSavePath(e.target.value)}
                                                style={{
                                                    width: "100%",
                                                    padding: "10px 12px",
                                                    borderRadius: 10,
                                                    border: "1px solid rgba(255,255,255,0.15)",
                                                    background: "rgba(0,0,0,0.25)",
                                                    color: "#e8eefc",
                                                    outline: "none",
                                                    fontFamily: "Arial, sans-serif",
                                                }}
                                                placeholder="C\\Users\\...\\Downloads"
                                            />
                                        </div>

                                        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                                            <button
                                                onClick={chooseExportFolder}
                                                style={{
                                                    padding: "8px 10px",
                                                    borderRadius: 10,
                                                    border: "1px solid rgba(255,255,255,0.15)",
                                                    background: "rgba(255,255,255,0.06)",
                                                    color: "#e8eefc",
                                                    cursor: "pointer",
                                                    fontWeight: 900,
                                                    fontFamily: "Arial, sans-serif",
                                                }}
                                            >
                                                בחר תיקייה…
                                            </button>

                                            <button
                                                onClick={resetExportSavePath}
                                                style={{
                                                    padding: "8px 10px",
                                                    borderRadius: 10,
                                                    border: "1px solid rgba(255,255,255,0.15)",
                                                    background: "transparent",
                                                    color: "#e8eefc",
                                                    cursor: "pointer",
                                                    fontWeight: 900,
                                                    fontFamily: "Arial, sans-serif",
                                                }}
                                            >
                                                ברירת מחדל
                                            </button>
                                        </div>
                                    </div>

                                    <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75, lineHeight: 1.4 }}>
                                        הערה: בדפדפנים רבים לא ניתן לקרוא את הנתיב המלא של התיקייה שנבחרה. כאן ניתן להזין/לעדכן את הנתיב להצגה, והקובץ יישמר בתיקייה שנבחרה (אם נתמך) או ירד ל־Downloads.
                                    </div>
                                </div>

                                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 2 }}>
                                    <button
                                        onClick={() => {
                                            void exportParticipantHtml();
                                        }}
                                        style={{
                                            flex: 1,
                                            minWidth: 220,
                                            padding: "10px 12px",
                                            borderRadius: 12,
                                            border: "1px solid rgba(255,255,255,0.18)",
                                            background: "rgba(140,203,255,0.18)",
                                            color: "#e8eefc",
                                            cursor: "pointer",
                                            fontWeight: 900,
                                            fontFamily: "Arial, sans-serif",
                                            textAlign: "center",
                                        }}
                                    >
                                        ייצוא ושמירה (HTML)
                                    </button>

                                    <button
                                        onClick={() => setExportOpen(false)}
                                        style={{
                                            flex: 1,
                                            minWidth: 220,
                                            padding: "10px 12px",
                                            borderRadius: 12,
                                            border: "1px solid rgba(255,255,255,0.18)",
                                            background: "transparent",
                                            color: "#e8eefc",
                                            cursor: "pointer",
                                            fontWeight: 900,
                                            fontFamily: "Arial, sans-serif",
                                            textAlign: "center",
                                        }}
                                    >
                                        ביטול
                                    </button>
                                </div>

                                {exportLastSaved && (
                                    <div style={{ marginTop: 2, fontSize: 12, opacity: 0.85 }}>
                                        נשמר לאחרונה: <b>{exportLastSaved}</b>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {showVisualizations && (
                    <VisualizationModal
                        open={showVisualizations}
                        onClose={() => setShowVisualizations(false)}
                        routeScores={routeScores}
                        selectedRoute={selectedRoute}
                        // חשוב: כל שינוי בחירת מסלול צריך לעדכן גם את ה-Ref וגם את סגנון המפה
                        // כדי שעריכת מסלול (Edit mode) תתנהג עקבי כמו ב-App_25.
                        onSelectRoute={selectRouteFromPanel}
                    />
                )}

                <div style={{ fontSize: 12, opacity: 0.65 }}>טיפ: בחר מסלול א/ב/ג בפאנל כדי להציג עליו את חלוקת המקטעים.</div>
            </div>
        </div>
    );
}