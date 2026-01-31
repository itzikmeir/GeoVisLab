import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// ---- Export screen (participant) helpers ----
declare global {
    interface Window {
        showDirectoryPicker?: (options?: Record<string, unknown>) => Promise<unknown>;
    }
}
type ExportVizType = "STACKED" | "RADAR" | "HEATMAP";
type ExportSaveMode = "downloads" | "directory";

function safeFileName(input: string) {
    const base = (input || "scenario").trim();
    const cleaned = base.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "_").slice(0, 80);
    return cleaned || "scenario";
}

// Helper to construct the standalone HTML

// --- 1. החלף את הפונקציה buildParticipantHtml הקיימת בקוד הבא: ---

function buildParticipantHtml(args: {
    scenarioName: string;
    taskText: string;
    requirementsText: string;
    recommendedRoute: "A" | "B" | "C";
    vizType: ExportVizType;
    baseMapDataUrl: string;
    mapView: { width: number; height: number; zoom: number; center: LngLat };
    start: LngLat | null;
    end: LngLat | null;
    routes: Record<"A" | "B" | "C", LngLat[]>;
    badges: { id: string; coord: LngLat }[];
    manualParks: { id: string; ring: LngLat[] }[];
    catTrafficSegs: { id: string; coords: LngLat[] }[];
    catTollSegs: { id: string; coords: LngLat[] }[];
    catTollLabels: { coord: LngLat; side: "left" | "right" }[];
    catCommZones: { id: string; ring: LngLat[]; radiusM: number }[];
    routeScores: any[];
}) {
    const payload = {
        ...args,
        vizConfig: [
            { key: "speedScore", label: "מהירות", desc: "מיעוט עומסים", color: "#3B82F6" },
            { key: "economyScore", label: "חיסכון", desc: "מיעוט כבישי אגרה", color: "#F59E0B" },
            { key: "scenicScore", label: "נוף", desc: "מעבר ליד פארקים", color: "#22C55E" },
            { key: "commScore", label: "קליטה", desc: "מעגלי תקשורת מוגברת", color: "#A855F7" },
        ],
        colors: {
            routePalette: { A: "#3B82F6", B: "#F59E0B", C: "#A855F7" },
            routeSelected: "#1E4ED8",
            routeRegular: "#8CCBFF",
            traffic: "#FF0022",
            toll: "#FFE100",
            comm: { fill: "rgba(170,60,255,0.28)", outline: "rgba(170,60,255,0.65)" },
            parks: { fill: "#00FF66", outline: "transparent", opacity: 0.95 },
        },
    };
    const payloadJson = JSON.stringify(payload);

    return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${String(args.scenarioName).replace(/</g, "&lt;")}</title>
<style>
  /* GLOBAL FONT RESET - STRICT ARIAL */
  * { box-sizing: border-box; user-select: none; font-family: Arial, sans-serif !important; }
  html, body { height: 100%; margin: 0; background: #0b0f17; color: #e8eefc; overflow: hidden; font-size: 14px; }

  .root { height: 100%; display: flex; flex-direction: column; gap: 8px; padding: 8px; }
  
  /* Shared Panel Style */
  .panel { 
      border: 1px solid rgba(255,255,255,0.12); 
      background: rgba(11,15,23,0.95); 
      box-shadow: 0 4px 12px rgba(0,0,0,0.4); 
      border-radius: 8px; 
  }

  .top { flex: 1; min-height: 0; display: flex; gap: 8px; direction: ltr; }

  /* Map Panel */
  .mapPanel { flex: 1; min-width: 0; position: relative; overflow: hidden; background: #000; }
  #mapStage { position: absolute; left: 0; top: 0; transform-origin: 0 0; touch-action: none; will-change: transform; }
  #baseImg { display: block; pointer-events: none; }
  #overlaySvg { position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: auto; }

  .ctrlCol { position: absolute; left: 10px; top: 10px; display: flex; flex-direction: column; gap: 6px; z-index: 10; }
  
  .ctrlBtn, .filterBtn { 
      width: 40px; height: 40px; 
      border-radius: 8px; 
      border: 1px solid rgba(255,255,255,0.2); 
      background: rgba(15,23,42,0.9); 
      color: white; cursor: pointer; 
      display: flex; align-items: center; justify-content: center; 
      transition: all 0.1s; 
  }
  .ctrlBtn:hover, .filterBtn:hover { background: rgba(255,255,255,0.1); }
  .ctrlBtn svg, .filterBtn svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; }

  .filterBtn { position: absolute; left: 10px; bottom: 10px; z-index: 20; box-shadow: 0 4px 10px rgba(0,0,0,0.3); }
  .filterBtn.has-active::after { 
      content: ""; position: absolute; top: 6px; right: 6px; 
      width: 8px; height: 8px; background: #F59E0B; 
      border-radius: 50%; border: 1px solid #1e293b;
  }

  .mapLegend { position: absolute; right: 10px; bottom: 10px; padding: 10px; width: 160px; direction: rtl; text-align: right; pointer-events: none; z-index: 15; font-size: 12px; }
  .legRow { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
  .legLine { width: 24px; height: 3px; border-radius: 1px; }

  /* Task Panel */
  .taskPanel {font-family: Arial, sans-serif; width: 430px; max-width: 40%; display: flex; flex-direction: column; gap: 12px; padding: 16px; direction: rtl; text-align: right; overflow-y: auto; }
  .h { font-weight: 700; font-size: 24px; color: #fff; margin-bottom: 4px; }
  .muted { font-size: 20px; opacity: 0.8; line-height: 1.5; white-space: pre-wrap; }
  .sep { height: 1px; background: rgba(255,255,255,0.1); margin: 4px 0; }
  
  .recBox { 
      background: rgba(59,130,246,0.15); 
      border: 1px solid rgba(59,130,246,0.4); 
      padding: 12px 16px; 
      border-radius: 8px; 
      display: flex; 
      justify-content: space-between; 
      align-items: center;
      font-family: Arial, sans-serif !important;
  }
  .recLabel { font-size: 20px !important; font-weight: normal; color: #e8eefc; }
  .recVal { font-family: Arial, sans-serif !important; font-size: 20px !important; font-weight: 800; color: #60A5FA; }

  .btnPrimary { width: 100%; padding: 14px; background: #2563EB; color: white; border: none; border-radius: 8px; font-size: 20px; font-weight: 700; cursor: pointer; margin-top: auto; }
  .btnPrimary:hover { background: #1D4ED8; }

  /* Bottom Panel Layout - RTL */
  .bottom { height: 260px; display: flex; gap: 8px; direction: rtl; }
  
  /* 1. GANTT PANEL (Rightmost) */
  .ganttPanel { 
      width: 38%; 
      min-width: 320px; 
      padding: 12px; 
      direction: rtl; 
      display: flex; 
      flex-direction: column; 
  }

  /* 2. VIZ PANEL (Center) */
  .vizPanel { 
      flex: 1; 
      padding: 12px; 
      direction: rtl; 
      overflow: hidden; 
      display: flex; 
      flex-direction: column; 
  }

  /* 3. LEGEND PANEL (Leftmost) */
  .legendPanel { 
      width: 190px; 
      padding: 12px; 
      display: flex; 
      flex-direction: column; 
      justify-content: flex-start; 
      direction: rtl; 
      overflow-y: auto; 
  }
  .legItem { margin-bottom: 12px; display: flex; align-items: flex-start; gap: 8px; }
  .legColorBox { width: 14px; height: 14px; margin-top: 3px; border-radius: 3px; flex-shrink: 0; }
  .legContent { display: flex; flex-direction: column; }
  .legTitle { font-weight: 800; font-size: 13px; }
  .legDesc { font-size: 11px; opacity: 0.7; margin-top: 2px; }

  /* Viz Container inside Panel */
  #viz-container {
    width: 100%;
    height: 100%;
    overflow: hidden;
    box-sizing: border-box;
    border: 2px solid #3B82F6; 
    background: rgba(255, 255, 255, 0.02);
    border-radius: 8px; 
    padding: 10px;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  
  .viz-headers-row {
      display: flex; width: 100%; margin-bottom: 8px; padding-bottom: 6px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
  }
  .viz-header-item {
      flex: 1; text-align: center; font-weight: bold; font-size: 13px; color: #cbd5e1;
      display: flex; align-items: center; justify-content: center; gap: 6px;
  }

  /* Heatmap - Fixed Column Width Logic */
  .heatmap-table { width: 100%; height: 100%; border-collapse: collapse; table-layout: fixed; }
  
  /* Force fixed width on first column, let others flex */
  .heatmap-table th:first-child, 
  .heatmap-table td:first-child { 
      width: 90px; /* Fixed narrow width */
      max-width: 90px;
      padding-left: 4px; 
      text-align: right !important; 
      white-space: nowrap;
  }
  
  .heatmap-table th { padding-bottom: 6px; text-align: center; vertical-align: bottom; }
  .heatmap-table td { border-bottom: 1px solid rgba(255,255,255,0.1); }
  
  .heatmap-cell { 
      text-align: center; vertical-align: middle; 
      color: #fff; font-weight: 900; font-size: 15px;
      text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 5px rgba(0,0,0,0.8);
      margin: 2px; border-radius: 4px; height: 100%;
  }
  .heatmap-table td > div { height: 85%; width: 92%; margin: 0 auto; display:flex; align-items:center; justify-content:center; border-radius:4px; }
  .segment-badge {
      display: inline-block; width: 20px; height: 20px; line-height: 20px;
      border-radius: 50%; background-color: #1E4ED8; color: white; text-align: center; font-weight: bold; font-size: 11px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
  }

  /* Stacked Bars */
  .stacked-wrapper { display: flex; width: 100%; height: 100%; align-items: flex-end; }
  .stacked-col-container { flex: 1; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; padding: 0 10px; }
  .stacked-bar { width: 60%; display: flex; flex-direction: column-reverse; border-radius: 4px 4px 0 0; overflow: hidden; background: rgba(255,255,255,0.05); }
  .stack-segment { width: 100%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: bold; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.8); border-top: 1px solid rgba(0,0,0,0.1); white-space: nowrap; overflow: hidden; }

  /* Radar */
  .radar-wrapper { display: flex; width: 100%; height: 100%; align-items: center; justify-content: space-around; direction: rtl; }
  .radar-chart { 
      position: relative; flex: 1; height: 100%; 
      display: flex; flex-direction: column; align-items: center; justify-content: center; 
  }
  .radar-badge-corner { position: absolute; top: 5px; right: 10px; z-index: 10; display:flex; align-items:center; gap:6px; font-weight:bold; font-size:12px; color:#ddd; }

  /* Gantt Styles */
  .ganttScroll { 
      flex: 1; 
      overflow-y: auto; 
      overflow-x: hidden; 
      padding-left: 0; 
      padding-right: 4px;
      direction: rtl; 
  }
  
  .ganttRow { 
      display: flex; align-items: center; height: 42px; margin-bottom: 10px; 
      cursor: pointer; transition: 0.1s; 
      border-radius: 6px; border: 1px solid transparent; 
      position: relative; 
      margin-left: 4px; 
  }
  .ganttRow:hover { background: rgba(255,255,255,0.05); }
  
  .ganttRow.active { 
      background: rgba(59,130,246,0.2); 
      border: 2px solid #3B82F6; 
      box-shadow: inset 0 0 10px rgba(59,130,246,0.3);
  }

  .gLabel { width: 60px; font-weight: 700; font-size: 14px; }
  .gTrackContainer { flex: 1; height: 28px; position: relative; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; }
  .gBar { height: 100%; position: absolute; right: 0; top: 0; bottom: 0; border-radius: 4px; overflow: hidden; direction: rtl; display: flex; }
  .gSeg { height: 100%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 900; color: #000; background: #8CCBFF; border-left: 3px solid #000; box-sizing: border-box; }
  .gSeg:last-child { border-left: none; }
  .gAxis { position: relative; height: 20px; margin-top: 4px; border-top: 1px solid rgba(255,255,255,0.1); margin-right: 60px; direction: ltr; }

  /* Modals */
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: none; align-items: center; justify-content: center; z-index: 9999; backdrop-filter: blur(2px); }
  .backdrop.show { display: flex; }
  .modal { background: #1e293b; border: 1px solid #334155; width: 400px; max-width: 90%; padding: 20px; border-radius: 12px; text-align: center; direction: rtl; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); }
  .modalBtns { display: flex; gap: 10px; margin-top: 20px; justify-content: center; }
  .mBtn { padding: 10px 20px; border-radius: 6px; cursor: pointer; border: none; font-weight: 700; flex:1; }
  .mBtn.yes { background: #2563EB; color: white; }
  .mBtn.no { background: rgba(255,255,255,0.1); color: white; }
  .filterRow { display: flex; justify-content: space-between; align-items: center; padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); }
  .eyeBtn { background: none; border: none; color: white; cursor: pointer; opacity: 0.7; display:flex; align-items:center; gap:4px; }
  .eyeBtn.on { opacity: 1; color: #60A5FA; }
</style>
</head>
<body>

<div class="root">
  <div class="top">
    <div class="mapPanel panel">
      <div id="mapStage">
        <img id="baseImg" draggable="false" />
        <svg id="overlaySvg"></svg>
      </div>

      <div class="ctrlCol">
        <button class="ctrlBtn" id="zoomIn" title="זום אין"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
        <button class="ctrlBtn" id="fitView" title="מרכז מפה"><svg viewBox="0 0 24 24"><path d="M4 4h16v16H4zM8 8h8v8H8z"/></svg></button>
        <button class="ctrlBtn" id="zoomOut" title="זום אאוט"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button>
      </div>

      <button class="filterBtn" id="openFilter" title="שכבות">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
      </button>

      <div class="mapLegend panel">
        <div style="font-weight:700; margin-bottom:8px; opacity:0.9">מקרא מפה</div>
        <div class="legRow"><div class="legLine" style="background:#8CCBFF"></div><span>מסלול</span></div>
        <div class="legRow"><div class="legLine" style="background:#1E4ED8"></div><span>מסלול נבחר</span></div>
        <div class="legRow"><div class="legLine" style="border-top:3px dashed #FF0022; height:0"></div><span>עומס</span></div>
        <div class="legRow">
           <div style="width:24px; position:relative; height:8px">
             <div style="position:absolute; top:0; width:100%; height:2px; background:#FFE100"></div>
             <div style="position:absolute; bottom:0; width:100%; height:2px; background:#FFE100"></div>
           </div>
           <span>אגרה</span>
        </div>
        <div class="legRow"><div style="width:12px; height:12px; background:rgba(170,60,255,0.4); border:1px solid #A855F7; border-radius:50%"></div><span>תקשורת</span></div>
        <div class="legRow"><div style="width:16px; height:10px; background:#00FF66; opacity:0.7"></div><span>פארק</span></div>
      </div>
    </div>

    <div class="taskPanel panel">
      <div class="h">מטלה</div>
      <div class="muted" id="taskText"></div>
      <div class="muted" id="requirementsText" style="font-weight:900; margin-top:8px; display:none;"></div>
      <div class="sep"></div>
      <div class="recBox">
        <div class="recLabel">המלצת המערכת</div>
        <div class="recVal" id="recRoute"></div>
      </div>
      <div style="font-size:12px; margin-top:4px; opacity:0.8; text-align:right">ניתן לבחור מסלול בלחיצה על הקו במפה (או על תגית א/ב/ג).</div>
      
      <div class="sep"></div>
      <div style="display:flex; justify-content:space-between; align-items:center; font-weight:700">
        <span>מסלול נבחר:</span>
        <span id="pickedDisplay" style="font-size:20px; color:#60A5FA">—</span>
      </div>
      <button class="btnPrimary" id="submitBtn">אישור בחירה</button>
    </div>
  </div>

  <div class="bottom">
    <div class="ganttPanel panel">
         <div class="h" style="font-size:14px; margin-bottom:10px">זמני מקטעים (דקות)</div>
         <div id="ganttContainer" class="ganttScroll"></div>
         <div id="ganttAxis" class="gAxis"></div>
    </div>

    <div class="vizPanel panel">
         <div id="viz-container"></div>
    </div>

    <div class="legendPanel panel">
      <div class="h" style="font-size:14px; margin-bottom:12px">מקרא ויזואליזציה</div>
      <div id="vizLegendContent"></div>
    </div>
  </div>
</div>

<div class="backdrop" id="filterModal">
  <div class="modal" style="width:320px">
    <div class="h">סינון שכבות</div>
    <div style="margin:15px 0; display:flex; gap:10px; justify-content:center">
        <button id="showAll" class="eyeBtn on" style="font-size:12px; border:1px solid #555; padding:6px 12px; border-radius:4px">הצג הכל</button>
        <button id="hideAll" class="eyeBtn" style="font-size:12px; border:1px solid #555; padding:6px 12px; border-radius:4px">הסתר הכל</button>
    </div>
    <div id="filterList" style="text-align:right"></div>
    <div style="margin-top:20px">
        <button class="mBtn no" id="closeFilter">סגור</button>
    </div>
  </div>
</div>

<div class="backdrop" id="confirmModal">
  <div class="modal">
    <div class="h" style="font-size:18px; margin-bottom:10px">אישור בחירה</div>
    <p id="confirmText" style="margin-bottom:20px; font-size:16px"></p>
    <div id="confirmWarning" style="background:rgba(245,158,11,0.2); color:#FCD34D; padding:10px; border-radius:6px; margin-bottom:20px; display:none; font-size:14px; border:1px solid rgba(245,158,11,0.4)">
        שים לב: בחרת במסלול שונה מהמלצת המערכת.
    </div>
    <div class="modalBtns">
      <button class="mBtn yes" id="doConfirm">כן, אני בטוח</button>
      <button class="mBtn no" id="cancelConfirm">ביטול</button>
    </div>
  </div>
</div>

<script>
const DATA = ${payloadJson};
let scale = 1, pan = {x: 0, y: 0}, picked = DATA.recommendedRoute || 'A';
let filters = { routes: true, traffic: true, toll: true, comm: true, parks: true };

const els = {
    mapPanel: document.querySelector('.mapPanel'), 
    mapStage: document.getElementById('mapStage'),
    baseImg: document.getElementById('baseImg'),
    svg: document.getElementById('overlaySvg'),
    taskText: document.getElementById('taskText'),
    requirementsText: document.getElementById('requirementsText'),
    recRoute: document.getElementById('recRoute'),
    pickedDisplay: document.getElementById('pickedDisplay'),
    vizContainer: document.getElementById('viz-container'),
    vizLegend: document.getElementById('vizLegendContent'),
    gantt: document.getElementById('ganttContainer'),
    gAxis: document.getElementById('ganttAxis'),
    filterBtn: document.getElementById('openFilter'),
    filterList: document.getElementById('filterList'),
    confirmText: document.getElementById('confirmText'),
    confirmWarn: document.getElementById('confirmWarning')
};

// Init Legend
DATA.vizConfig.forEach(c => {
    const row = document.createElement('div');
    row.className = 'legItem';
    row.innerHTML = '<div class="legColorBox" style="background:'+c.color+'"></div>' + 
                    '<div class="legContent"><div class="legTitle">'+c.label+'</div><div class="legDesc">'+c.desc+'</div></div>';
    els.vizLegend.appendChild(row);
});

// Init Map Image
els.baseImg.src = DATA.baseMapDataUrl;
els.baseImg.onload = () => {
    const w = els.baseImg.naturalWidth || DATA.mapView.width;
    const h = els.baseImg.naturalHeight || DATA.mapView.height;
    els.mapStage.style.width = w + 'px';
    els.mapStage.style.height = h + 'px';
    els.svg.setAttribute('viewBox', \`0 0 \${w} \${h}\`);
    updateTransform();
};
if (els.baseImg.complete && els.baseImg.naturalWidth > 0) els.baseImg.onload();

els.taskText.textContent = DATA.taskText;
if (els.requirementsText) {
  const t = String(DATA.requirementsText || '').trim();
  if (t) { els.requirementsText.style.display = 'block'; els.requirementsText.textContent = t; }
}

els.recRoute.textContent = 'מסלול ' + heb(DATA.recommendedRoute);

// Projection Helpers
function project(ll) {
    const merc = (lon, lat) => {
        const x = (lon + 180) / 360;
        const sin = Math.sin(lat * Math.PI / 180);
        const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI));
        return { x, y };
    };
    const c = merc(DATA.mapView.center[0], DATA.mapView.center[1]);
    const p = merc(ll[0], ll[1]);
    const worldSize = Math.pow(2, DATA.mapView.zoom) * 512;
    return {
        x: DATA.mapView.width / 2 + (p.x - c.x) * worldSize,
        y: DATA.mapView.height / 2 + (p.y - c.y) * worldSize
    };
}
function heb(id) { return id === 'A' ? 'א' : id === 'B' ? 'ב' : 'ג'; }

function getTickLine(p1, p2, p3, len) {
    let vx1 = p2.x - p1.x, vy1 = p2.y - p1.y;
    let vx2 = p3.x - p2.x, vy2 = p3.y - p2.y;
    const l1 = Math.hypot(vx1, vy1) || 1;
    const l2 = Math.hypot(vx2, vy2) || 1;
    vx1/=l1; vy1/=l1; vx2/=l2; vy2/=l2;
    let bx = vx1 + vx2, by = vy1 + vy2;
    const bl = Math.hypot(bx, by);
    if(bl < 1e-5) { bx = -vy1; by = vx1; } else { bx/=bl; by/=bl; }
    const nx = -by, ny = bx;
    return [{x: p2.x - nx*len, y: p2.y - ny*len}, {x: p2.x + nx*len, y: p2.y + ny*len}];
}

function getOffsetPath(coords, offsetPx) {
    if(coords.length < 2) return '';
    let d = '';
    for(let i=0; i<coords.length; i++) {
        const curr = project(coords[i]);
        const next = coords[i+1] ? project(coords[i+1]) : null;
        let dx, dy;
        if (next) { dx = next.x - curr.x; dy = next.y - curr.y; } 
        else { dx = curr.x - project(coords[i-1]).x; dy = curr.y - project(coords[i-1]).y; }
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy/len, ny = dx/len;
        d += (i===0 ? 'M' : 'L') + (curr.x + nx * offsetPx).toFixed(1) + ',' + (curr.y + ny * offsetPx).toFixed(1) + ' ';
    }
    return d;
}

// Drawing Map
function drawMap() {
    els.svg.innerHTML = '';
    const gComm = g('gc'), gParks = g('gp'), gToll = g('gt'), gRoutesHalo = g('grh'), gRoutes = g('gr'), gTraffic = g('gtr'), gTollIco = g('gti'), gSegs = g('gs'), gOver = g('go');
    els.svg.append(gComm, gParks, gToll, gRoutesHalo, gRoutes, gTraffic, gTollIco, gSegs, gOver);

    if(filters.comm) DATA.catCommZones.forEach(z => gComm.appendChild(mkPoly(z.ring, DATA.colors.comm.fill, DATA.colors.comm.outline)));
    if(filters.parks) DATA.manualParks.forEach(p => gParks.appendChild(mkPoly(p.ring, DATA.colors.parks.fill, DATA.colors.parks.outline)));
    
    if(filters.toll) DATA.catTollSegs.forEach(seg => {
         const p1 = document.createElementNS('http://www.w3.org/2000/svg','path');
         p1.setAttribute('d', getOffsetPath(seg.coords, 3)); p1.setAttribute('stroke', DATA.colors.toll); p1.setAttribute('stroke-width', 2); p1.setAttribute('fill', 'none');
         const p2 = document.createElementNS('http://www.w3.org/2000/svg','path');
         p2.setAttribute('d', getOffsetPath(seg.coords, -3)); p2.setAttribute('stroke', DATA.colors.toll); p2.setAttribute('stroke-width', 2); p2.setAttribute('fill', 'none');
         gToll.append(p1, p2);
    });

    if(filters.routes) {
        const routeKeys = ['A', 'B', 'C'].sort((a,b) => a === picked ? 1 : -1);
        
        routeKeys.forEach(rid => {
            const pts = DATA.routes[rid];
            if(!pts) return;
            const isSel = rid === picked;
            const color = isSel ? DATA.colors.routeSelected : DATA.colors.routeRegular;
            
            gRoutesHalo.appendChild(mkPath(pts, 'rgba(0,0,0,0.3)', isSel ? 10 : 8));
            
            const line = mkPath(pts, color, isSel ? 6 : 5);
            line.style.cursor = 'pointer'; 
            line.onclick = (e) => { e.stopPropagation(); selectRoute(rid); };
            gRoutes.appendChild(line);
            
            const hit = mkPath(pts, 'transparent', 20);
            hit.style.cursor = 'pointer'; 
            hit.onclick = (e) => { e.stopPropagation(); selectRoute(rid); };
            gRoutes.appendChild(hit);

            if(isSel) {
                const proj = pts.map(project);
                const total = getPathLen(proj);
                [0.33, 0.66].forEach(f => {
                    const {p, idx} = getPointAtFrac(proj, total, f);
                    if(p && idx>0 && idx<proj.length-1) {
                         const lg = getTickLine(proj[idx-1], p, proj[idx+1], 10);
                         const l = document.createElementNS('http://www.w3.org/2000/svg','line');
                         l.setAttribute('x1', lg[0].x); l.setAttribute('y1', lg[0].y);
                         l.setAttribute('x2', lg[1].x); l.setAttribute('y2', lg[1].y);
                         l.setAttribute('stroke', '#000'); l.setAttribute('stroke-width', 2);
                         gSegs.appendChild(l);
                    }
                });
                [0.16, 0.5, 0.83].forEach((f,i) => {
                    const {p} = getPointAtFrac(proj, total, f);
                    if(p) {
                         const g = document.createElementNS('http://www.w3.org/2000/svg','g');
                         g.append(circle(p.x, p.y, 9, color, '#fff'), text(p.x, p.y+4, String(i+1), 11, '#fff'));
                         gSegs.appendChild(g);
                    }
                });
            }
        });
        
        if(DATA.badges) DATA.badges.forEach(b => {
             const isSel = b.id === picked;
             const p = project(b.coord);
             const col = isSel ? DATA.colors.routeSelected : DATA.colors.routeRegular;
             const g = document.createElementNS('http://www.w3.org/2000/svg','g');
             g.style.cursor = 'pointer'; g.onclick = (e) => { e.stopPropagation(); selectRoute(b.id); };
             const rect = document.createElementNS('http://www.w3.org/2000/svg','rect');
             rect.setAttribute('x', p.x-12); rect.setAttribute('y', p.y-12); rect.setAttribute('width', 24); rect.setAttribute('height', 24);
             rect.setAttribute('rx', 6); rect.setAttribute('fill', col); rect.setAttribute('stroke', 'rgba(0,0,0,0.3)');
             const t = text(p.x, p.y+5, heb(b.id), 14, isSel ? '#fff' : '#000'); t.setAttribute('font-weight','900');
             g.append(rect, t);
             gOver.appendChild(g);
        });
    }

    if(filters.traffic) DATA.catTrafficSegs.forEach(s => {
        const p = mkPath(s.coords, DATA.colors.traffic, 5); p.setAttribute('stroke-dasharray', '5,5'); gTraffic.appendChild(p);
    });
    if(filters.toll) DATA.catTollLabels.forEach(l => {
        const p = project(l.coord);
        const g = document.createElementNS('http://www.w3.org/2000/svg','g');
        g.append(circle(p.x, p.y, 7, DATA.colors.toll, '#000'), text(p.x, p.y+3, '₪', 10, '#000'));
        gTollIco.appendChild(g);
    });
    if(DATA.start) { const p = project(DATA.start); gOver.append(circle(p.x, p.y, 7, '#fff', '#000'), drawLabel(p.x, p.y-20, 'מוצא')); }
    if(DATA.end) { 
        const p = project(DATA.end); 
        const g = document.createElementNS('http://www.w3.org/2000/svg','g');
        g.innerHTML = '<path transform="translate('+(p.x-10)+','+(p.y-22)+') scale(0.85)" d="M12 0c-6.6 0-12 5.4-12 12 0 8 12 24 12 24s12-16 12-24c0-6.6-5.4-12-12-12zm0 16c-2.2 0-4-1.8-4-4s1.8-4 4-4 4 1.8 4 4-1.8 4-4 4z" fill="#d11111" stroke="#000" stroke-width="1"/>';
        gOver.append(g, drawLabel(p.x, p.y-30, 'יעד'));
    }
}

// Map SVG Helpers
function g(id){ const e = document.createElementNS('http://www.w3.org/2000/svg','g'); e.id=id; return e; }
function mkPath(c,col,w){
    const d=c.map((pt,i)=>(i==0?'M':'L')+project(pt).x+','+project(pt).y).join(' ');
    const p=document.createElementNS('http://www.w3.org/2000/svg','path');
    p.setAttribute('d',d); p.setAttribute('stroke',col); p.setAttribute('stroke-width',w); p.setAttribute('fill','none'); p.setAttribute('stroke-linecap','round'); p.setAttribute('stroke-linejoin','round');
    return p;
}
function mkPoly(r,f,s){
    const pts=r.map(pt=>project(pt).x+','+project(pt).y).join(' ');
    const p=document.createElementNS('http://www.w3.org/2000/svg','polygon');
    p.setAttribute('points',pts); p.setAttribute('fill',f); p.setAttribute('stroke',s); p.setAttribute('stroke-width',2);
    return p;
}
function circle(x,y,r,f,s){
    const c=document.createElementNS('http://www.w3.org/2000/svg','circle');
    c.setAttribute('cx',x); c.setAttribute('cy',y); c.setAttribute('r',r); c.setAttribute('fill',f); c.setAttribute('stroke',s);
    return c;
}
function text(x,y,t,sz,f){
    const el=document.createElementNS('http://www.w3.org/2000/svg','text');
    el.setAttribute('x',x); el.setAttribute('y',y); el.setAttribute('text-anchor','middle'); el.setAttribute('font-size',sz); el.setAttribute('fill',f); el.setAttribute('font-family','Arial'); el.textContent=t;
    return el;
}
function drawLabel(x,y,txt){
    const g=document.createElementNS('http://www.w3.org/2000/svg','g');
    const w=txt.length*7+10, h=18;
    const r=document.createElementNS('http://www.w3.org/2000/svg','rect');
    r.setAttribute('x',x-w/2); r.setAttribute('y',y-h/2); r.setAttribute('width',w); r.setAttribute('height',h); r.setAttribute('rx',4); r.setAttribute('fill','rgba(0,0,0,0.8)');
    const t=text(x,y+4,txt,11,'#fff'); t.setAttribute('font-weight','bold');
    g.append(r,t); return g;
}
function getPathLen(pts){ let l=0; for(let i=1;i<pts.length;i++) l+=Math.hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y); return l; }
function getPointAtFrac(pts,total,frac){
    const tg=total*frac; let d=0;
    for(let i=1;i<pts.length;i++){
        const dist=Math.hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
        if(d+dist>=tg){ const t=(tg-d)/dist; return {p:{x:pts[i-1].x+(pts[i].x-pts[i-1].x)*t, y:pts[i-1].y+(pts[i].y-pts[i-1].y)*t}, idx:i}; }
        d+=dist;
    }
    return {p:pts[pts.length-1], idx:pts.length-1};
}

// --- VISUALIZATION LOGIC ---
function renderVizContainer() {
    const container = els.vizContainer;
    container.innerHTML = '';
    
    const vizType = DATA.vizType; 
    const segments = (DATA.routeScores || []).filter(s => s.route === picked).sort((a,b) => a.segment - b.segment);
    const cats = DATA.vizConfig; 

    if (!segments.length) {
        container.innerHTML = '<div style="text-align:center; opacity:0.6; margin-top:20px">אין נתונים</div>';
        return;
    }

    if (vizType === 'HEATMAP') {
        const table = document.createElement('table'); table.className = 'heatmap-table';
        const thead = document.createElement('thead');
        const hRow = document.createElement('tr');
        hRow.appendChild(document.createElement('th')); 
        segments.forEach(seg => {
            const th = document.createElement('th');
            th.innerHTML = '<span style="font-size:12px; color:#cbd5e1; margin-left:4px">מקטע</span><span class="segment-badge">' + seg.segment + '</span>';
            hRow.appendChild(th);
        });
        thead.appendChild(hRow); table.appendChild(thead);
        const tbody = document.createElement('tbody');
        
        cats.forEach(c => {
            const tr = document.createElement('tr');
            const tdName = document.createElement('td');
            // Left aligned as requested
            tdName.style.textAlign = 'left'; 
            tdName.style.padding = '4px'; 
            tdName.style.color='#ddd';
            tdName.innerHTML = '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;margin-left:6px;background:' + c.color + '"></span>' + c.label;
            tr.appendChild(tdName);
            
            segments.forEach(seg => {
                const td = document.createElement('td');
                // טבלת מפת חום גווני אפור
                //const val = seg[c.key] || 0;
                //const lightness = 15 + (val * 0.65); 
                //const bg = 'hsl(220, 25%, ' + lightness + '%)';
                //td.innerHTML = '<div style="background:'+bg+'" class="heatmap-cell">'+Math.round(val)+'</div>';
                // טבלת מפת חום גווני ירוק אדום
                const val = seg[c.key] || 0;
                // חישוב צבע: 0 = אדום (Hue 0), 100 = ירוק (Hue 120)
                const hue = Math.round(val * 1.2); 
                const bg = 'hsl(' + hue + ', 75%, 35%)'; // צבע כהה יחסית כדי שהטקסט הלבן יבלוט
                td.innerHTML = '<div style="background:'+bg+'; color:white;" class="heatmap-cell">'+Math.round(val)+'</div>';
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        container.appendChild(table);

    } else if (vizType === 'STACKED') {
        const headerRow = document.createElement('div'); headerRow.className = 'viz-headers-row';
        segments.forEach(seg => {
            const el = document.createElement('div'); el.className = 'viz-header-item';
            el.innerHTML = 'מקטע <span class="segment-badge">' + seg.segment + '</span>';
            headerRow.appendChild(el);
        });
        container.appendChild(headerRow);

        const maxPossible = cats.length * 100; 
        const wrapper = document.createElement('div'); wrapper.className = 'stacked-wrapper';
        segments.forEach(seg => {
            const colCont = document.createElement('div'); colCont.className = 'stacked-col-container';
            const bar = document.createElement('div'); bar.className = 'stacked-bar';
            
            let currentTotal = 0;
            cats.forEach(c => currentTotal += (seg[c.key] || 0));
            const barHeightPct = Math.min(100, (currentTotal / maxPossible) * 100);
            bar.style.height = barHeightPct + '%';
            
            cats.forEach(c => {
                const val = seg[c.key] || 0;
                if(val > 0) {
                   const item = document.createElement('div');
                   item.className = 'stack-segment';
                   item.style.backgroundColor = c.color;
                   const segH = (val / currentTotal) * 100;
                   item.style.height = segH + '%';
                   item.innerText = c.label + ' ' + Math.round(val);
                   bar.appendChild(item);
                }
            });
            colCont.appendChild(bar);
            wrapper.appendChild(colCont);
        });
        container.appendChild(wrapper);

} else if (vizType === 'RADAR') {
        const wrapper = document.createElement('div'); wrapper.className = 'radar-wrapper';
        
        segments.forEach((seg, idx) => {
             const chartDiv = document.createElement('div'); chartDiv.className = 'radar-chart';
             
             // קו הפרדה
             if (idx > 0) {
                 chartDiv.style.borderRight = '1px solid rgba(255,255,255,0.15)';
             }

             const badge = document.createElement('div');
             badge.className = 'radar-badge-corner';
             badge.innerHTML = 'מקטע <span class="segment-badge">' + seg.segment + '</span>';
             chartDiv.appendChild(badge);

             const size = 260; 
             // 1. הגדלת ה-Padding כדי להכיל את ההזזה הגדולה לצדדים
             const padding = 180; 
             const totalSize = size + padding * 2;
             
             const cx = totalSize/2, cy = totalSize/2, r = size * 0.9;
             const labelR = r + 25; 
             
             const svgNS = "http://www.w3.org/2000/svg";
             const svg = document.createElementNS(svgNS, "svg");
             svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%");
             svg.setAttribute("viewBox", "0 0 "+totalSize+" "+totalSize);
             svg.style.overflow = "visible"; 
             
             // עיגולי רקע
             [0.25, 0.5, 0.75, 1].forEach(k => {
                 const c = document.createElementNS(svgNS, "circle");
                 c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", r*k);
                 c.setAttribute("fill", "none"); 
                 c.setAttribute("stroke", "rgba(255,255,255,0.2)");
                 c.setAttribute("stroke-width", k===1 ? "2" : "1");
                 svg.appendChild(c);
             });
             
             let pts = [];
             const angleStep = (Math.PI * 2) / cats.length;
             
             cats.forEach((c, i) => {
                 const val = (seg[c.key] || 0) / 100;
                 const ang = i * angleStep - Math.PI/2;
                 
                 const x = cx + Math.cos(ang) * (r * val);
                 const y = cy + Math.sin(ang) * (r * val);
                 pts.push(x + ',' + y);
                 
                 const lx = cx + Math.cos(ang) * r;
                 const ly = cy + Math.sin(ang) * r;
                 const line = document.createElementNS(svgNS, "line");
                 line.setAttribute("x1", cx); line.setAttribute("y1", cy);
                 line.setAttribute("x2", lx); line.setAttribute("y2", ly);
                 line.setAttribute("stroke", "rgba(255,255,255,0.1)");
                 svg.appendChild(line);

                 // --- חישוב מיקום מעודכן ---
                 
                 const isSide = Math.abs(Math.cos(ang)) > 0.1; 
                 const isRight = Math.cos(ang) > 0; // חיסכון
                 const isLeft = Math.cos(ang) < 0;  // קליטה

                 // מיקום בסיסי
                 let lblX = cx + Math.cos(ang) * labelR;
                 let lblY = cy + Math.sin(ang) * labelR;

                 // 2. דחיפה אגרסיבית החוצה (85px) כדי למנוע חפיפה עם הרדאר
                 if (isSide) {
                     lblX += isRight ? 85 : -85;
                 } else {
                     lblY += Math.sin(ang) * 15;
                 }

                 const gLbl = document.createElementNS(svgNS, "g");
                 
                 // 3. הרחבת המלבן ל-150 פיקסלים (במקום 110)
                 const rectW = 200; 
                 const rectH = 50; // גובה קומפקטי אך מספק
                 const rect = document.createElementNS(svgNS, "rect");
                 
                 // מירכוז המלבן סביב הנקודה החדשה
                 rect.setAttribute("x", lblX - rectW/2);
                 rect.setAttribute("y", lblY - rectH/2);
                 rect.setAttribute("width", rectW); rect.setAttribute("height", rectH);
                 rect.setAttribute("rx", rectH/2); 
                 rect.setAttribute("fill", c.color);
                 rect.setAttribute("filter", "drop-shadow(0px 2px 2px rgba(0,0,0,0.25))");
                 
                 // טקסט
                 const textEl = document.createElementNS(svgNS, "text");
                 textEl.setAttribute("x", lblX); 
                 textEl.setAttribute("y", lblY + 1); // תיקון אופטי קטן למרכז
                 textEl.setAttribute("text-anchor", "middle");
                 textEl.setAttribute("dominant-baseline", "middle"); 
                 textEl.setAttribute("fill", "#fff");
                 
                 // עיצוב טקסט
                 textEl.setAttribute("style", "font-family: Arial, sans-serif; font-weight: 900; font-size: 40px !important; paint-order: stroke fill; stroke: rgba(0,0,0,0.8); stroke-width: 3px; stroke-linecap: round; stroke-linejoin: round;");
                 
                 textEl.textContent = c.label + " " + Math.round(seg[c.key]||0);

                 gLbl.appendChild(rect);
                 gLbl.appendChild(textEl);
                 svg.appendChild(gLbl);
             });
             
             const poly = document.createElementNS(svgNS, "polygon");
             poly.setAttribute("points", pts.join(' '));
             poly.setAttribute("fill", DATA.colors.routeSelected);
             poly.setAttribute("fill-opacity", "0.4");
             poly.setAttribute("stroke", DATA.colors.routeSelected);
             poly.setAttribute("stroke-width", "3");
             svg.appendChild(poly);
             
             chartDiv.appendChild(svg);
             wrapper.appendChild(chartDiv);
        });
        
        container.appendChild(wrapper);
    }
}

// Gantt Logic
function renderGantt() {
    const c = els.gantt, ax = els.gAxis;
    c.innerHTML = ''; ax.innerHTML = '';
    const scores = DATA.routeScores || [];
    let maxT = 0;
    ['A','B','C'].forEach(rid => {
        const segs = scores.filter(x => x.route === rid);
        const t = segs.reduce((a,b) => a + (b.timeS || 0), 0);
        if(t > maxT) maxT = t;
    });
    if (maxT === 0) maxT = 1;

    const mins = Math.ceil(maxT/60);
    for(let i=0; i<=mins; i++){
        const pos = (i*60/maxT)*100; if(pos > 100) break;
        const tk = document.createElement('div');
        tk.style.position='absolute'; tk.style.right=pos+'%'; tk.style.transform='translateX(50%)'; tk.textContent=i;
        const ln = document.createElement('div');
        ln.style.position='absolute'; ln.style.right=pos+'%'; ln.style.height='4px'; ln.style.width='1px'; ln.style.background='#555'; ln.style.top='-4px';
        ax.append(ln, tk);
    }

    ['A','B','C'].forEach(rid => {
        const segs = scores.filter(s => s.route === rid).sort((a,b) => a.segment - b.segment);
        const total = segs.reduce((a,b) => a + (b.timeS || 0), 0) || 1;
        const row = document.createElement('div');
        row.className = 'ganttRow' + (rid === picked ? ' active' : '');
        row.onclick = () => { picked=rid; selectRoute(rid); };
        const lbl = document.createElement('div'); lbl.className = 'gLabel'; lbl.textContent = 'מסלול ' + heb(rid);
        const trk = document.createElement('div'); trk.className = 'gTrackContainer';
        const bar = document.createElement('div'); bar.className = 'gBar'; bar.style.width = (total / maxT * 100) + '%';
        segs.forEach(s => {
            const el = document.createElement('div'); el.className = 'gSeg';
            const pct = ((s.timeS || 0) / total * 100); el.style.width = pct + '%';
            el.textContent = s.segment;
            bar.appendChild(el);
        });
        trk.appendChild(bar); row.append(lbl, trk); c.appendChild(row);
    });
}

function selectRoute(id) {
    picked = id;
    els.pickedDisplay.textContent = 'מסלול ' + heb(id);
    renderVizContainer();
    renderGantt(); 
    drawMap();
}

// FIXED DRIFT-FREE ZOOM LOGIC
els.mapStage.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = els.mapPanel.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.max(1, Math.min(5, scale * factor));
    
    pan.x = mx - (mx - pan.x) * (newScale / scale);
    pan.y = my - (my - pan.y) * (newScale / scale);
    
    scale = newScale;
    updateTransform();
}, {passive:false});

els.mapStage.onmousedown = e => {
    e.preventDefault();
    const s = {x: e.clientX-pan.x, y: e.clientY-pan.y};
    const mv = m => { pan.x = m.clientX-s.x; pan.y = m.clientY-s.y; updateTransform(); };
    const up = () => { window.removeEventListener('mousemove',mv); window.removeEventListener('mouseup',up); };
    window.addEventListener('mousemove',mv); window.addEventListener('mouseup',up);
};

// Center Zoom logic
function zoomCenter(f) {
    const w = els.mapPanel.offsetWidth, h = els.mapPanel.offsetHeight;
    const cx = w/2, cy = h/2;
    const newScale = Math.max(1, Math.min(5, scale * f));
    pan.x = cx - (cx - pan.x) * (newScale / scale);
    pan.y = cy - (cy - pan.y) * (newScale / scale);
    scale = newScale;
    updateTransform();
}

document.getElementById('zoomIn').onclick = () => zoomCenter(1.2);
document.getElementById('zoomOut').onclick = () => zoomCenter(1/1.2);
document.getElementById('fitView').onclick = () => { scale=1; pan={x:0,y:0}; updateTransform(); };

function updateTransform(){
    const w = els.mapPanel.offsetWidth, h = els.mapPanel.offsetHeight;
    const sw = w*scale, sh = h*scale;
    if(pan.x > 0) pan.x = 0; if(pan.x < w - sw) pan.x = w - sw;
    if(pan.y > 0) pan.y = 0; if(pan.y < h - sh) pan.y = h - sh;
    els.mapStage.style.transform = \`translate(\${pan.x}px, \${pan.y}px) scale(\${scale})\`;
}

document.getElementById('submitBtn').onclick = () => {
    els.confirmText.textContent = 'בחרת במסלול '+heb(picked)+'. האם אתה בטוח?';
    els.confirmWarn.style.display = picked!==DATA.recommendedRoute ? 'block':'none';
    document.getElementById('confirmModal').classList.add('show');
};
document.getElementById('cancelConfirm').onclick = () => document.getElementById('confirmModal').classList.remove('show');
document.getElementById('doConfirm').onclick = () => { alert('הבחירה נשמרה!'); document.getElementById('confirmModal').classList.remove('show'); };

// Filters
els.filterBtn.onclick = () => {
    els.filterList.innerHTML = '';
    const hasActive = Object.values(filters).some(x=>!x);
    els.filterBtn.classList.toggle('has-active', hasActive);
    
    [{k:'routes',l:'מסלולים'},{k:'traffic',l:'עומס'},{k:'toll',l:'אגרה'},{k:'comm',l:'תקשורת'},{k:'parks',l:'פארקים'}].forEach(it=>{
        const div = document.createElement('div'); div.className='filterRow';
        div.innerHTML = \`<span>\${it.l}</span><button class="eyeBtn\${filters[it.k]?' on':''}" onclick="filters['\${it.k}']=!filters['\${it.k}']; drawMap(); this.classList.toggle('on'); document.getElementById('openFilter').classList.toggle('has-active', Object.values(filters).some(x=>!x))"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg></button>\`;
        els.filterList.appendChild(div);
    });
    document.getElementById('filterModal').classList.add('show');
};
document.getElementById('closeFilter').onclick = () => document.getElementById('filterModal').classList.remove('show');
document.getElementById('showAll').onclick = () => { for(let k in filters)filters[k]=true; drawMap(); els.filterBtn.click(); };
document.getElementById('hideAll').onclick = () => { for(let k in filters)filters[k]=false; drawMap(); els.filterBtn.click(); };

// Initial Render
selectRoute(picked);
try { drawMap(); } catch(e){}

</script>
</body>
</html>`;
}
/*
const exportParticipantHtml = useCallback(async () => {
        const mapInstance = mapRef.current;
        if (!mapInstance) {
            alert("המפה עדיין לא מוכנה.");
            return;
        }

        const canvas = mapInstance.getCanvas();
        // Capture exact dimensions
        const w = canvas.width;
        const h = canvas.height;
        const center = mapInstance.getCenter();
        const zoom = mapInstance.getZoom();
        
        let baseMapDataUrl = "";
        try {
            baseMapDataUrl = canvas.toDataURL("image/png");
        } catch (e) {
            console.warn("Could not export canvas", e);
        }

        if (!baseMapDataUrl || baseMapDataUrl.length < 10000) {
             alert("שגיאה: תמונת המפה ריקה. ודא שהוספת preserveDrawingBuffer: true בהגדרת המפה.");
        }

        // Flatten data for the HTML view
        const flatScores = routeScores.flatMap((r: any) => r.segments.map((s: any) => ({...s, route: r.route})));
        const currentBadges = badgesRef.current; 

        const html = buildParticipantHtml({
            scenarioName: exportScenarioName,
            taskText: exportTaskText,
            requirementsText: exportRequirementsText,
            requirementsText: exportRequirementsText,
            recommendedRoute: exportRecommendedRoute,
            vizType: exportVizType,
            baseMapDataUrl,
            mapView: { 
                width: w, 
                height: h, 
                zoom: zoom, 
                center: [center.lng, center.lat] 
            },
            start,
            end,
            routes: tripleLinesRef.current,
            badges: badgesRef.current,
            manualParks: manualParksRef.current,
            catTrafficSegs,
            catTollSegs,
            catTollLabels,
            catCommZones,
            routeScores: flatScores
        });

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const fileName = `${safeFileName(exportScenarioName)}_${stamp}.html`;

        try {
            if (exportSaveMode === "directory" && exportDirHandle) {
                const dir: any = exportDirHandle as any;
                const fileHandle = await dir.getFileHandle(fileName, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(html);
                await writable.close();
                const where = `${exportSavePath}/${fileName}`;
                setExportLastSaved(where);
                alert(`נשמר: ${where}`);
                return;
            }
        } catch { }

        downloadHtml(html, fileName);
        setExportLastSaved(`Downloads/${fileName}`);
        alert("הקובץ ירד.");

    }, [
        exportScenarioName, exportTaskText, exportRecommendedRoute, exportVizType, 
        start, end, routeScores, catTrafficSegs, catTollSegs, catTollLabels, 
        catCommZones, exportSaveMode, exportDirHandle, exportSavePath, downloadHtml
    ]);
*/
// --- 2. צעד 2: החלפת פונקציית הייצוא בקומפוננטה הראשית App ---
// חפש בתוך App את exportParticipantHtml והחלף אותה בזו:

/*
    const exportParticipantHtml = useCallback(async () => {
        const mapInstance = mapRef.current;
        if (!mapInstance) {
            alert("המפה עדיין לא מוכנה.");
            return;
        }

        const canvas = mapInstance.getCanvas();
        // Capture exact dimensions
        const w = canvas.width;
        const h = canvas.height;
        const center = mapInstance.getCenter();
        const zoom = mapInstance.getZoom();
        
        let baseMapDataUrl = "";
        try {
            baseMapDataUrl = canvas.toDataURL("image/png");
        } catch (e) {
            console.warn("Could not export canvas", e);
        }

        if (!baseMapDataUrl || baseMapDataUrl.length < 10000) {
             alert("שגיאה: תמונת המפה ריקה. ודא שהוספת preserveDrawingBuffer: true בהגדרת המפה.");
        }

        // Flatten data for the HTML view
        const flatScores = routeScores.flatMap((r: any) => r.segments.map((s: any) => ({...s, route: r.route})));
        const currentBadges = badgesRef.current; 

        const html = buildParticipantHtml({
            scenarioName: exportScenarioName,
            taskText: exportTaskText,
            recommendedRoute: exportRecommendedRoute,
            vizType: exportVizType,
            baseMapDataUrl,
            mapView: { 
                width: w, 
                height: h, 
                zoom: zoom, 
                center: [center.lng, center.lat] 
            },
            start,
            end,
            routes: tripleLinesRef.current,
            badges: badgesRef.current,
            manualParks: manualParksRef.current,
            catTrafficSegs,
            catTollSegs,
            catTollLabels,
            catCommZones,
            routeScores: flatScores
        });

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const fileName = `${safeFileName(exportScenarioName)}_${stamp}.html`;

        try {
            if (exportSaveMode === "directory" && exportDirHandle) {
                const dir: any = exportDirHandle as any;
                const fileHandle = await dir.getFileHandle(fileName, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(html);
                await writable.close();
                const where = `${exportSavePath}/${fileName}`;
                setExportLastSaved(where);
                alert(`נשמר: ${where}`);
                return;
            }
        } catch { }

        downloadHtml(html, fileName);
        setExportLastSaved(`Downloads/${fileName}`);
        alert("הקובץ ירד.");

    }, [
        exportScenarioName, exportTaskText, exportRecommendedRoute, exportVizType, 
        start, end, routeScores, catTrafficSegs, catTollSegs, catTollLabels, 
        catCommZones, exportSaveMode, exportDirHandle, exportSavePath, downloadHtml
    ]);
*/
// --------------------------------------------------------
// --- Update the Export Handler in App component ---
// --------------------------------------------------------

/*
  REPLACE the exportParticipantHtml function inside App component 
  with this updated version that captures Image Dimensions & Badges.
*/

/* // ... inside App component ... 
    const exportParticipantHtml = useCallback(async () => {
        const map = mapRef.current;
        if (!map) return;

        // 1. Capture Base Map Image
        // We need exact dimensions to prevent squashing
        const canvas = map.getCanvas();
        const w = canvas.width;
        const h = canvas.height;
        const center = map.getCenter();
        const zoom = map.getZoom();
        
        // Use toDataURL for snapshot
        const baseMapDataUrl = canvas.toDataURL("image/png");

        // 2. Prepare Data
        // Flatten route scores for simpler consumption
        const flatScores = routeScores.flatMap(r => r.segments.map(s => ({...s, route: r.route})));
        
        // Get badge positions
        const badgesExport = badgesRef.current; 

        // 3. Generate HTML
        const html = buildParticipantHtml({
            scenarioName: exportScenarioName,
            taskText: exportTaskText,
            recommendedRoute: exportRecommendedRoute,
            vizType: exportVizType,
            baseMapDataUrl,
            mapView: { 
                width: w, 
                height: h, 
                zoom: zoom, 
                center: [center.lng, center.lat] 
            },
            start,
            end,
            routes: tripleLinesRef.current,
            badges: badgesRef.current,
            manualParks: manualParksRef.current,
            catTrafficSegs,
            catTollSegs,
            catTollLabels,
            catCommZones,
            routeScores: flatScores
        });

        // 4. Save
        const fileName = \`\${safeFileName(exportScenarioName)}.html\`;
        downloadHtml(html, fileName); // Assuming downloadHtml helper exists as before

    }, [exportScenarioName, exportTaskText, exportRecommendedRoute, exportVizType, start, end, routeScores, catTrafficSegs, catTollSegs, catTollLabels, catCommZones]);
*/

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
    /*if (!map.getLayer("manual-parks-outline")) {
        map.addLayer({
            id: "manual-parks-outline",
            type: "line",
            source: "manual-parks",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#1e8f4d", "line-width": 2, "line-opacity": 0.9 },
        });
    }*/

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
                "circle-radius": 7,
                "circle-color": CAT_TOLL_COLOR,
                "circle-opacity": 0.95,
                "circle-stroke-color": "#000000",
                "circle-stroke-opacity": 0.85,
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
                "line-width": 6,
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

    // Derive toll markers from toll segments to keep things consistent (also used for manual add/delete).
    const buildTollLabelsFromSegs = useCallback((segs: { id: string; coords: LngLat[] }[]) => {
        const out: { coord: LngLat; side: "left" | "right" }[] = [];
        for (const s of segs) {
            const pts = pointsAlongLineEvery(s.coords, 250);
            pts.forEach((p, i) => out.push({ coord: p, side: i % 2 === 0 ? "left" : "right" }));
        }
        return out;
    }, []);

    useEffect(() => {
        setCatTollLabels(buildTollLabelsFromSegs(catTollSegs));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [catTollSegs]);
    const [catCommZones, setCatCommZones] = useState<{ id: string; ring: LngLat[]; radiusM: number }[]>([]);

    const catTrafficSegsRef = useRef(catTrafficSegs);
    const catTollSegsRef = useRef(catTollSegs);
    const catCommZonesRef = useRef(catCommZones);
    useEffect(() => { catTrafficSegsRef.current = catTrafficSegs; }, [catTrafficSegs]);
    useEffect(() => { catTollSegsRef.current = catTollSegs; }, [catTollSegs]);
    useEffect(() => { catCommZonesRef.current = catCommZones; }, [catCommZones]);


    // ✅ Sync spatial categories to map sources (so they appear in the planning app, not only in exported HTML)
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        setFC(map, "cat-traffic", fcLines(catTrafficSegs.map((s) => ({ coords: s.coords, props: { id: s.id } }))));
    }, [catTrafficSegs]);

    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        setFC(map, "cat-toll", fcLines(catTollSegs.map((s) => ({ coords: s.coords, props: { id: s.id } }))));
    }, [catTollSegs]);

    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        setFC(map, "cat-toll-labels", fcPoints(catTollLabels.map((l) => l.coord), catTollLabels.map((l) => ({ label: "₪", side: l.side }))));
    }, [catTollLabels]);

    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        setFC(map, "cat-comm", fcPolygons(catCommZones.map((z) => ({ coords: z.ring, props: { id: z.id, radiusM: z.radiusM } }))));
    }, [catCommZones]);

    // RESULTS panel (route scoring)
    const [routeScores, setRouteScores] = useState<RouteScore[]>([]);
    const [showResults, setShowResults] = useState(false);

    const [uiToast, setUiToast] = useState<string | null>(null);
    const toastTimerRef = useRef<number | null>(null);
    const showToast = useCallback((msg: string) => {
        setUiToast(msg);
        if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = window.setTimeout(() => setUiToast(null), 2200);
    }, []);

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


    // --- Export results to CSV (for external Excel analysis) ---
    const exportResultsToCsv = useCallback(() => {
        if (!routeScores || routeScores.length === 0) {
            alert("אין נתונים לייצוא. לחץ/י קודם על 'הצג תוצאות' כדי לחשב נתונים.");
            return;
        }

        const delim = ";"; // safer for Excel locales where decimal separator is ','
        const esc = (v: unknown) => {
            const s = v === null || v === undefined ? "" : String(v);
            const needsWrap = s.includes('"') || s.includes("\n") || s.includes("\r") || s.includes(delim);
            const out = s.replace(/"/g, '""');
            return needsWrap ? `"${out}"` : out;
        };

        const safeNum = (n: unknown, digits = 2) => {
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
            "שיקלול_0_100",
            "משקולת",
            "עומס_share",
            "אגרה_share",
            "נוף_share",
            "קליטה_share",
        ];

        const order: Record<string, number> = { A: 1, B: 2, C: 3 };
        const sorted: RouteScore[] = [...routeScores].sort((a, b) => (order[a.route] ?? 99) - (order[b.route] ?? 99));

        // time stats per segment across all routes (for time normalization)
        const timeStats: Record<1 | 2 | 3, { min: number; max: number }> = {
            1: { min: Infinity, max: -Infinity },
            2: { min: Infinity, max: -Infinity },
            3: { min: Infinity, max: -Infinity },
        };
        sorted.forEach((rs) => {
            rs.segments.forEach((seg) => {
                const segNo = seg.segment;
                const t = Number(seg.timeS ?? 0);
                if (Number.isFinite(t)) {
                    timeStats[segNo].min = Math.min(timeStats[segNo].min, t);
                    timeStats[segNo].max = Math.max(timeStats[segNo].max, t);
                }
            });
        });

        const timeScore0100 = (segNo: 1 | 2 | 3, timeS: number) => {
            const mn = timeStats[segNo].min;
            const mx = timeStats[segNo].max;
            if (!Number.isFinite(mn) || !Number.isFinite(mx) || mx <= mn + 1e-6) return 100;
            const v = (mx - timeS) / (mx - mn);
            return Math.max(0, Math.min(100, v * 100));
        };

        const scoreByCat = (seg: SegmentScore, cat: TaskCat) => {
            switch (cat) {
                case "מהיר":
                    return Number(seg.speedScore ?? 0);
                case "חסכוני":
                    return Number(seg.economyScore ?? 0);
                case "נופי":
                    return Number(seg.scenicScore ?? 0);
                case "מחובר":
                    return Number(seg.commScore ?? 0);
                default:
                    return 0;
            }
        };

        const weightText =
            taskMode === "Weighted"
                ? `${taskPrimaryCat}×${taskWPrimary}${taskSecondaryCat !== "None" ? ` + ${taskSecondaryCat}×${taskWSecondary}` : ""} + זמן×${taskWTime}`
                : "ללא";

        const shiklul0100 = (seg: SegmentScore) => {
            const tScore = timeScore0100(seg.segment, Number(seg.timeS ?? 0));

            if (taskMode !== "Weighted") {
                const a = Number(seg.speedScore ?? 0);
                const b = Number(seg.economyScore ?? 0);
                const c = Number(seg.scenicScore ?? 0);
                const d = Number(seg.commScore ?? 0);
                return Math.round((a + b + c + d) / 4);
            }

            const p = scoreByCat(seg, taskPrimaryCat);
            const s = taskSecondaryCat === "None" ? 0 : scoreByCat(seg, taskSecondaryCat);
            const wp = Number(taskWPrimary ?? 0);
            const ws = taskSecondaryCat === "None" ? 0 : Number(taskWSecondary ?? 0);
            const wt = Number(taskWTime ?? 0);
            const denom = Math.max(1e-6, wp + ws + wt);
            return Math.round((wp * p + ws * s + wt * tScore) / denom);
        };

        const lines: string[] = [];
        lines.push(header.map(esc).join(delim));

        sorted.forEach((rs) => {
            const segs = rs.segments;

            segs.forEach((seg) => {
                const segLabel = `מקטע ${seg.segment}`;

                lines.push(
                    [
                        rs.route,
                        segLabel,
                        safeNum(seg.lengthM, 0),
                        safeNum(seg.timeS, 0),
                        safeNum(seg.timeS / 60, 2),
                        safeNum(seg.speedScore, 2),
                        safeNum(seg.economyScore, 2),
                        safeNum(seg.scenicScore, 2),
                        safeNum(seg.commScore, 2),
                        safeNum(shiklul0100(seg), 0),
                        weightText,
                        safeNum(seg.fracTraffic, 3),
                        safeNum(seg.fracToll, 3),
                        safeNum(seg.fracScenic, 3),
                        safeNum(seg.fracComm, 3),
                    ].map(esc).join(delim)
                );
            });

            // summary row (weighted by length)
            const totalLenM = segs.reduce((acc, s) => acc + (typeof s.lengthM === "number" ? s.lengthM : 0), 0);
            const totalTimeS = segs.reduce((acc, s) => acc + (typeof s.timeS === "number" ? s.timeS : 0), 0);
            const avgSpeed = weightedAvg(segs.map((s) => ({ w: Number(s.lengthM) || 0, v: Number(s.speedScore) || 0 })));
            const avgEcon = weightedAvg(segs.map((s) => ({ w: Number(s.lengthM) || 0, v: Number(s.economyScore) || 0 })));
            const avgScenic = weightedAvg(segs.map((s) => ({ w: Number(s.lengthM) || 0, v: Number(s.scenicScore) || 0 })));
            const avgComm = weightedAvg(segs.map((s) => ({ w: Number(s.lengthM) || 0, v: Number(s.commScore) || 0 })));
            const avgShiklul = weightedAvg(segs.map((s) => ({ w: Number(s.lengthM) || 0, v: Number(shiklul0100(s)) || 0 })));

            lines.push(
                [
                    rs.route,
                    "סה\"כ",
                    safeNum(totalLenM, 0),
                    safeNum(totalTimeS, 0),
                    safeNum(totalTimeS / 60, 2),
                    safeNum(avgSpeed, 2),
                    safeNum(avgEcon, 2),
                    safeNum(avgScenic, 2),
                    safeNum(avgComm, 2),
                    safeNum(avgShiklul, 0),
                    weightText,
                    "",
                    "",
                    "",
                    "",
                ].map(esc).join(delim)
            );
        });

        const csvText = "\ufeff" + lines.join("\n"); // UTF-8 BOM for Hebrew in Excel
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

    // שער פסילה: אם קטגוריה "חובה" לא קיימת (למשל 0% כיסוי), המסלול נפסל – אלא אם אין אף מסלול שעובר את השער.
    const [taskGateMinFrac, setTaskGateMinFrac] = useState<number>(0);

    // שובר שוויון
    const [taskTieBreaker, setTaskTieBreaker] = useState<"זמן" | "מהירות">("זמן");

    // אפשר לבחור ידנית על מי "נרצה" לפייבר – אחרת אוטומטי (בחירה לפי זמן בסיסי)
    const [taskFavorRoute, setTaskFavorRoute] = useState<"Auto" | RouteId>("Auto");

    // תוצאה
    const [taskWinnerRoute, setTaskWinnerRoute] = useState<RouteId | null>(null);
    const [taskWinnerNote, setTaskWinnerNote] = useState<string>("");
    const lastTaskUpdateSigRef = useRef<string>("");
    // ---- Export participant screen ----
    const DEBUG_LOG_FILENAME = "GeoVisLab_DebugLog.json";

    const [exportOpen, setExportOpen] = useState(false);
    const [exportScenarioName, setExportScenarioName] = useState(() => {
        const d = new Date();
        const ymd = d.toISOString().slice(0, 10);
        return `Scenario_${ymd}_${Date.now()}`;
    });
    const [exportTaskText, setExportTaskText] = useState(
        "בחר את המסלול המיטבי לאור הדרישות. ניתן לעיין במפה ובפירוט המקטעים למטה לפני קבלת החלטה."
    );
    const [exportRequirementsText, setExportRequirementsText] = useState<string>("");
    const [exportVizType, setExportVizType] = useState<ExportVizType>("STACKED");
    const [exportRecommendedRoute, setExportRecommendedRoute] = useState<"A" | "B" | "C">("A");

    const [exportSaveMode, setExportSaveMode] = useState<ExportSaveMode>("downloads");
    const [exportDirHandle, setExportDirHandle] = useState<unknown>(null);
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

    type EntityDrawMode = null | "traffic" | "toll" | "comm";
    type DeleteCatMode = null | "traffic" | "toll" | "comm" | "park";

    const [entityDrawMode, setEntityDrawMode] = useState<EntityDrawMode>(null);
    const entityDrawModeRef = useRef<EntityDrawMode>(null);
    useEffect(() => { entityDrawModeRef.current = entityDrawMode; }, [entityDrawMode]);

    const [draftEntityPts, setDraftEntityPts] = useState<LngLat[]>([]);
    const draftEntityPtsRef = useRef<LngLat[]>([]);
    useEffect(() => { draftEntityPtsRef.current = draftEntityPts; }, [draftEntityPts]);

    const [draftCommCenter, setDraftCommCenter] = useState<LngLat | null>(null);
    const draftCommCenterRef = useRef<LngLat | null>(null);
    useEffect(() => { draftCommCenterRef.current = draftCommCenter; }, [draftCommCenter]);

    const [deleteCatMode, setDeleteCatMode] = useState<DeleteCatMode>(null);
    const deleteCatModeRef = useRef<DeleteCatMode>(null);
    useEffect(() => { deleteCatModeRef.current = deleteCatMode; }, [deleteCatMode]);
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
            const isPark = isDrawingParkRef.current;
            const mode = entityDrawModeRef.current;

            if (!isPark && !mode) return;

            if (e.key === "Escape") {
                e.preventDefault();
                if (isPark) {
                    setDraftParkPts([]);
                    draftMouseRef.current = null;
                    setIsDrawingPark(false);
                }
                if (mode) {
                    setDraftEntityPts([]);
                    setDraftCommCenter(null);
                    setEntityDrawMode(null);
                }
                setDeleteCatMode(null);
                return;
            }

            if (e.key === "Delete" || e.key === "Backspace") {
                e.preventDefault();
                if (isPark) {
                    setDraftParkPts((prev) => prev.slice(0, Math.max(0, prev.length - 1)));
                }
                if (mode) {
                    if (mode === "comm") {
                        // undo center selection (circle is created on 2nd click)
                        setDraftCommCenter(null);
                    } else {
                        setDraftEntityPts((prev) => prev.slice(0, Math.max(0, prev.length - 1)));
                    }
                }
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
                const labelPts = pointsAlongLineEvery(seg, 250);
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

        // --- 1) Compute scores from *manual* entities (no automatic placement) ---
        const finalScores = computeRouteScores(
            map,
            lines,
            catTrafficSegsRef.current,
            catTollSegsRef.current,
            catCommZonesRef.current,
            manualParksRef.current
        );

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

            // Delete mode: click an entity to delete it (one at a time)
            const delMode = deleteCatModeRef.current;
            if (delMode) {
                const map = mapRef.current;
                if (!map) return;

                const p = ev.point;
                const bbox: [maplibregl.PointLike, maplibregl.PointLike] = [
                    [p.x - 6, p.y - 6],
                    [p.x + 6, p.y + 6],
                ];

                const layers =
                    delMode === "traffic"
                        ? ["cat-traffic"]
                        : delMode === "toll"
                            ? ["cat-toll-left", "cat-toll-right"]
                            : delMode === "comm"
                                ? ["cat-comm-fill"]
                                : delMode === "park"
                                    ? ["manual-parks-fill"]
                                    : [];

                const feats = (layers.length ? map.queryRenderedFeatures(bbox, { layers }) : []) as any[];
                const id = ((feats && feats[0] && (feats[0].properties as any)?.id) as string) || "";

                if (!id) {
                    showToast("לא נמצאה ישות למחיקה. נסה ללחוץ על הישות עצמה.");
                    return;
                }

                if (delMode === "traffic") {
                    setCatTrafficSegs((prev) => prev.filter((s) => s.id !== id));
                    showToast("נמחק מקטע עומס.");
                } else if (delMode === "toll") {
                    setCatTollSegs((prev) => prev.filter((s) => s.id !== id));
                    showToast("נמחק מקטע אגרה.");
                } else if (delMode === "comm") {
                    setCatCommZones((prev) => prev.filter((z) => z.id !== id));
                    showToast("נמחק אזור תקשורת.");
                } else if (delMode === "park") {
                    setManualParks((prev) => prev.filter((pp) => pp.id !== id));
                    showToast("נמחק פארק.");
                }

                return;
            }

            // Manual entity drawing mode
            const drawMode = entityDrawModeRef.current;
            if (drawMode) {
                const map = mapRef.current;
                if (!map) return;

                if (drawMode === "comm") {
                    if (!draftCommCenterRef.current) {
                        setDraftCommCenter(ll);
                        showToast("מרכז נקבע. לחץ שוב כדי לקבוע רדיוס.");
                    } else {
                        const center = draftCommCenterRef.current;
                        const r = haversineMeters(center, ll);
                        if (r < 20) {
                            showToast("רדיוס קטן מדי. נסה לבחור נקודה רחוקה יותר.");
                            return;
                        }
                        const ring = circleRing(center, r);
                        const id = `comm_manual_${Date.now()}`;
                        setCatCommZones((prev) => [...prev, { id, ring, radiusM: r }]);
                        setDraftCommCenter(null);
                        setEntityDrawMode(null);
                        showToast("אזור תקשורת נוסף.");
                    }
                    return;
                }

                // traffic / toll polyline: snap clicks to nearby road vertex
                const snapToNearestRoadVertex = () => {
                    const p = ev.point;
                    const bbox: [maplibregl.PointLike, maplibregl.PointLike] = [
                        [p.x - 10, p.y - 10],
                        [p.x + 10, p.y + 10],
                    ];
                    const feats = map.queryRenderedFeatures(bbox) as any[];
                    let best: LngLat | null = null;
                    let bestD = Infinity;

                    for (const f of feats) {
                        const geom = f.geometry;
                        if (!geom) continue;
                        const t = geom.type;
                        if (t !== "LineString" && t !== "MultiLineString") continue;

                        const coords: any[] =
                            t === "LineString" ? geom.coordinates : (geom.coordinates || []).flat(1);

                        for (const c of coords) {
                            if (!Array.isArray(c) || c.length < 2) continue;
                            const pt = map.project({ lng: c[0], lat: c[1] } as any);
                            const dx = pt.x - p.x;
                            const dy = pt.y - p.y;
                            const d2 = dx * dx + dy * dy;
                            if (d2 < bestD) {
                                bestD = d2;
                                best = [c[0], c[1]];
                            }
                        }
                    }

                    // require reasonably close to a road (<= ~14px)
                    return bestD <= 14 * 14 ? best : null;
                };

                const snapped = snapToNearestRoadVertex();
                if (!snapped) {
                    showToast("לא ניתן למקם נקודה לא על ציר. התקרב לכביש ונסה שוב.");
                    return;
                }

                setDraftEntityPts((prev) => [...prev, snapped]);
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
            const drawMode = entityDrawModeRef.current;
            if (drawMode === "traffic" || drawMode === "toll") {
                ev.preventDefault();
                const pts = draftEntityPtsRef.current;
                if (!pts || pts.length < 2) {
                    showToast("צריך לפחות 2 נקודות כדי לסיים מקטע.");
                    return;
                }
                const id = `${drawMode}_manual_${Date.now()}`;
                if (drawMode === "traffic") {
                    setCatTrafficSegs((prev) => [...prev, { id, coords: pts }]);
                    showToast("מקטע עומס נוסף.");
                } else {
                    setCatTollSegs((prev) => [...prev, { id, coords: pts }]);
                    showToast("מקטע אגרה נוסף.");
                }
                setDraftEntityPts([]);
                setEntityDrawMode(null);
                return;
            }

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

                const tickLenMeters = 50; // אותו אורך שכבר יש לך (אפשר לשנות)
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

        const tickLenMeters = 50;
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

            const tickLenMeters = 50;
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
    const downloadBlobAsFile = useCallback((fileName: string, blob: Blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }, []);

    const exportDebugLog = useCallback(() => {
        const map = mapRef.current;
        const center = map?.getCenter ? map.getCenter() : null;
        const canvas = map?.getCanvas ? map.getCanvas() : null;

        const log = {
            version: "GeoVisLab DebugLog v1",
            createdAt: new Date().toISOString(),
            scenarioName: exportScenarioName,
            taskText: exportTaskText,
            recommendedRoute: exportRecommendedRoute,
            vizType: exportVizType,
            mapView: map
                ? {
                    center: center ? ([center.lng, center.lat] as LngLat) : null,
                    zoom: map.getZoom ? map.getZoom() : null,
                    bearing: map.getBearing ? map.getBearing() : null,
                    pitch: map.getPitch ? map.getPitch() : null,
                    width: canvas?.width ?? null,
                    height: canvas?.height ?? null,
                }
                : null,
            start,
            end,
            selectedRoute,
            routes: tripleLinesRef.current,
            routeScores,
            spatial: {
                traffic: catTrafficSegs,
                toll: { segments: catTollSegs, labels: catTollLabels },
                comm: catCommZones,
                parks: manualParks,
            },
            taskParams: {
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
                taskTieBreaker,
                taskFavorRoute,
                taskWinnerRoute,
                taskWinnerNote,
            },
            generation: {
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
            },
        };

        const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json;charset=utf-8;" });
        downloadBlobAsFile(DEBUG_LOG_FILENAME, blob);
        showToast(`נוצר לוג: ${DEBUG_LOG_FILENAME}`);
    }, [
        DEBUG_LOG_FILENAME,
        downloadBlobAsFile,
        exportScenarioName,
        exportTaskText,
        exportRequirementsText,
        exportRecommendedRoute,
        exportVizType,
        start,
        end,
        selectedRoute,
        routeScores,
        catTrafficSegs,
        catTollSegs,
        catTollLabels,
        catCommZones,
        manualParks,
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
        taskTieBreaker,
        taskFavorRoute,
        taskWinnerRoute,
        taskWinnerNote,
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
        showToast,
    ]);



    const exportParticipantHtml = useCallback(async () => {
        const map = mapRef.current;
        if (!map) {
            alert("המפה עדיין לא מוכנה.");
            return;
        }

        // Capture an offline base-map snapshot
        const EXPORT_HIDE_LAYERS: string[] = [
            'triple-a', 'triple-b', 'triple-c', 'triple-a-outline', 'triple-b-outline', 'triple-c-outline',
            'triple-badge-lines', 'triple-badges', 'triple-badge-text',
            'triple-seg-ticks', 'triple-seg-circles', 'triple-seg-text',
            'cat-traffic', 'cat-traffic-glow',
            'cat-toll', 'cat-toll-label-bg', 'cat-toll-label-text',
            'cat-comm-fill', 'cat-comm-outline',
            'manual-parks-fill', 'manual-parks-outline',
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

        // Fallback capture logic omitted for brevity (it's fine as is in your code)
        // ...

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
            requirementsText: exportRequirementsText,
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
            routeScores: routeScores.flatMap(r => r.segments),
            badges: badgesRef.current, // <--- התיקון כאן: העבר את badgesRef.current במקום []
        });

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const fileName = `${safeFileName(exportScenarioName)}_${stamp}.html`;

        try {
            if (exportSaveMode === "directory" && exportDirHandle) {
                const dir: any = exportDirHandle as any;
                const fileHandle = await dir.getFileHandle(fileName, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(html);
                await writable.close();

                const where = `${exportSavePath}/${fileName}`;
                setExportLastSaved(where);
                alert(`הקובץ נשמר בתיקייה שנבחרה: ${where}`);
                return;
            }
        } catch { }

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
        exportRequirementsText,
        exportVizType,
        routeScores,
        start,
        // הוסף את badgesRef לרשימת התלויות אם ה-Linter דורש זאת, אך זה לא קריטי ב-useCallback עם Refs
    ]);

    return (
        <div style={{ display: "flex", width: "100vw", height: "100vh", overflow: "hidden" }}>
            {/* --- תדביק את זה כאן, מיד בהתחלה --- */}
            <style>{`
                * {
                    font-family: "Arial", sans-serif !important;
                }
            `}</style>
            {/* ----------------------------------- */}
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
                            position: "fixed",
                            inset: 0,
                            background: "rgba(0,0,0,0.58)",
                            zIndex: 10000,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            padding: 16,
                            direction: "rtl",
                        }}
                        onMouseDown={() => setShowResults(false)}
                    >
                        <div
                            style={{
                                width: 1100,
                                maxWidth: "96vw",
                                background: "rgba(10, 14, 22, 0.98)",
                                border: "1px solid rgba(255,255,255,0.15)",
                                borderRadius: 14,
                                boxShadow: "0 18px 46px rgba(0,0,0,0.55)",
                                overflow: "hidden",
                                color: "white",
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                        >
                            {/* Header (always visible) */}
                            <div
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    padding: "10px 12px",
                                    borderBottom: "1px solid rgba(255,255,255,0.12)",
                                    background: "rgba(10, 14, 22, 0.98)",
                                }}
                            >
                                <div style={{ fontWeight: 900, fontSize: 16 }}>תוצאות</div>

                                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                    <button
                                        onClick={exportResultsToCsv}
                                        disabled={!routeScores || routeScores.length === 0}
                                        title={!routeScores || routeScores.length === 0 ? "אין נתונים לייצוא" : "ייצוא טבלת התוצאות לקובץ CSV"}
                                        style={{
                                            padding: "8px 12px",
                                            borderRadius: 10,
                                            border: "1px solid rgba(255,255,255,0.18)",
                                            background: !routeScores || routeScores.length === 0 ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.10)",
                                            color: "white",
                                            cursor: !routeScores || routeScores.length === 0 ? "not-allowed" : "pointer",
                                            opacity: !routeScores || routeScores.length === 0 ? 0.55 : 1,
                                            fontWeight: 900,
                                        }}
                                    >
                                        ייצא CSV
                                    </button>

                                    <button
                                        onClick={() => setShowResults(false)}
                                        style={{
                                            padding: "8px 12px",
                                            borderRadius: 10,
                                            border: "1px solid rgba(255,255,255,0.18)",
                                            background: "rgba(255,255,255,0.06)",
                                            color: "white",
                                            cursor: "pointer",
                                            fontWeight: 900,
                                        }}
                                    >
                                        סגור
                                    </button>
                                </div>
                            </div>

                            {/* Body (scroll only if absolutely needed) */}
                            <div style={{ padding: 12, maxHeight: "82vh", overflow: "auto" }}>
                                {(() => {
                                    const km = (m: number) => (m / 1000).toFixed(2);
                                    const mins = (s: number) => (s / 60).toFixed(1);
                                    const sc = (x: number) => Math.round(x);

                                    const scoreByCat = (sg: any, cat: any) => {
                                        switch (cat) {
                                            case "מהיר":
                                                return Number(sg?.speedScore ?? 0);
                                            case "חסכוני":
                                                return Number(sg?.economyScore ?? 0);
                                            case "נופי":
                                                return Number(sg?.scenicScore ?? 0);
                                            case "מחובר":
                                                return Number(sg?.commScore ?? 0);
                                            default:
                                                return 0;
                                        }
                                    };

                                    // time score per segment across routes (0..100)
                                    const timeStats = { 1: { min: Infinity, max: -Infinity }, 2: { min: Infinity, max: -Infinity }, 3: { min: Infinity, max: -Infinity } } as any;
                                    (routeScores || []).forEach((rs: any) => {
                                        (rs.segments || []).forEach((sg: any) => {
                                            const seg = Number(sg.segment);
                                            if (seg === 1 || seg === 2 || seg === 3) {
                                                const t = Number(sg.timeS ?? 0);
                                                if (Number.isFinite(t)) {
                                                    timeStats[seg].min = Math.min(timeStats[seg].min, t);
                                                    timeStats[seg].max = Math.max(timeStats[seg].max, t);
                                                }
                                            }
                                        });
                                    });

                                    const timeScore0100 = (segNo: 1 | 2 | 3, timeS: number) => {
                                        const mn = timeStats[segNo].min;
                                        const mx = timeStats[segNo].max;
                                        if (!Number.isFinite(mn) || !Number.isFinite(mx) || mx <= mn + 1e-6) return 100;
                                        const v = (mx - timeS) / (mx - mn);
                                        return Math.max(0, Math.min(100, v * 100));
                                    };

                                    const weightText =
                                        taskMode === "Weighted"
                                            ? `${taskPrimaryCat}×${taskWPrimary}${taskSecondaryCat !== "None" ? ` + ${taskSecondaryCat}×${taskWSecondary}` : ""} + זמן×${taskWTime}`
                                            : "ללא";

                                    const shiklul0100 = (sg: any) => {
                                        const segNo = Number(sg.segment) as 1 | 2 | 3;
                                        const tScore = timeScore0100(segNo, Number(sg.timeS ?? 0));

                                        if (taskMode !== "Weighted") {
                                            // simple average (placeholder) – future formula can replace this
                                            const a = Number(sg.speedScore ?? 0);
                                            const b = Number(sg.economyScore ?? 0);
                                            const c = Number(sg.scenicScore ?? 0);
                                            const d = Number(sg.commScore ?? 0);
                                            return Math.round((a + b + c + d) / 4);
                                        }

                                        const p = scoreByCat(sg, taskPrimaryCat);
                                        const s = taskSecondaryCat === "None" ? 0 : scoreByCat(sg, taskSecondaryCat);
                                        const wp = Number(taskWPrimary ?? 0);
                                        const ws = taskSecondaryCat === "None" ? 0 : Number(taskWSecondary ?? 0);
                                        const wt = Number(taskWTime ?? 0);

                                        const denom = Math.max(1e-6, wp + ws + wt);
                                        const val = (wp * p + ws * s + wt * tScore) / denom;
                                        return Math.round(val);
                                    };

                                    const avgShiklulRoute = (rs: any) => {
                                        const segs = Array.isArray(rs.segments) ? rs.segments : [];
                                        if (!segs.length) return 0;
                                        const wsum = segs.reduce((acc: number, sg: any) => acc + Number(sg.lengthM ?? 0), 0) || segs.length;
                                        const num = segs.reduce((acc: number, sg: any) => acc + (Number(sg.lengthM ?? 0) || 1) * shiklul0100(sg), 0);
                                        return Math.round(num / wsum);
                                    };

                                    const thBase: any = {
                                        textAlign: "right",
                                        padding: "8px 8px",
                                        borderBottom: "1px solid rgba(255,255,255,0.15)",
                                        fontWeight: 900,
                                        whiteSpace: "nowrap",
                                    };

                                    const tdBase: any = { padding: "8px 8px", borderBottom: "1px solid rgba(255,255,255,0.08)", textAlign: "right" };

                                    const dividerL = { borderLeft: "2px solid rgba(255,255,255,0.22)" };

                                    return (
                                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, tableLayout: "fixed" }}>
                                            <colgroup>
                                                <col style={{ width: 90 }} />
                                                <col style={{ width: 95 }} />
                                                <col style={{ width: 90 }} />
                                                <col style={{ width: 90 }} />
                                                <col style={{ width: 90 }} />
                                                <col style={{ width: 90 }} />
                                                <col style={{ width: 90 }} />
                                                <col style={{ width: 160 }} />
                                                <col style={{ width: 95 }} />
                                            </colgroup>
                                            <thead>
                                                <tr style={{ background: "rgba(255,255,255,0.04)" }}>
                                                    <th style={thBase}>מקטע</th>
                                                    <th style={thBase}>אורך (ק״מ)</th>
                                                    <th style={thBase}>זמן (דק׳)</th>
                                                    <th style={{ ...thBase, ...dividerL, background: "rgba(59,130,246,0.10)" }}>מהירות</th>
                                                    <th style={{ ...thBase, background: "rgba(245,158,11,0.10)" }}>חסכון</th>
                                                    <th style={{ ...thBase, background: "rgba(34,197,94,0.10)" }}>נוף</th>
                                                    <th style={{ ...thBase, background: "rgba(170,60,255,0.10)" }}>קליטה</th>
                                                    <th style={{ ...thBase, ...dividerL }}>משקולת</th>
                                                    <th style={thBase}>שיקלול</th>
                                                </tr>
                                            </thead>

                                            <tbody>
                                                {(routeScores || []).map((rs: any) => (
                                                    <Fragment key={rs.route}>
                                                        <tr>
                                                            <td
                                                                colSpan={9}
                                                                style={{
                                                                    padding: "10px 8px",
                                                                    fontWeight: 900,
                                                                    borderBottom: "1px solid rgba(255,255,255,0.10)",
                                                                    background: "rgba(255,255,255,0.03)",
                                                                }}
                                                            >
                                                                מסלול {rs.route}
                                                            </td>
                                                        </tr>

                                                        {(rs.segments || []).map((sg: any) => (
                                                            <tr key={`${rs.route}-${sg.segment}`}>
                                                                <td style={tdBase}>מקטע {sg.segment}</td>
                                                                <td style={tdBase}>{km(Number(sg.lengthM ?? 0))}</td>
                                                                <td style={tdBase}>{mins(Number(sg.timeS ?? 0))}</td>
                                                                <td style={{ ...tdBase, ...dividerL }}>{sc(Number(sg.speedScore ?? 0))}</td>
                                                                <td style={tdBase}>{sc(Number(sg.economyScore ?? 0))}</td>
                                                                <td style={tdBase}>{sc(Number(sg.scenicScore ?? 0))}</td>
                                                                <td style={tdBase}>{sc(Number(sg.commScore ?? 0))}</td>
                                                                <td style={{ ...tdBase, ...dividerL, fontSize: 11, opacity: 0.95 }}>{weightText}</td>
                                                                <td style={{ ...tdBase, fontWeight: 900 }}>{shiklul0100(sg)}</td>
                                                            </tr>
                                                        ))}

                                                        <tr style={{ background: "rgba(255,255,255,0.05)" }}>
                                                            <td style={{ ...tdBase, fontWeight: 900 }}>סה״כ</td>
                                                            <td style={{ ...tdBase, fontWeight: 900 }}>{km(Number(rs.totalLengthM ?? 0))}</td>
                                                            <td style={{ ...tdBase, fontWeight: 900 }}>{mins(Number(rs.totalTimeS ?? 0))}</td>
                                                            <td style={{ ...tdBase, ...dividerL, fontWeight: 900 }}>—</td>
                                                            <td style={{ ...tdBase, fontWeight: 900 }}>—</td>
                                                            <td style={{ ...tdBase, fontWeight: 900 }}>—</td>
                                                            <td style={{ ...tdBase, fontWeight: 900 }}>—</td>
                                                            <td style={{ ...tdBase, ...dividerL, fontWeight: 900 }}>—</td>
                                                            <td style={{ ...tdBase, fontWeight: 900 }}>{avgShiklulRoute(rs)}</td>
                                                        </tr>
                                                    </Fragment>
                                                ))}
                                            </tbody>
                                        </table>
                                    );
                                })()}
                            </div>
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
                <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                    <div style={{ fontWeight: 900, marginBottom: 10 }}> בחר פעולה</div>

                    {/* טוגל כפתורים */}
                    <div style={{
                        display: "flex",
                        background: "rgba(0,0,0,0.25)",
                        borderRadius: 10,
                        padding: 4,
                        gap: 4,
                        margin: "0 auto 12px auto"
                    }}>
                        {[
                            { id: "TRIPLE" as const, label: "3 מסלולים" },
                            { id: "SINGLE" as const, label: "מסלול יחיד" },
                            { id: "MEASURE" as const, label: "מדידה" },
                        ].map((b) => {
                            const isActive = b.id === "TRIPLE" ? mode === "TRIPLE" : mode === b.id;
                            const isArmed = b.id === "TRIPLE" && triplePickArmed;

                            return (
                                <button
                                    key={b.id}
                                    onClick={() => {
                                        if (b.id === "TRIPLE") {
                                            if (mode !== "TRIPLE") { setMode("TRIPLE"); setTriplePickArmed(true); }
                                            else { setTriplePickArmed(v => !v); }
                                        } else {
                                            setMode(b.id);
                                            setTriplePickArmed(false);
                                        }
                                    }}
                                    style={{
                                        flex: 1, padding: "8px 0", borderRadius: 8, border: "none",
                                        background: isActive ? (isArmed ? "rgba(59, 130, 246, 0.9)" : "rgba(255,255,255,0.15)") : "transparent",
                                        color: isActive ? "#fff" : "rgba(255,255,255,0.6)",
                                        cursor: "pointer", fontWeight: isActive ? 800 : 600, fontSize: 13
                                    }}
                                >
                                    {b.label}
                                </button>
                            );
                        })}
                    </div>

                    {/* תוכן משתנה לפי מצב */}
                    <div style={{ paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.1)" }}>
                        {mode === "TRIPLE" && (
                            <div style={{ fontSize: 13, opacity: 0.9 }}>
                                סטטוס בחירה: <b>{triplePickArmed ? "פעיל" : "ממתין"}</b> (קליק ראשון=מוצא, שני=יעד).
                                {start && end && <div style={{ color: "#4ade80", fontWeight: 700, marginTop: 4 }}>✓ נבחרו נקודות.</div>}
                            </div>
                        )}
                        {mode === "SINGLE" && (
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                                <span>נקודות: <b>{singleWaypoints.length}</b>, מרחק: <b>{fmtDistance(singleDist)}</b></span>
                                <button onClick={clearSingle} style={{ padding: "2px 8px", borderRadius: 4, background: "rgba(255,255,255,0.1)", color: "white", border: "none", cursor: "pointer" }}>ניקוי</button>
                            </div>
                        )}
                        {mode === "MEASURE" && (
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                                <span>מרחק מצטבר: <b>{fmtDistance(measureDist)}</b></span>
                                <button onClick={clearMeasure} style={{ padding: "2px 8px", borderRadius: 4, background: "rgba(255,255,255,0.1)", color: "white", border: "none", cursor: "pointer" }}>ניקוי</button>
                            </div>
                        )}
                    </div>
                </div>





                {/* TRIPLE flow */}
                {mode === "TRIPLE" && (
                    <>

                        <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                            <div style={{ fontWeight: 900, marginBottom: 6 }}>שלב 1: פרמטרים וחישוב</div>

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
                            <div style={{ fontWeight: 900, marginBottom: 6 }}>שלב 2: בחירת מסלול</div>
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
                            <div style={{ fontWeight: 900, marginBottom: 6 }}>שלב 3: עריכת מסלולים</div>

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
                            <div style={{ fontWeight: 900, marginBottom: 4 }}>שלב 4: עריכה ידנית של ישויות</div>
                            <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 12, lineHeight: 1.4 }}>
                                הוספה ומחיקה של ישויות על המפה.
                                <br />
                                נוצרו: <b>{catTrafficSegs.length}</b> עומס, <b>{catTollSegs.length}</b> אגרה, <b>{catCommZones.length}</b> תקשורת, <b>{manualParks.length}</b> פארקים.
                            </div>

                            {/* רשימת הקטגוריות - שורות במקום כרטיסיות */}
                            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                                {[
                                    { key: "traffic", title: "עומס תנועה" },
                                    { key: "toll", title: "כבישי אגרה" },
                                    { key: "comm", title: "תקשורת" },
                                    { key: "park", title: "פארקים" },
                                ].map((c, idx, arr) => (
                                    <div
                                        key={c.key}
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            justifyContent: "space-between",
                                            padding: "10px 0",
                                            borderBottom: idx < arr.length - 1 ? "1px solid rgba(255,255,255,0.1)" : "none",
                                        }}
                                    >
                                        <div style={{ fontWeight: 800, fontSize: 14 }}>{c.title}</div>

                                        <div style={{ display: "flex", gap: 8 }}>
                                            <button
                                                onClick={() => {
                                                    setDeleteCatMode(null);
                                                    setDraftEntityPts([]);
                                                    setDraftCommCenter(null);

                                                    if (c.key === "park") {
                                                        setEntityDrawMode(null);
                                                        setIsDrawingPark(true);
                                                        showToast("מצב הוספת פארק: הקלק להוספת נקודות, דאבל-קליק לסיום. ESC לביטול.");
                                                        return;
                                                    }

                                                    setIsDrawingPark(false);
                                                    setEntityDrawMode(c.key as any);
                                                    showToast(
                                                        c.key === "comm"
                                                            ? "מצב הוספת תקשורת: קליק ראשון = מרכז, קליק שני = רדיוס."
                                                            : "מצב הוספת מקטע: הקלק נקודות על כבישים, דאבל-קליק לסיום."
                                                    );
                                                }}
                                                style={{
                                                    padding: "6px 10px",
                                                    borderRadius: 8,
                                                    border: "1px solid rgba(255,255,255,0.15)",
                                                    background: "rgba(17, 134, 255, 0.2)",
                                                    color: "white",
                                                    fontSize: 13,
                                                    fontWeight: 700,
                                                    cursor: "pointer",
                                                }}
                                            >
                                                הוסף
                                            </button>

                                            <button
                                                onClick={() => {
                                                    setEntityDrawMode(null);
                                                    setDraftEntityPts([]);
                                                    setDraftCommCenter(null);
                                                    setIsDrawingPark(false);
                                                    setDeleteCatMode((prev) => (prev === (c.key as any) ? null : (c.key as any)));
                                                    showToast("מצב מחיקה: לחץ על ישות במפה כדי למחוק אותה.");
                                                }}
                                                style={{
                                                    padding: "6px 10px",
                                                    borderRadius: 8,
                                                    border: "1px solid rgba(255,255,255,0.15)",
                                                    background:
                                                        deleteCatMode === (c.key as any)
                                                            ? "rgba(255, 80, 80, 0.4)"
                                                            : "rgba(255,255,255,0.05)",
                                                    color: "white",
                                                    fontSize: 13,
                                                    fontWeight: 700,
                                                    cursor: "pointer",
                                                }}
                                            >
                                                {deleteCatMode === (c.key as any) ? "מחיקה פעילה" : "מחק"}
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* כפתורי בקרה כלליים בתחתית הקונטיינר */}
                            <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.15)", display: "flex", gap: 10 }}>
                                <button
                                    onClick={() => {
                                        if (window.confirm("למחוק את כל הישויות המרחביות שהוגדרו?")) {
                                            setCatTrafficSegs([]);
                                            setCatTollSegs([]);
                                            setCatCommZones([]);
                                            setManualParks([]);
                                            setEntityDrawMode(null);
                                            setDeleteCatMode(null);
                                            setDraftEntityPts([]);
                                            setDraftCommCenter(null);
                                            setIsDrawingPark(false);
                                            showToast("כל הישויות נמחקו.");
                                        }
                                    }}
                                    style={{
                                        flex: 1,
                                        padding: "8px",
                                        borderRadius: 10,
                                        border: "1px solid rgba(255,255,255,0.15)",
                                        background: "rgba(255, 80, 80, 0.15)",
                                        color: "#ffcccc",
                                        fontSize: 13,
                                        fontWeight: 700,
                                        cursor: "pointer",
                                    }}
                                >
                                    מחק הכל
                                </button>

                                <button
                                    onClick={() => {
                                        setEntityDrawMode(null);
                                        setDeleteCatMode(null);
                                        setDraftEntityPts([]);
                                        setDraftCommCenter(null);
                                        setIsDrawingPark(false);
                                        showToast("מצבי עריכה בוטלו.");
                                    }}
                                    style={{
                                        flex: 1,
                                        padding: "8px",
                                        borderRadius: 10,
                                        border: "1px solid rgba(255,255,255,0.15)",
                                        background: "rgba(255,255,255,0.05)",
                                        color: "white",
                                        fontSize: 13,
                                        fontWeight: 700,
                                        cursor: "pointer",
                                    }}
                                >
                                    בטל מצבים
                                </button>
                            </div>
                        </div>


                        <div>

                            <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                                <div style={{ fontWeight: 900, marginBottom: 8 }}>שלב 5: הגדרת מטלה וחישוב מסלול מיטבי</div>

                                <div style={{ fontSize: 13, opacity: 0.92, lineHeight: 1.45 }}>
                                    כאן אתה מגדיר את המטלה לנבדק (גלובלית/לוקאלית).
                                    <b>בתרחיש זה אין פריסה אוטומטית של ישויות</b> — ישויות מרחביות נבנות ידנית בשלב 5.
                                    את החישוב וההמלצה תפעיל בשלב 6 ("תוצאות").
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
                                            style={{ width: "80%", padding: 8, borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.25)", color: "white" }}
                                        />
                                    </div>
                                    <div>
                                        <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>משקל משני</div>
                                        <input
                                            type="number"
                                            value={taskWSecondary}
                                            onChange={(e) => setTaskWSecondary(parseFloat(e.target.value || "0"))}
                                            style={{ width: "80%", padding: 8, borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.25)", color: "white" }}
                                        />
                                    </div>
                                    <div>
                                        <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>משקל זמן</div>
                                        <input
                                            type="number"
                                            value={taskWTime}
                                            onChange={(e) => setTaskWTime(parseFloat(e.target.value || "0"))}
                                            style={{ width: "80%", padding: 8, borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.25)", color: "white" }}
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
                                            style={{ width: "80%", padding: 8, borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.25)", color: "white" }}
                                        />
                                    </div>
                                    <div>
                                        <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>מסלול מועדף (אופציונלי)</div>
                                        <select
                                            value={taskFavorRoute}
                                            onChange={(e) => setTaskFavorRoute(e.target.value as any)}
                                            style={{ width: "80%", padding: 8, borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.25)", color: "white" }}
                                        >
                                            <option value="Auto">Auto</option>
                                            <option value="A">A</option>
                                            <option value="B">B</option>
                                            <option value="C">C</option>
                                        </select>
                                    </div>
                                </div>

                                <div style={{ marginTop: 12, fontSize: 13, opacity: 0.92, lineHeight: 1.35 }}>
                                    <div style={{ opacity: 0.75, marginBottom: 6 }}>
                                        החישוב והעדכון מתבצעים בשלב 6 ("תוצאות").
                                    </div>
                                    {taskWinnerRoute ? (
                                        <>
                                            מסלול מומלץ: <b>{taskWinnerRoute}</b>
                                            <span style={{ opacity: 0.75 }}> • {taskWinnerNote}</span>
                                        </>
                                    ) : (
                                        <span style={{ opacity: 0.7 }}>הגדר מטלה, עבור לשלב 6 ולחץ "תוצאות".</span>
                                    )}
                                </div>
                            </div>

                            <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                                <div style={{ fontWeight: 900, marginBottom: 6 }}>שלב 6: תוצאות והמלצת מערכת</div>
                                <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 12, lineHeight: 1.4 }}>
                                    לחץ על "הצג תוצאות" כדי לחשב ציונים מחדש (כולל עריכות ידניות) ולקבל המלצה.
                                </div>

                                <div style={{ display: "flex", gap: 10 }}>
                                    <button
                                        onClick={() => {
                                            const isOpening = !showResults;
                                            if (isOpening) {
                                                const mapNow = mapRef.current;
                                                if (mapNow) {
                                                    // 1. חישוב ציונים מחדש תמיד
                                                    const scores = computeRouteScores(
                                                        mapNow,
                                                        tripleLinesRef.current,
                                                        catTrafficSegs,
                                                        catTollSegs,
                                                        catCommZones,
                                                        manualParksRef.current
                                                    );
                                                    setRouteScores(scores);

                                                    // 2. עדכון המלצת המערכת
                                                    setTimeout(() => applyTaskScenario(), 50);
                                                }
                                            }
                                            setShowResults(isOpening);
                                        }}
                                        disabled={!tripleComputed}
                                        style={{
                                            flex: 1,
                                            padding: "12px",
                                            borderRadius: 10,
                                            border: "1px solid rgba(255,255,255,0.15)",
                                            background: showResults ? "rgba(140,203,255,0.25)" : "rgba(255,255,255,0.06)",
                                            color: "#e8eefc",
                                            cursor: tripleComputed ? "pointer" : "not-allowed",
                                            fontWeight: 900,
                                            fontSize: 14,
                                            opacity: tripleComputed ? 1 : 0.6,
                                            transition: "all 0.2s"
                                        }}
                                    >
                                        {showResults ? "הסתר טבלה" : "הצג תוצאות (חשב מחדש)"}
                                    </button>

                                    <button
                                        onClick={() => setShowVisualizations(true)}
                                        disabled={!routeScores.length}
                                        style={{
                                            flex: 1,
                                            padding: "12px",
                                            borderRadius: 10,
                                            border: "1px solid rgba(255,255,255,0.15)",
                                            background: routeScores.length ? "rgba(140,203,255,0.15)" : "rgba(255,255,255,0.04)",
                                            color: "#e8eefc",
                                            cursor: routeScores.length ? "pointer" : "not-allowed",
                                            fontWeight: 900,
                                            fontSize: 14,
                                            opacity: routeScores.length ? 1 : 0.6,
                                            transition: "all 0.2s"
                                        }}
                                    >
                                        ויזואליזציות
                                    </button>
                                </div>

                                {/* המלצת המערכת */}
                                {taskWinnerRoute && routeScores.length > 0 && showResults && (
                                    <div style={{
                                        marginTop: 12, padding: "12px", borderRadius: 10,
                                        background: "rgba(34, 197, 94, 0.15)", border: "1px solid rgba(34, 197, 94, 0.3)"
                                    }}>
                                        <div style={{ fontWeight: 900, color: "#4ade80", marginBottom: 4 }}>
                                            🏆 המלצת המערכת: מסלול {taskWinnerRoute === 'A' ? 'א' : taskWinnerRoute === 'B' ? 'ב' : 'ג'}
                                        </div>
                                        <div style={{ fontSize: 13, opacity: 0.9 }}>
                                            {taskWinnerNote}
                                        </div>
                                    </div>
                                )}
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
                                        <div style={{ fontWeight: 900, fontSize: 16 }}>עריכה ידנית של ישויות</div>
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
                                        כאן ניתן ליצור, לערוך ולמחוק ישויות מרחביות <b>ידנית בלבד</b>.
                                        אין פיזור אוטומטי בשלב זה.
                                        כרגע: <b>{catTrafficSegs.length}</b> עומסים, <b>{catTollSegs.length}</b> אגרות, <b>{catCommZones.length}</b> אזורי תקשורת, <b>{manualParks.length}</b> פארקים.
                                    </div>

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
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>ייצוא נתונים</div>
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
                                            width: "96%",
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
                                            width: "96%",
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
                                    <div style={{ fontWeight: 800, marginBottom: 6 }}>דרישות (טקסט חופשי)</div>
                                    <textarea
                                        maxLength={1200}
                                        value={exportRequirementsText}
                                        onChange={(e) => setExportRequirementsText(e.target.value)}
                                        rows={3}
                                        placeholder="כתוב כאן דרישות/הנחיות נוספות שיופיעו בקובץ המיוצא מתחת לטקסט המטלה (מודגש)"
                                        style={{
                                            width: "96%",
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
                                                    width: "90%",
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
                                        onClick={() => {
                                            exportDebugLog();
                                        }}
                                        style={{
                                            flex: 1,
                                            minWidth: 220,
                                            padding: "10px 12px",
                                            borderRadius: 12,
                                            border: "1px solid rgba(255,255,255,0.18)",
                                            background: "rgba(140,203,255,0.12)",
                                            color: "#e8eefc",
                                            cursor: "pointer",
                                            fontFamily: "Arial, sans-serif",
                                            fontWeight: 800,
                                        }}
                                    >
                                        לוג (JSON)
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

                {uiToast && (
                    <div
                        style={{
                            position: "fixed",
                            left: "50%",
                            bottom: 18,
                            transform: "translateX(-50%)",
                            background: "rgba(0,0,0,0.8)",
                            color: "white",
                            padding: "10px 14px",
                            borderRadius: 14,
                            border: "1px solid rgba(255,255,255,0.18)",
                            zIndex: 20000,
                            maxWidth: "92vw",
                            fontFamily: "Arial, sans-serif",
                            direction: "rtl",
                            textAlign: "center",
                        }}
                    >
                        {uiToast}
                    </div>
                )}

                <div style={{ fontSize: 12, opacity: 0.65 }}>טיפ: בחר מסלול א/ב/ג בפאנל כדי להציג עליו את חלוקת המקטעים.</div>

                {/* תמיד גלוי: ייצוא לוג JSON לדיבאג */}
                <button
                    onClick={() => exportDebugLog()}
                    title="ייצוא לוג (JSON)"
                    style={{
                        position: "fixed",
                        bottom: 12,
                        left: "50%",
                        transform: "translateX(-50%)",
                        zIndex: 10001,
                        padding: "10px 14px",
                        borderRadius: 999,
                        border: "1px solid rgba(255,255,255,0.18)",
                        background: "rgba(140,203,255,0.22)",
                        color: "#e8eefc",
                        fontFamily: "Arial, sans-serif",
                        fontWeight: 800,
                        cursor: "pointer",
                        boxShadow: "0 8px 22px rgba(0,0,0,0.32)",
                        backdropFilter: "blur(8px)",
                        WebkitBackdropFilter: "blur(8px)",
                    }}
                >
                    לוג (JSON)
                </button>

            </div>
        </div>
    );
}