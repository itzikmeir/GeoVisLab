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
  const logsEndRef = useRef<HTMLDivElement>(null);

  // גלילה אוטומטית ללוג האחרון
  //useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);

  const addLog = (msg: string) => setLogs(prev => [...prev, `${new Date().toLocaleTimeString('he-IL')}: ${msg}`]);

  // פונקציית ניקוי מזהים
  const cleanIdString = (str: any): string => {
    if (!str) return '';
    return String(str).trim().replace(/[\u200B-\u200D\uFEFF]/g, ''); 
  };

  // שליפת ערך מעמודה בצורה גמישה מאוד
  const getValueFromRow = (row: any, keys: string[]) => {
    // 1. חיפוש מדויק
    for (const key of keys) {
      if (row[key] !== undefined && row[key] !== null) return String(row[key]).trim();
    }
    // 2. חיפוש לא תלוי אותיות גדולות/קטנות או רווחים
    const rowKeys = Object.keys(row);
    for (const key of keys) {
      // חיפוש גמיש שמתעלם מ-Case ומרווחים מיותרים
      const foundKey = rowKeys.find(k => k.trim().toLowerCase() === key.toLowerCase().trim());
      if (foundKey && row[foundKey]) return String(row[foundKey]).trim();
    }
    return '';
  };

  // המרה והתאמה של נתיבים
  const mapRouteValue = (val: string): string => {
    if (!val) return "";
    const cleanVal = val.trim().replace(/['`"״]/g, ''); // הסרת גרשיים מכל סוג
    if (cleanVal === 'א') return 'A';
    if (cleanVal === 'ב') return 'B';
    if (cleanVal === 'ג') return 'C';
    // מחזיר את הערך המקורי אם הוא כבר באנגלית (A/B/C) או מספר
    return cleanVal; 
  };

  // --- שלב 1: טעינת אקסל ---
  const handleExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: 'binary' });
        
        // סריקת כל הגליונות
        let targetSheetName = '';
        let rawData: any[] = [];
        let foundColumns: string[] = [];

        for (const sheetName of wb.SheetNames) {
          const ws = wb.Sheets[sheetName];
          const data = XLSX.utils.sheet_to_json<any>(ws);
          if (data.length > 0) {
            const cols = Object.keys(data[0]);
            const hasTarget = cols.some(c => 
                c.toUpperCase().includes('REC_INACCURATE') || 
                c.toUpperCase().includes('INACCURATE') || 
                c.includes('מטלה') ||
                c.toLowerCase().includes('task')
            );
            
            if (hasTarget && !cols.includes('Participant_ID')) {
              targetSheetName = sheetName;
              rawData = data;
              foundColumns = cols;
              break; 
            }
          }
        }

        if (!targetSheetName) {
           targetSheetName = wb.SheetNames[0];
           rawData = XLSX.utils.sheet_to_json<any>(wb.Sheets[targetSheetName]);
           if (rawData.length > 0) foundColumns = Object.keys(rawData[0]);
        }

        addLog(`📂 גליון נבחר: "${targetSheetName}"`);
        addLog(`🔍 עמודות שנמצאו: ${foundColumns.join(', ')}`);

        const newMap: Record<string, ScenarioData> = {};
        let mappedCount = 0;

        rawData.forEach((row, index) => {
          const rawId = getValueFromRow(row, ['Scenario_ID', 'Scenario ID', 'ID', 'm_ID']);
          if (!rawId) return; 

          const baseId = cleanIdString(rawId);
          
          // חילוץ המלצה שגויה עם לוגיקה מורחבת
          const rawInaccurate = getValueFromRow(row, ['REC_INACCURATE', 'Rec_Inaccurate', 'Inaccurate', 'Rec Inaccurate', 'REC INACCURATE']);
          const inaccurateVal = mapRouteValue(rawInaccurate);

          // לוג דיבאג ל-3 השורות הראשונות כדי לוודא קריאה
          if (index < 3) {
             console.log(`Row ${index}: ID=${baseId}, RawInaccurate="${rawInaccurate}", Mapped="${inaccurateVal}"`);
          }

          const scenarioData: ScenarioData = {
            id: baseId,
            taskText: getValueFromRow(row, ['Task', 'TASK', 'מטלה', 'TaskText']),
            requirements: getValueFromRow(row, ['Priority_Task', 'Priority Task', 'Participant_Task', 'Requirements']),
            correctRoute: mapRouteValue(getValueFromRow(row, ['CORRECT_ROUTE', 'Correct_Route', 'Correct'])),
            inaccurateRoute: inaccurateVal
          };

          newMap[baseId] = scenarioData;
          newMap[`${baseId}_H`] = scenarioData;
          newMap[`${baseId}_R`] = scenarioData;
          newMap[`${baseId}_S`] = scenarioData;

          mappedCount++;
        });

        setExcelMap(newMap);
        addLog(`✅ נטענו ${mappedCount} שורות.`);
        
        // בדיקת דגימה ללוג המשתמש
        const firstKey = Object.keys(newMap)[0];
        if (firstKey && newMap[firstKey].inaccurateRoute) {
            addLog(`ℹ️ דוגמה: עבור ${firstKey}, המלצה שגויה שנקלטה: "${newMap[firstKey].inaccurateRoute}"`);
        } else {
            addLog(`⚠️ שים לב: בשורה הראשונה לא נמצא ערך להמלצה שגויה. בדוק את שם העמודה באקסל.`);
        }
        
      } catch (err) {
        console.error(err);
        addLog(`❌ שגיאה בטעינת האקסל.`);
      }
    };
    reader.readAsBinaryString(file);
  };

  const handleHtmlFolderUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files).filter(f => f.name.toLowerCase().endsWith('.html'));
      setHtmlFiles(files);
      addLog(`📂 נטענו ${files.length} קבצי HTML.`);
    }
  };

  // --- שלב 3: עיבוד הקבצים ---
  const processFiles = async () => {
    if (!excelMap || htmlFiles.length === 0) {
      alert("חסרים קבצים או נתוני אקסל.");
      return;
    }

    setProcessing(true);
    const zip = new JSZip();
    let updatedCount = 0;
    
    const folderCorrect = generateInaccurateMode ? zip.folder("Correct") : zip; 
    const folderInaccurate = generateInaccurateMode ? zip.folder("Inaccurate") : null;

    addLog(`--- מתחיל עיבוד ---`);

    for (const file of htmlFiles) {
      try {
        const text = await file.text();
        const dataRegex = /(const|var|let)\s+DATA\s*=\s*({[\s\S]*?});/;
        const match = text.match(dataRegex);

        let contentForCorrect = text;
        let contentForInaccurate = text;

        if (match) {
          const jsonStr = match[2]; 
          let dataObj; 
          try {
            dataObj = JSON.parse(jsonStr);
          } catch (e) {
             try {
                // eslint-disable-next-line no-new-func
                dataObj = new Function("return " + jsonStr)();
             } catch (err2) {
                if (folderCorrect) folderCorrect.file(file.name, text);
                continue;
             }
          }

          let rawScenarioName = dataObj.scenarioName ? String(dataObj.scenarioName) : '';
          let scenarioName = cleanIdString(rawScenarioName);
          
          if (scenarioName) {
            let row = excelMap[scenarioName];

            // מנגנון זיהוי חכם
            if (!row && scenarioName.includes('_')) {
               const parts = scenarioName.split('_');
               if (parts.length >= 2) { 
                   const baseName = parts.slice(0, parts.length - 1).join('_');
                   row = excelMap[baseName];
               }
            }

            if (row) {
              // --- 1. עדכון לתיקיית Correct ---
              const dataCorrect = { ...dataObj };
              if (row.taskText) dataCorrect.taskText = row.taskText;
              if (row.requirements) dataCorrect.requirementsText = row.requirements;
              if (row.correctRoute) dataCorrect.recVal = row.correctRoute; 

              contentForCorrect = contentForCorrect.replace(jsonStr, JSON.stringify(dataCorrect, null, 2));

              // --- 2. עדכון לתיקיית Inaccurate ---
              if (generateInaccurateMode && folderInaccurate) {
                const dataInaccurate = { ...dataObj };
                if (row.taskText) dataInaccurate.taskText = row.taskText;
                if (row.requirements) dataInaccurate.requirementsText = row.requirements;
                
                // הזרקת המלצה שגויה
                if (row.inaccurateRoute) {
                   dataInaccurate.recVal = row.inaccurateRoute;
                } else {
                   // אם אין המלצה שגויה, נשאיר את המקורית או נתריע? 
                   // כרגע משאיר את מה שהיה בקובץ המקורי (בדרך כלל הנכון)
                }
                
                contentForInaccurate = contentForInaccurate.replace(jsonStr, JSON.stringify(dataInaccurate, null, 2));
              }
              
              updatedCount++;
            } else {
              addLog(`⛔ ${file.name} (${scenarioName}): לא נמצא באקסל.`);
            }
          }
        }

        // CSS
        if (globalCss.trim()) {
          const styleInjection = `\n<style>\n${globalCss}\n</style>\n</head>`;
          contentForCorrect = contentForCorrect.replace('</head>', styleInjection);
          if (generateInaccurateMode) {
            contentForInaccurate = contentForInaccurate.replace('</head>', styleInjection);
          }
        }

        if (folderCorrect) folderCorrect.file(file.name, contentForCorrect);
        if (generateInaccurateMode && folderInaccurate) folderInaccurate.file(file.name, contentForInaccurate);

      } catch (err) {
        console.error(`Error processing ${file.name}`, err);
      }
    }

    const blob = await zip.generateAsync({ type: "blob" });
    saveAs(blob, generateInaccurateMode ? "Scenarios_Correct_Inaccurate.zip" : "Scenarios_Updated.zip");
    
    addLog(`✨ סיום: ${updatedCount} קבצים עודכנו.`);
    setProcessing(false);
  };

  // --- Styles (Fixed Layout) ---
  const styles = {
    // מכולה ראשית מותאמת לגובה המסך כדי למנוע חיתוך
    container: {
      padding: '20px 30px',
      direction: 'rtl' as const,
      fontFamily: 'Segoe UI, Tahoma, sans-serif',
      maxWidth: '900px',
      margin: '0 auto',
      marginTop: '20px',            // הוגדל מ-10 ל-100 כדי לא להיחתך בבר העליון
      height: 'calc(100% - 40px)', // תופס את כל הגובה הפנוי פחות השוליים
      overflowY: 'auto' as const,    // גלילה פנימית
      backgroundColor: '#0f172a',
      color: '#e2e8f0',
      borderRadius: '8px',
      boxSizing: 'border-box' as const,
      border: '1px solid #334155'
    },
    header: { marginBottom: '20px', borderBottom: '2px solid #3b82f6', paddingBottom: '10px' },
    card: { background: '#1e293b', padding: '20px', borderRadius: '12px', border: '1px solid #334155', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.5)', marginBottom: '20px' },
    cardHeader: { display: 'flex', alignItems: 'center', marginBottom: '15px' },
    stepIcon: { background: 'rgba(59, 130, 246, 0.2)', color: '#60a5fa', width: '32px', height: '32px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', marginLeft: '12px', flexShrink: 0 },
    input: { width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#f1f5f9', borderRadius: '6px', marginTop: '10px', boxSizing: 'border-box' as const, outline: 'none' },
    checkboxContainer: { marginTop: '15px', padding: '12px', background: 'rgba(59, 130, 246, 0.1)', border: '1px solid #1e40af', borderRadius: '6px', display: 'flex', alignItems: 'flex-start', gap: '10px' },
    button: { width: '100%', padding: '15px', background: processing ? '#475569' : 'linear-gradient(to left, #2563EB, #3b82f6)', color: 'white', fontWeight: 'bold', border: 'none', borderRadius: '10px', cursor: processing ? 'not-allowed' : 'pointer', fontSize: '18px', marginTop: '10px', transition: 'all 0.2s', boxShadow: '0 4px 12px rgba(37, 99, 235, 0.3)' },
    logBox: { background: '#020617', color: '#4ade80', padding: '15px', borderRadius: '12px', fontSize: '13px', fontFamily: 'Consolas, monospace', height: '200px', overflowY: 'auto' as const, direction: 'ltr' as const, border: '1px solid #334155' }
  };

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={{ margin: 0, fontSize: '22px', color: '#f8fafc' }}>מנהל הזרקת נתונים</h1>
        <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '14px' }}>
          תיקון: Priority_Task, REC_INACCURATE וגלילה פנימית.
        </p>
      </header>
      
      <div>
        <section style={styles.card}>
          <div style={styles.cardHeader}>
            <div style={styles.stepIcon}>1</div>
            <h3 style={{ margin: 0, fontSize: '18px' }}>טעינת קטלוג (Excel)</h3>
          </div>
          <div style={{ fontSize: '13px', color: '#cbd5e1', marginBottom: '15px', lineHeight: '1.6' }}>
            וודא שהעמודות קיימות: <b>Scenario_ID, Task, Priority_Task, Correct_Route, REC_INACCURATE</b>
          </div>
          <input type="file" accept=".xlsx, .xls, .csv" onChange={handleExcelUpload} style={styles.input} />
          
          <div style={styles.checkboxContainer}>
            <input type="checkbox" id="inaccurateMode" checked={generateInaccurateMode} onChange={(e) => setGenerateInaccurateMode(e.target.checked)} style={{ width: '20px', height: '20px', cursor: 'pointer', marginTop: '2px' }} />
            <label htmlFor="inaccurateMode" style={{ cursor: 'pointer', fontSize: '14px' }}><b>יצירת סט כפול (Correct / Inaccurate)</b></label>
          </div>

          {excelMap && <div style={{ marginTop: '10px', color: '#4ade80', fontSize: '14px', fontWeight: 'bold' }}>✓ נטענו {Object.keys(excelMap).length} מזהים לזיכרון.</div>}
        </section>

        <section style={styles.card}>
           <div style={styles.cardHeader}>
            <div style={styles.stepIcon}>2</div>
            <h3 style={{ margin: 0, fontSize: '18px' }}>תיקיית קבצים (HTML)</h3>
          </div>
          //@ts-expect-error
          <input type="file" {...({ webkitdirectory: "true" } as any)} multiple onChange={handleHtmlFolderUpload} style={styles.input} />
          {htmlFiles.length > 0 && <div style={{ marginTop: '10px', color: '#4ade80' }}>✓ זוהו {htmlFiles.length} קבצים</div>}
        </section>

        <section style={styles.card}>
           <div style={styles.cardHeader}>
            <div style={styles.stepIcon}>3</div>
            <h3 style={{ margin: 0, fontSize: '18px' }}>עיצוב גלובלי (CSS)</h3>
          </div>
          <textarea rows={3} placeholder="לדוגמה: body { background: #1a1a1a; }" value={globalCss} onChange={(e) => setGlobalCss(e.target.value)} style={{ ...styles.input, fontFamily: 'monospace', direction: 'ltr', resize: 'vertical' }} />
        </section>

        <button onClick={processFiles} disabled={processing || !excelMap || htmlFiles.length === 0} style={styles.button}>{processing ? 'מעבד נתונים...' : '🚀 הרץ עדכון'}</button>

        <div style={{ marginTop: '20px' }}>
            <label style={{color: '#94a3b8', fontSize: '14px', marginBottom: '5px', display: 'block'}}>לוג מערכת:</label>
            <div style={styles.logBox}>
            {logs.length === 0 ? <span style={{opacity: 0.5}}>{'> ממתין להרצה...'}</span> : logs.map((log, i) => <div key={i} style={{ marginBottom: '4px', borderBottom: '1px solid #1e293b' }}>{'> ' + log}</div>)}
            <div ref={logsEndRef} />
            </div>
        </div>

      </div>
    </div>
  );
};

export default ExportFileManager;