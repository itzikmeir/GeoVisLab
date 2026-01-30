import React, { useState } from 'react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

const BatchGenerator: React.FC = () => {
  const [files, setFiles] = useState<File[]>([]);
  const [processing, setProcessing] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  const addLog = (msg: string) => setLogs(prev => [`${new Date().toLocaleTimeString()}: ${msg}`, ...prev]);

  const handleFolderUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const jsonFiles = Array.from(e.target.files).filter(f => f.name.toLowerCase().endsWith('.json'));
      setFiles(jsonFiles);
      addLog(`נטענו ${jsonFiles.length} קבצי JSON.`);
    }
  };
const generateBatch = async () => {
    if (files.length === 0) {
      alert("אנא טען תיקייה עם קבצי JSON תחילה");
      return;
    }

    setProcessing(true);
    const zip = new JSZip();
    let counter = 1;

    try {
      // 1. טעינת התבנית
      const templateResponse = await fetch('/template.html');
      if (!templateResponse.ok) throw new Error("לא נמצא קובץ template.html בתיקיית public");
      const templateText = await templateResponse.text();

      // בדיקה שהעוגן החדש קיים
      if (!templateText.includes('/* DATA_INJECTION_POINT */')) {
        throw new Error("לא נמצא העוגן /* DATA_INJECTION_POINT */ בתבנית. נא לעדכן את template.html");
      }

      const sortedFiles = files.sort((a, b) => a.name.localeCompare(b.name));

      for (const file of sortedFiles) {
        const text = await file.text();
        let jsonData;
        try {
          jsonData = JSON.parse(text);
        } catch (e) {
          addLog(`שגיאה בקריאת JSON בקובץ ${file.name}`);
          continue;
        }

        const scenarioId = `SCN_${String(counter).padStart(3, '0')}`;
        
        const variants = [
          { type: 'T', label: 'Technical' },
          { type: 'R', label: 'Realism' },
          { type: 'S', label: 'Schematic' }
        ];

        for (const variant of variants) {
          const scenarioData = {
            scenarioName: scenarioId,
            originalFileName: file.name,
            vizType: variant.type,
            mapState: jsonData.mapState,
            routes: jsonData.routes,
            entities: jsonData.entities,
            task: jsonData.task,
            meta: jsonData.meta
          };

          // המרה למחרוזת JSON
          const jsonString = JSON.stringify(scenarioData, null, 2);
          
          // --- התיקון: יצירת שורת קוד שלמה ---
          // אנחנו מחליפים את ההערה בשורה: const DATA = { ... };
          const injectionCode = `const DATA = ${jsonString};`;
          
          let newHtml = templateText.replace('/* DATA_INJECTION_POINT */', injectionCode);
          
          // עדכון כותרת
          newHtml = newHtml.replace(/<title>.*?<\/title>/, `<title>${scenarioId}</title>`);

          zip.file(`${scenarioId}_${variant.type}.html`, newHtml);
        }

        addLog(`נוצר: ${scenarioId} (${file.name})`);
        counter++;
      }

      const content = await zip.generateAsync({ type: "blob" });
      saveAs(content, "Batch_Scenarios_Output.zip");
      addLog("התהליך הסתיים בהצלחה! הקובץ ירד.");

    } catch (error: any) {
      console.error(error);
      addLog(`שגיאה: ${error.message}`);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div style={{ padding: '20px', direction: 'rtl', color: '#e2e8f0', maxWidth: '800px', margin: '0 auto' }}>
      <h2 style={{ borderBottom: '2px solid #2563EB', paddingBottom: '10px' }}>מחולל תרחישים המוני</h2>
      
      <div style={{ marginTop: '20px', background: '#1e293b', padding: '20px', borderRadius: '8px' }}>
        <div style={{ background: '#334155', padding: '10px', borderRadius: '4px', marginBottom: '15px', fontSize: '14px', borderRight: '4px solid #F59E0B' }}>
          <b>שים לב:</b> וודא שקובץ <code>template.html</code> נמצא בתיקיית <code>public</code> בפרויקט.
        </div>

        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', marginBottom: '8px' }}>בחר תיקייה עם קבצי JSON:</label>
          <input 
            type="file" 
            // @ts-ignore
            webkitdirectory="true"
            multiple 
            onChange={handleFolderUpload}
            style={{ width: '100%', padding: '10px', background: '#0f172a', border: '1px solid #334155', borderRadius: '4px', color: 'white' }}
          />
        </div>

        <button 
          onClick={generateBatch}
          disabled={processing || files.length === 0}
          style={{ 
            width: '100%',
            padding: '15px', 
            background: processing ? '#475569' : '#2563EB', 
            color: 'white', 
            fontWeight: 'bold', 
            border: 'none', 
            borderRadius: '8px', 
            cursor: processing ? 'not-allowed' : 'pointer'
          }}
        >
          {processing ? 'מעבד...' : 'הפק תרחישים והורד ZIP'}
        </button>

        <div style={{ marginTop: '20px', background: '#0f172a', padding: '10px', borderRadius: '4px', height: '200px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '12px', border: '1px solid #334155' }}>
          {logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>
    </div>
  );
};


// ----------------------------------------------------------------------
// זוהי הפונקציה שבונה את ה-HTML. עליך לעדכן אותה עם התבנית המלאה שלך!
// ----------------------------------------------------------------------
function getHtmlTemplate(data: any): string {
  // המרת האובייקט למחרוזת JSON כדי להזריק לתוך ה-SCRIPT
  const jsonString = JSON.stringify(data, null, 2);

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${data.scenarioName}</title>
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

  .mapLegend { position: absolute; right: 10px; bottom: 10px; padding: 10px; width: 140px; direction: rtl; text-align: right; pointer-events: none; z-index: 15; font-size: 14px; }
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
  .legContent { display: flex; flex-direction: column; font-family: Arial !important;}
  .legTitle { font-weight: 800; font-size: 14px; font-family: Arial !important;}
  .legDesc { font-size: 12px; opacity: 0.7; margin-top: 2px; font-family: Arial !important;}

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
  .stack-segment { width: 100%; position: relative; border-top: 1px solid rgba(255,255,255,0.2); overflow: visible !important; box-sizing: border-box; }
  .stack-label { position: absolute; top: 50%; left: 0; right: 0; transform: translateY(-50%); text-align: center; color: white; font-weight: bold; font-size: 11px; text-shadow: 0 1px 3px rgba(0,0,0,0.9), 0 0 2px black; white-space: nowrap; pointer-events: none; display: flex; align-items: center; justify-content: center; gap: 4px; }

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
  .modal { background: #1b1b1c; border: 1px solid #334155; width: 400px; max-width: 90%; padding: 20px; border-radius: 12px; text-align: center; direction: rtl; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); }
  .modalBtns { display: flex; gap: 10px; margin-top: 20px; justify-content: center; }
  .mBtn { padding: 10px 20px; border-radius: 6px; cursor: pointer; border: none; font-weight: 700; flex:1; }
  .mBtn.yes { background: #2563EB; color: white; }
  .mBtn.no { background: rgba(255,255,255,0.1); color: white; }
  .filterRow { display: flex; justify-content: space-between; align-items: center; padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); }
  .eyeBtn { background: none; border: none; color: white; cursor: pointer; opacity: 0.7; display:flex; align-items:center; gap:4px; }
  .eyeBtn.on { opacity: 1; color: #60A5FA; }
  /* --- תיקון אגרסיבי לכפתורי המפה (זום/מצפן) --- */
            /* --- תיקון סופי ומוחלט לכפתורי המפה --- */
            
            /* 1. הקופסה שעוטפת את הכפתורים - לבנה ואטומה */
            div.maplibregl-ctrl-group {
                background: #ffffff !important;
                border: 1px solid #ccc !important;
                box-shadow: 0 1px 2px rgba(0,0,0,0.1) !important;
                opacity: 1 !important;
            }

            /* 2. הכפתורים עצמם - איפוס מלא */
            div.maplibregl-ctrl-group button {
                background: #ffffff !important; /* שימוש ב-background מקצר */
                opacity: 1 !important;
                border: 0 !important;
                border-bottom: 1px solid #ddd !important;
                transition: none !important; /* ביטול אנימציות שקיפות */
                cursor: pointer !important;
            }
            
            /* הסרת קו תחתון מהכפתור האחרון */
            div.maplibregl-ctrl-group button:last-child {
                border-bottom: 0 !important;
            }

            /* 3. מצב HOVER - אפור ברור ללא שקיפות */
            div.maplibregl-ctrl-group button:hover {
                background: #cccccc !important;
                opacity: 1 !important;
            }

            /* 4. האייקונים (הפלוס/מינוס) - הכרחה לשחור */
            .maplibregl-ctrl-icon, 
            div.maplibregl-ctrl-group button span {
                filter: grayscale(100%) brightness(0) !important; /* הופך הכל לשחור */
                opacity: 1 !important;
                background-color: transparent !important; /* שלא יסתיר את הרקע האפור */
            }
</style>
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<link href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet" />
</head>
<body>

<div class="root">
    <h1>טוען תרחיש: ${data.scenarioName} (${data.vizType})</h1>
    <div id="mapStage" style="width:100%; height:100%; background:black;"></div>
</div>

<script>
// הזרקת הנתונים שהגיעו מה-Batch Generator
const DATA = ${jsonString};

// --- כאן תדביק את כל הלוגיקה של ה-JavaScript שלך ---
// (Map Initialization, Layers, Interactions, etc.)

console.log('Scenario Loaded:', DATA.scenarioName);

// דוגמה לשימוש בנתונים:
// if (DATA.vizType === 'T') { ... }

</script>
</body>
</html>`;
}

export default BatchGenerator;