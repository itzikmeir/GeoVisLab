import React, { useState, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

interface ScenarioData {
  id: string;             
  taskText: string;       
  requirements: string;   
  correctRoute: string;   
  inaccurateRoute: string;
}

const ExportFileManager: React.FC = () => {
  const [excelMap, setExcelMap] = useState<Record<string, ScenarioData> | null>(null);
  const [htmlFiles, setHtmlFiles] = useState<File[]>([]);
  const [globalCss, setGlobalCss] = useState<string>("");
  const [processing, setProcessing] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [generateInaccurateMode, setGenerateInaccurateMode] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState<number>(30); // ברירת מחדל 30 שניות
  
  const logsEndRef = useRef<HTMLDivElement>(null);
  const mainContainerRef = useRef<HTMLDivElement>(null); // רף לגלילה ראשית

  // גלילה אוטומטית ללוג
  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);

  // --- תיקון: גלילה לראש העמוד בעת הפתיחה ---
  useEffect(() => {
    if (mainContainerRef.current) {
        mainContainerRef.current.scrollTop = 0;
    }
  }, []);

  const addLog = (msg: string) => setLogs(prev => [...prev, `${new Date().toLocaleTimeString('he-IL')}: ${msg}`]);

  const cleanIdString = (str: any): string => {
    if (!str) return '';
    return String(str).trim();
  };

  const escapeJsonString = (str: string) => {
    if (!str) return "";
    return str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  };

  // --- פונקציה להמרת עברית לאנגלית (א׳ -> A) ---
  const normalizeRoute = (val: any): string => {
      if (!val) return "A";
      const str = String(val).trim().replace(/['`]/g, ''); // מסיר גרשיים
      
      if (str === 'א' || str === 'א׳') return 'A';
      if (str === 'ב' || str === 'ב׳') return 'B';
      if (str === 'ג' || str === 'ג׳') return 'C';
      
      return str.toUpperCase();
  };

  // --- פונקציה חכמה למציאת מפתח העמודה (מתגברת על BOM ורווחים) ---
  const findColumnKey = (row: any, possibleNames: string[]): string | undefined => {
    const rowKeys = Object.keys(row);
    return rowKeys.find(key => {
        const cleanKey = key.replace(/^[\uFEFF\s]+/, '').trim().toLowerCase();
        return possibleNames.some(name => cleanKey === name.toLowerCase());
    });
  };

  const handleExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: 'binary' });
        
        // חיפוש ספציפי של הגיליון "קטלוג תרחישים"
        const targetSheetName = "קטלוג תרחישים";
        let wsName = wb.SheetNames.find(n => n.trim() === targetSheetName);

        if (wsName) {
            addLog(`📄 נמצא הגיליון המבוקש: "${wsName}"`);
        } else {
            addLog(`⚠️ לא נמצא גיליון בשם "${targetSheetName}". לוקח את הראשון: "${wb.SheetNames[0]}"`);
            wsName = wb.SheetNames[0];
        }

        const ws = wb.Sheets[wsName];
        const data = XLSX.utils.sheet_to_json<any>(ws);

        if (data.length === 0) {
            addLog('⚠️ הגיליון ריק.');
            return;
        }

        const newMap: Record<string, ScenarioData> = {};
        let successCount = 0;
        
        const idKey = findColumnKey(data[0], ['SCN_ID', 'ID', 'ScenarioID']);
        const taskKey = findColumnKey(data[0], ['TASK_TEXT', 'Task', 'task_text']);
        const reqKey = findColumnKey(data[0], ['REQUIREMENTS', 'Requirements', 'req']);
        const correctKey = findColumnKey(data[0], ['CORRECT_ROUTE', 'Correct', 'correct_route']);
        const inaccKey = findColumnKey(data[0], ['REC_INACCURATE', 'Inaccurate', 'rec_inaccurate']);

        if (!idKey) {
            addLog(`❌ שגיאה: לא נמצאה עמודת SCN_ID בגיליון "${wsName}".`);
            return;
        }

        data.forEach((row, idx) => {
          const rawId = row[idKey];
          const id = cleanIdString(rawId);

          if (id) {
            newMap[id] = {
              id,
              taskText: taskKey ? row[taskKey] : '',
              requirements: reqKey ? row[reqKey] : '',
              correctRoute: correctKey ? row[correctKey] : 'A',
              inaccurateRoute: inaccKey ? row[inaccKey] : 'A' 
            };
            successCount++;
          }
        });

        if (successCount === 0) {
            addLog('❌ לא הצלחתי לטעון שורות תקינות.');
        } else {
            setExcelMap(newMap);
            addLog(`✅ נטענו ${successCount} שורות מהגיליון "${wsName}"`);
        }
      } catch (err) {
        addLog('❌ שגיאה בטעינת האקסל');
        console.error(err);
      }
    };
    reader.readAsBinaryString(file);
  };

  const handleHtmlFolderUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files).filter(f => f.name.endsWith('.html'));
      setHtmlFiles(files);
      addLog(`📂 נטענו ${files.length} קבצי HTML`);
    }
  };

