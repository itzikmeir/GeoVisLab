import React, { useState, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { useLanguage } from '../i18n/index.tsx';

interface ScenarioData {
  id: string;
  taskText: string;
  requirements: string;
  correctRoute: string;
  inaccurateRoute: string;
}

const ExportFileManager: React.FC = () => {
  const { dir, t } = useLanguage();
  const isRtl = dir === 'rtl';

  const [excelMap, setExcelMap] = useState<Record<string, ScenarioData> | null>(null);
  const [htmlFiles, setHtmlFiles] = useState<File[]>([]);
  const [globalCss, setGlobalCss] = useState<string>("");
  const [processing, setProcessing] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [generateInaccurateMode, setGenerateInaccurateMode] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState<number>(30);

  const logsEndRef = useRef<HTMLDivElement>(null);
  const mainContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);
  useEffect(() => { if (mainContainerRef.current) mainContainerRef.current.scrollTop = 0; }, []);

  const addLog = (msg: string) => {
    const locale = isRtl ? 'he-IL' : 'en-US';
    setLogs(prev => [...prev, `${new Date().toLocaleTimeString(locale)}: ${msg}`]);
  };

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

  const normalizeRoute = (val: any): string => {
    if (!val) return "A";
    const str = String(val).trim().replace(/['`]/g, '');
    if (str === 'א' || str === 'א׳') return 'A';
    if (str === 'ב' || str === 'ב׳') return 'B';
    if (str === 'ג' || str === 'ג׳') return 'C';
    return str.toUpperCase();
  };

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
        const targetSheetName = "קטלוג תרחישים";
        let wsName = wb.SheetNames.find(n => n.trim() === targetSheetName);

        if (wsName) {
          addLog(t('exportManager.logs.sheetFound', { name: wsName }));
        } else {
          addLog(t('exportManager.logs.sheetNotFound', { name: targetSheetName, first: wb.SheetNames[0] }));
          wsName = wb.SheetNames[0];
        }

        const ws = wb.Sheets[wsName];
        const data = XLSX.utils.sheet_to_json<any>(ws);

        if (data.length === 0) {
          addLog(t('exportManager.logs.sheetEmpty'));
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
          addLog(t('exportManager.logs.columnMissing', { name: wsName }));
          return;
        }

        data.forEach((row) => {
          const rawId = row[idKey];
          const id = cleanIdString(rawId);
          if (id) {
            newMap[id] = {
              id,
              taskText: taskKey ? row[taskKey] : '',
              requirements: reqKey ? row[reqKey] : '',
              correctRoute: correctKey ? row[correctKey] : 'A',
              inaccurateRoute: inaccKey ? row[inaccKey] : 'A',
            };
            successCount++;
          }
        });

        if (successCount === 0) {
          addLog(t('exportManager.logs.rowsFailed'));
        } else {
          setExcelMap(newMap);
          addLog(t('exportManager.logs.rowsLoaded', { count: successCount, name: wsName }));
        }
      } catch (err) {
        addLog(t('exportManager.logs.excelError'));
        console.error(err);
      }
    };
    reader.readAsBinaryString(file);
  };

  const handleHtmlFolderUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files).filter(f => f.name.endsWith('.html'));
      setHtmlFiles(files);
      addLog(t('exportManager.logs.htmlLoaded', { count: files.length }));
    }
  };

  const processFiles = async () => {
    if (!excelMap || htmlFiles.length === 0) return;
    setProcessing(true);
    addLog(t('exportManager.logs.startProcess'));

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

        if (row.taskText) {
          content = content.replace(/"taskText"\s*:\s*".*?"/, `"taskText":"${escapeJsonString(row.taskText)}"`);
        }
        if (row.requirements) {
          content = content.replace(/"requirementsText"\s*:\s*".*?"/, `"requirementsText":"${escapeJsonString(row.requirements)}"`);
        }
        if (globalCss.trim()) {
          content = content.replace('</head>', `<style>${globalCss}</style></head>`);
        }
        content = content.replace(/let\s+timeLeft\s*=\s*30;/, `let timeLeft = ${timerSeconds};`);
        content = content.replace(/\(timeLeft\s*\/\s*30\)/g, `(timeLeft / ${timerSeconds})`);

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

        addLog(t('exportManager.logs.processed', { name: file.name, id: baseId, rec: routeCorrect }));
        processedCount++;
      } else {
        addLog(t('exportManager.logs.notFound', { name: file.name, id: baseId }));
        folderCorrect?.file(file.name, await file.text());
      }
    }

    if (processedCount > 0) {
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      saveAs(zipBlob, `Updated_Scenarios_${timestamp}.zip`);
      addLog(t('exportManager.logs.done', { count: processedCount }));
    } else {
      addLog(t('exportManager.logs.noChanges'));
    }

    setProcessing(false);
  };

  const styles = {
    container: {
      height: '100%',
      overflowY: 'auto' as const,
      padding: '20px',
      fontFamily: 'Segoe UI, sans-serif',
      direction: dir,
      color: '#e2e8f0',
      boxSizing: 'border-box' as const,
    },
    contentWrapper: { maxWidth: '800px', margin: '0 auto', paddingBottom: '50px' },
    header: { textAlign: 'center' as const, marginBottom: '30px', color: '#60a5fa' },
    card: { background: '#1e293b', borderRadius: '12px', padding: '20px', marginBottom: '20px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' },
    cardHeader: { display: 'flex', alignItems: 'center', marginBottom: '15px', borderBottom: '1px solid #334155', paddingBottom: '10px' },
    stepIcon: {
      width: '30px', height: '30px', borderRadius: '50%', background: '#3b82f6',
      color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontWeight: 'bold',
      [isRtl ? 'marginLeft' : 'marginRight']: '10px',
    },
    input: { width: '100%', padding: '10px', marginTop: '10px', borderRadius: '6px', border: '1px solid #475569', background: '#0f172a', color: 'white' },
    button: { width: '100%', padding: '15px', background: 'linear-gradient(to right, #2563eb, #3b82f6)', color: 'white', border: 'none', borderRadius: '8px', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer', marginTop: '20px', transition: 'transform 0.1s' },
    logBox: { background: '#000', padding: '15px', borderRadius: '8px', height: '200px', overflowY: 'auto' as const, fontFamily: 'monospace', fontSize: '13px', border: '1px solid #333', direction: 'ltr' as const },
    checkboxContainer: { marginTop: '15px', padding: '10px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '6px', display: 'flex', alignItems: 'center' },
  };

  return (
    <div style={styles.container} ref={mainContainerRef}>
      <div style={styles.contentWrapper}>
        <h1 style={styles.header}>{t('exportManager.title')}</h1>

        <section style={styles.card}>
          <div style={styles.cardHeader}>
            <div style={styles.stepIcon as React.CSSProperties}>1</div>
            <h3 style={{ margin: 0, fontSize: '18px' }}>{t('exportManager.section1.title')}</h3>
          </div>
          <p style={{ fontSize: '14px', color: '#94a3b8' }}>{t('exportManager.section1.desc')}</p>
          <input type="file" accept=".xlsx, .xls" onChange={handleExcelUpload} style={styles.input} />
        </section>

        <section style={styles.card}>
          <div style={styles.cardHeader}>
            <div style={styles.stepIcon as React.CSSProperties}>2</div>
            <h3 style={{ margin: 0, fontSize: '18px' }}>{t('exportManager.section2.title')}</h3>
          </div>
          <p style={{ fontSize: '14px', color: '#94a3b8' }}>{t('exportManager.section2.desc')}</p>
          <input type="file" {...({ webkitdirectory: "true" } as any)} multiple onChange={handleHtmlFolderUpload} style={styles.input} />
          {htmlFiles.length > 0 && (
            <div style={{ marginTop: '10px', color: '#4ade80' }}>
              {t('exportManager.section2.filesDetected', { n: htmlFiles.length })}
            </div>
          )}
        </section>

        <section style={styles.card}>
          <div style={styles.cardHeader}>
            <div style={styles.stepIcon as React.CSSProperties}>3</div>
            <h3 style={{ margin: 0, fontSize: '18px' }}>{t('exportManager.section3.title')}</h3>
          </div>
          <textarea
            rows={3}
            placeholder={t('exportManager.section3.cssPlaceholder')}
            value={globalCss}
            onChange={(e) => setGlobalCss(e.target.value)}
            style={{ ...styles.input, fontFamily: 'monospace', direction: 'ltr', resize: 'vertical' }}
          />
          <div style={styles.checkboxContainer}>
            <input
              type="checkbox"
              id="inaccurateMode"
              checked={generateInaccurateMode}
              onChange={(e) => setGenerateInaccurateMode(e.target.checked)}
              style={{ width: '20px', height: '20px', [isRtl ? 'marginLeft' : 'marginRight']: '10px' } as React.CSSProperties}
            />
            <label htmlFor="inaccurateMode" style={{ cursor: 'pointer', color: '#fca5a5', fontWeight: 'bold' }}>
              {t('exportManager.section3.inaccurate')}
            </label>
          </div>
          <div style={{ marginBottom: '15px', padding: '10px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>
            <label style={{ color: '#94a3b8', display: 'block', marginBottom: '8px', fontSize: '14px' }}>
              {t('exportManager.section3.timerLabel')}
            </label>
            <input
              type="number"
              value={timerSeconds}
              onChange={(e) => setTimerSeconds(Math.max(1, Number(e.target.value)))}
              style={{ ...styles.input, width: '100px', textAlign: 'center' }}
            />
          </div>
        </section>

        <button
          onClick={processFiles}
          disabled={processing || !excelMap || htmlFiles.length === 0}
          style={styles.button}
        >
          {processing ? t('exportManager.btn.processing') : t('exportManager.btn.run')}
        </button>

        <div style={{ marginTop: '20px' }}>
          <label style={{ color: '#94a3b8', fontSize: '14px', marginBottom: '5px', display: 'block' }}>
            {t('exportManager.logs.title')}
          </label>
          <div style={styles.logBox}>
            {logs.length === 0
              ? <span style={{ opacity: 0.5 }}>{t('exportManager.logs.empty')}</span>
              : logs.map((l, i) => <div key={i}>{l}</div>)
            }
            <div ref={logsEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default ExportFileManager;