const processFiles = async () => {
    if (!excelMap || htmlFiles.length === 0) return;
    setProcessing(true);
    addLog('--- מתחיל עיבוד ---');

    const zip = new JSZip();
    const folderCorrect = zip.folder("Correct_Scenarios");
    const folderInaccurate = generateInaccurateMode ? zip.folder("Inaccurate_Scenarios") : null;

    let processedCount = 0;

    for (const file of htmlFiles) {
      const rawName = file.name.replace('Exp_', '').replace('.html', '');
      const baseId = rawName.replace(/_[HRS]$/i, ''); 
      
      const row = excelMap[cleanIdString(baseId)];

      if (row) {
        let content = await file.text();

        // 1. עדכון טקסטים
        if (row.taskText) {
             content = content.replace(/"taskText"\s*:\s*".*?"/, `"taskText":"${escapeJsonString(row.taskText)}"`);
        }
        if (row.requirements) {
             content = content.replace(/"requirementsText"\s*:\s*".*?"/, `"requirementsText":"${escapeJsonString(row.requirements)}"`);
        }
        
        // 2. הזרקת CSS
        if (globalCss.trim()) {
          content = content.replace('</head>', `<style>${globalCss}</style></head>`);
        }

        // --- שלב 3: עדכון זמן הטיימר (כאן המקום הנכון) ---
        // עדכון המשתנה timeLeft
        content = content.replace(/let\s+timeLeft\s*=\s*30;/, `let timeLeft = ${timerSeconds};`); // <--- כאן
        // עדכון חישוב האחוזים בבר ההתקדמות
        content = content.replace(/\(timeLeft\s*\/\s*30\)/g, `(timeLeft / ${timerSeconds})`); // <--- כאן
        // --------------------------------------------------

        let contentCorrect = content;
        const routeCorrect = normalizeRoute(row.correctRoute);
        contentCorrect = contentCorrect.replace(/"recommendedRoute"\s*:\s*".*?"/, `"recommendedRoute":"${routeCorrect}"`);
        folderCorrect?.file(file.name, contentCorrect);

        if (generateInaccurateMode && folderInaccurate) {
            let contentInaccurate = content;
            const routeInaccurate = normalizeRoute(row.inaccurateRoute || row.correctRoute);
            contentInaccurate = contentInaccurate.replace(/"recommendedRoute"\s*:\s*".*?"/, `"recommendedRoute":"${routeInaccurate}"`);
            folderInaccurate.file(file.name, contentInaccurate);
        }

        addLog(`✅ עובד: ${file.name} (ID: ${baseId} -> Rec: ${routeCorrect})`);
        processedCount++;

      } else {
        addLog(`⚠️ לא נמצא באקסל: ${file.name} (זוהה ID: ${baseId}) - הועתק ללא שינוי`);
        folderCorrect?.file(file.name, await file.text());
      }
    }

    // ... המשך הפונקציה (שמירת ה-ZIP)

    if (processedCount > 0) {
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      saveAs(zipBlob, `Updated_Scenarios_${timestamp}.zip`);
      addLog(`🎉 סיימנו! ${processedCount} קבצים עובדו.`);
    } else {
      addLog('❌ לא בוצעו שינויים.');
    }

    setProcessing(false);
  };

  // --- עדכון סטיילים לגלילה ---
  const styles = {
    // הקונטיינר הראשי תופס את כל הגובה ומאפשר גלילה
    container: { 
        height: '100%', 
        overflowY: 'auto' as const, // מאפשר גלילה אנכית
        padding: '20px', 
        fontFamily: 'Segoe UI, sans-serif', 
        direction: 'rtl' as const, 
        color: '#e2e8f0',
        boxSizing: 'border-box' as const
    },
    // התוכן עצמו ממורכז
    contentWrapper: {
        maxWidth: '800px', 
        margin: '0 auto',
        paddingBottom: '50px' // רווח מלמטה כדי שהלוג לא יהיה דבוק
    },
    header: { textAlign: 'center' as const, marginBottom: '30px', color: '#60a5fa' },
    card: { background: '#1e293b', borderRadius: '12px', padding: '20px', marginBottom: '20px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' },
    cardHeader: { display: 'flex', alignItems: 'center', marginBottom: '15px', borderBottom: '1px solid #334155', paddingBottom: '10px' },
    stepIcon: { width: '30px', height: '30px', borderRadius: '50%', background: '#3b82f6', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', marginLeft: '10px' },
    input: { width: '100%', padding: '10px', marginTop: '10px', borderRadius: '6px', border: '1px solid #475569', background: '#0f172a', color: 'white' },
    button: { width: '100%', padding: '15px', background: 'linear-gradient(to right, #2563eb, #3b82f6)', color: 'white', border: 'none', borderRadius: '8px', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer', marginTop: '20px', transition: 'transform 0.1s' },
    logBox: { background: '#000', padding: '15px', borderRadius: '8px', height: '200px', overflowY: 'auto' as const, fontFamily: 'monospace', fontSize: '13px', border: '1px solid #333' },
    checkboxContainer: { marginTop: '15px', padding: '10px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '6px', display: 'flex', alignItems: 'center' }
  };

  return (
    <div style={styles.container} ref={mainContainerRef}>
      <div style={styles.contentWrapper}>
          <h1 style={styles.header}>ניהול ועדכון קבצי HTML מיוצאים</h1>

          <section style={styles.card}>
            <div style={styles.cardHeader}>
              <div style={styles.stepIcon}>1</div>
              <h3 style={{ margin: 0, fontSize: '18px' }}>טעינת קובץ אקסל (נתונים)</h3>
            </div>
            <p style={{ fontSize: '14px', color: '#94a3b8' }}>המערכת תחפש אוטומטית את הגיליון: <b>"קטלוג תרחישים"</b></p>
            <input type="file" accept=".xlsx, .xls" onChange={handleExcelUpload} style={styles.input} />
          </section>

          <section style={styles.card}>
            <div style={styles.cardHeader}>
              <div style={styles.stepIcon}>2</div>
              <h3 style={{ margin: 0, fontSize: '18px' }}>טעינת תיקיית קבצי HTML</h3>
            </div>
            <p style={{ fontSize: '14px', color: '#94a3b8' }}>בחר את התיקייה עם קבצי ה-Exp_SCN...html</p>
            <input type="file" {...({ webkitdirectory: "true" } as any)} multiple onChange={handleHtmlFolderUpload} style={styles.input} />
            {htmlFiles.length > 0 && <div style={{ marginTop: '10px', color: '#4ade80' }}>✓ זוהו {htmlFiles.length} קבצים</div>}
          </section>

          <section style={styles.card}>
            <div style={styles.cardHeader}>
              <div style={styles.stepIcon}>3</div>
              <h3 style={{ margin: 0, fontSize: '18px' }}>הגדרות מתקדמות</h3>
            </div>
            <textarea rows={3} placeholder="עיצוב CSS גלובלי (אופציונלי)..." value={globalCss} onChange={(e) => setGlobalCss(e.target.value)} style={{ ...styles.input, fontFamily: 'monospace', direction: 'ltr', resize: 'vertical' }} />
            
            <div style={styles.checkboxContainer}>
                <input 
                    type="checkbox" 
                    id="inaccurateMode" 
                    checked={generateInaccurateMode} 
                    onChange={(e) => setGenerateInaccurateMode(e.target.checked)}
                    style={{ width: '20px', height: '20px', marginLeft: '10px' }}
                />
                <label htmlFor="inaccurateMode" style={{ cursor: 'pointer', color: '#fca5a5', fontWeight: 'bold' }}>
                  יצירת גרסה עם המלצות שגויות (REC_INACCURATE)
                </label>
            </div>
              <div style={{ marginBottom: '15px', padding: '10px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>
              <label style={{ color: '#94a3b8', display: 'block', marginBottom: '8px', fontSize: '14px' }}>
                ⏳ זמן מוקצב לתרחיש (בשניות):
              </label>
              <input 
                  type="number" 
                  value={timerSeconds} 
                  onChange={(e) => setTimerSeconds(Math.max(1, Number(e.target.value)))} 
                  style={{ ...styles.input, width: '100px', textAlign: 'center' }} 
                  />
            </div>
          </section>
          
          <button onClick={processFiles} disabled={processing || !excelMap || htmlFiles.length === 0} style={styles.button}>{processing ? 'מעבד נתונים...' : '🚀 הרץ עדכון'}</button>

          <div style={{ marginTop: '20px' }}>
              <label style={{color: '#94a3b8', fontSize: '14px', marginBottom: '5px', display: 'block'}}>לוג מערכת:</label>
              <div style={styles.logBox} ref={logsEndRef}>
              {logs.length === 0 ? <span style={{opacity: 0.5}}>המתנה לפעולה...</span> : logs.map((l, i) => <div key={i}>{l}</div>)}
              </div>
          </div>
      </div>
    </div>
  );
};

export default ExportFileManager;