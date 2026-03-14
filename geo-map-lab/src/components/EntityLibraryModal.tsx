/**
 * EntityLibraryModal.tsx
 * ספריית יישויות מרחביות — הגדרה, עיצוב ושמירה של סוגי יישויות
 */
import { useState, useRef, useCallback, type ReactElement, type ChangeEvent } from "react";

// ══════════════════════════════════════════════ TYPES ══════════════════════════

export type GeometryType   = 'point' | 'line' | 'polygon' | 'circle';
export type StrokeStyle    = 'solid' | 'dashed' | 'dotted' | 'long-dash' | 'double';
export type FillPattern    = 'solid' | 'hatched' | 'crosshatch' | 'dots' | 'diagonal' | 'grid';
export type PointShape     = 'circle' | 'square' | 'triangle' | 'star' | 'diamond' | 'cross' | 'hexagon';
export type ArrowDirection = 'none' | 'forward' | 'backward' | 'both';
export type IconPlacement  = 'center' | 'along-line' | 'scatter-fill';

export interface EntityVisual {
  // ── קו / מסגרת ──
  strokeColor:        string;
  strokeWidth:        number;         // 1–20 px
  strokeStyle:        StrokeStyle;
  strokeOpacity:      number;         // 0–1
  strokeCasingColor:  string;
  strokeCasingWidth:  number;         // 0 = כבוי
  arrowDirection:     ArrowDirection;
  // ── מילוי ──
  fillColor:          string;
  fillOpacity:        number;         // 0–1
  fillPattern:        FillPattern;
  fillPatternAngle:   number;         // 0–180°
  // ── נקודה ──
  pointShape:         PointShape;
  pointSize:          number;         // 8–60 px
  // ── אייקון ──
  icon: {
    enabled:   boolean;
    dataUrl:   string;                // base64 PNG/SVG
    size:      number;                // 0.5–3.0
    placement: IconPlacement;
    spacing:   number;                // מ' — לאורך קו
  };
  // ── תגית טקסט ──
  label: {
    enabled:   boolean;
    text:      string;
    fontSize:  number;                // 10–28 px
    color:     string;
    haloColor: string;
  };
}

export interface EntityTypeDef {
  id:                  string;
  name:                string;
  geometryType:        GeometryType;
  snapToRoad:          boolean;       // true = עוקב ציר, false = חופשי
  visual:              EntityVisual;
  maxInstances:        number;        // 0 = ללא הגבלה
  tags:                string[];
  allowPerInstanceLabel: boolean;
  createdAt:           number;
}

export interface EntityLibrary {
  version:  1;
  entities: EntityTypeDef[];
}

// מופע ספציפי של יישות על המפה
export interface EntityInstance {
  id:       string;
  typeId:   string;
  coords:   [number, number][];   // נקודה = [coord]; קו/פוליגון/עיגול = מערך נקודות
  radiusM?: number;               // לסוג "עיגול" בלבד
  label?:   string;
}

// ══════════════════════════════════════════════ STORAGE ══════════════════════

const STORAGE_KEY = 'geovislab_entity_library';

// IDs קבועים לישויות מובנות — ניתן לייצא לשימוש ב-Planner
export const BUILTIN_TRAFFIC_ID = 'builtin-traffic';
export const BUILTIN_TOLL_ID    = 'builtin-toll';
export const BUILTIN_COMM_ID    = 'builtin-comm';
export const BUILTIN_PARK_ID    = 'builtin-park';
export const ALL_BUILTIN_IDS    = [BUILTIN_TRAFFIC_ID, BUILTIN_TOLL_ID, BUILTIN_COMM_ID, BUILTIN_PARK_ID] as const;

// ══════════════════════════════════════════════ DEFAULTS ══════════════════════

export const DEFAULT_VISUAL: EntityVisual = {
  strokeColor:       '#3b82f6',
  strokeWidth:       3,
  strokeStyle:       'solid',
  strokeOpacity:     1,
  strokeCasingColor: '#1e293b',
  strokeCasingWidth: 0,
  arrowDirection:    'none',
  fillColor:         '#3b82f6',
  fillOpacity:       0.35,
  fillPattern:       'solid',
  fillPatternAngle:  45,
  pointShape:        'circle',
  pointSize:         24,
  icon:  { enabled: false, dataUrl: '', size: 1, placement: 'center', spacing: 100 },
  label: { enabled: false, text: '',   fontSize: 14, color: '#ffffff', haloColor: '#000000' },
};

const mkV = (overrides: Partial<EntityVisual>): EntityVisual => ({
  ...DEFAULT_VISUAL,
  icon:  { ...DEFAULT_VISUAL.icon },
  label: { ...DEFAULT_VISUAL.label },
  ...overrides,
});

const SEED_ENTITIES: EntityTypeDef[] = [
  {
    id: BUILTIN_TRAFFIC_ID, name: 'עומס תנועה', geometryType: 'line',
    snapToRoad: true, maxInstances: 0, tags: ['builtin'], allowPerInstanceLabel: false, createdAt: 0,
    visual: mkV({ strokeColor: '#ef4444', strokeWidth: 4, strokeStyle: 'dashed', strokeOpacity: 1, strokeCasingWidth: 0 }),
  },
  {
    id: BUILTIN_TOLL_ID, name: 'כביש אגרה', geometryType: 'line',
    snapToRoad: true, maxInstances: 0, tags: ['builtin'], allowPerInstanceLabel: false, createdAt: 0,
    visual: mkV({ strokeColor: '#fbbf24', strokeWidth: 4, strokeStyle: 'solid', strokeOpacity: 1, strokeCasingWidth: 2, strokeCasingColor: '#fbbf24' }),
  },
  {
    id: BUILTIN_COMM_ID, name: 'אזור קליטה', geometryType: 'circle',
    snapToRoad: false, maxInstances: 0, tags: ['builtin'], allowPerInstanceLabel: false, createdAt: 0,
    visual: mkV({ strokeColor: '#a855f7', strokeWidth: 2, fillColor: '#a855f7', fillOpacity: 0.18 }),
  },
  {
    id: BUILTIN_PARK_ID, name: 'גן / שטח ירוק', geometryType: 'polygon',
    snapToRoad: false, maxInstances: 0, tags: ['builtin'], allowPerInstanceLabel: false, createdAt: 0,
    visual: mkV({ strokeColor: '#2e7d32', strokeWidth: 2, fillColor: '#c7e6c5', fillOpacity: 0.55 }),
  },
];

export function loadEntityLibrary(): EntityLibrary {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p?.version === 1 && Array.isArray(p.entities)) {
        // הוסף ישויות מובנות חסרות
        const ids = new Set((p.entities as EntityTypeDef[]).map(e => e.id));
        const missing = SEED_ENTITIES.filter(s => !ids.has(s.id));
        if (missing.length > 0) {
          const lib: EntityLibrary = { version: 1, entities: [...missing, ...p.entities] };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(lib));
          return lib;
        }
        return p as EntityLibrary;
      }
    }
  } catch { /* ignore */ }
  // ספרייה ריקה — זרע את הישויות המובנות
  const fresh: EntityLibrary = { version: 1, entities: [...SEED_ENTITIES] };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
  return fresh;
}

export function saveEntityLibraryToStorage(lib: EntityLibrary): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(lib));
}

function newEntity(): EntityTypeDef {
  return {
    id:                   `ent_${Date.now()}`,
    name:                 '',
    geometryType:         'polygon',
    snapToRoad:           false,
    visual:               {
      ...DEFAULT_VISUAL,
      icon:  { ...DEFAULT_VISUAL.icon },
      label: { ...DEFAULT_VISUAL.label },
    },
    maxInstances:         0,
    tags:                 [],
    allowPerInstanceLabel: false,
    createdAt:            Date.now(),
  };
}

// ══════════════════════════════════════════════ PREVIEW SVG ═══════════════════

function getStrokeDasharray(style: StrokeStyle, w: number): string {
  switch (style) {
    case 'dashed':    return `${w * 4} ${w * 2}`;
    case 'dotted':    return `${w} ${w * 2}`;
    case 'long-dash': return `${w * 10} ${w * 3}`;
    default:          return 'none';
  }
}

interface PointProps {
  shape: PointShape; cx: number; cy: number; size: number;
  fill: string; stroke: string; sw: number;
}
function PointShapeSVG({ shape, cx, cy, size, fill, stroke, sw }: PointProps) {
  const r = size / 2;
  const shared = { fill, stroke, strokeWidth: sw };
  switch (shape) {
    case 'circle':
      return <circle cx={cx} cy={cy} r={r} {...shared} />;
    case 'square':
      return <rect x={cx - r} y={cy - r} width={size} height={size} {...shared} />;
    case 'diamond': {
      const p = `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
      return <polygon points={p} {...shared} />;
    }
    case 'triangle': {
      const p = `${cx},${cy - r} ${cx + r * 0.9},${cy + r * 0.8} ${cx - r * 0.9},${cy + r * 0.8}`;
      return <polygon points={p} {...shared} />;
    }
    case 'star': {
      const pts: string[] = [];
      for (let i = 0; i < 10; i++) {
        const a = (i * Math.PI) / 5 - Math.PI / 2;
        const rr = i % 2 === 0 ? r : r * 0.42;
        pts.push(`${cx + rr * Math.cos(a)},${cy + rr * Math.sin(a)}`);
      }
      return <polygon points={pts.join(' ')} {...shared} />;
    }
    case 'hexagon': {
      const pts: string[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3 - Math.PI / 6;
        pts.push(`${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`);
      }
      return <polygon points={pts.join(' ')} {...shared} />;
    }
    case 'cross': {
      const t = r * 0.32;
      const p = [
        `${cx - t},${cy - r}`, `${cx + t},${cy - r}`, `${cx + t},${cy - t}`,
        `${cx + r},${cy - t}`, `${cx + r},${cy + t}`, `${cx + t},${cy + t}`,
        `${cx + t},${cy + r}`, `${cx - t},${cy + r}`, `${cx - t},${cy + t}`,
        `${cx - r},${cy + t}`, `${cx - r},${cy - t}`, `${cx - t},${cy - t}`,
      ].join(' ');
      return <polygon points={p} {...shared} />;
    }
    default:
      return <circle cx={cx} cy={cy} r={r} {...shared} />;
  }
}

function EntityPreview({ def }: { def: EntityTypeDef }) {
  const W = 260, H = 130;
  const v   = def.visual;
  const pid = `fp_${def.id.replace(/[^a-z0-9]/gi, '_')}`;
  const da  = getStrokeDasharray(v.strokeStyle, v.strokeWidth);
  const cw  = v.strokeCasingWidth;

  // Build SVG fill-pattern
  let fillRef  = v.fillColor;
  let patDef: ReactElement | null = null;
  if (v.fillPattern !== 'solid') {
    const pc = v.strokeColor;
    const ps = 10;
    const a  = v.fillPatternAngle;
    if (v.fillPattern === 'hatched') {
      patDef = (
        <pattern id={pid} width={ps} height={ps} patternTransform={`rotate(${a})`} patternUnits="userSpaceOnUse">
          <line x1="0" y1="0" x2="0" y2={ps} stroke={pc} strokeWidth="1.5" />
        </pattern>
      );
    } else if (v.fillPattern === 'crosshatch') {
      patDef = (
        <pattern id={pid} width={ps} height={ps} patternUnits="userSpaceOnUse">
          <line x1="0" y1="0" x2="0" y2={ps} stroke={pc} strokeWidth="1.5" />
          <line x1="0" y1="0" x2={ps} y2="0" stroke={pc} strokeWidth="1.5" />
        </pattern>
      );
    } else if (v.fillPattern === 'dots') {
      patDef = (
        <pattern id={pid} width={ps} height={ps} patternUnits="userSpaceOnUse">
          <circle cx={ps / 2} cy={ps / 2} r="1.8" fill={pc} />
        </pattern>
      );
    } else if (v.fillPattern === 'diagonal') {
      patDef = (
        <pattern id={pid} width={ps} height={ps} patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
          <line x1="0" y1="0" x2="0" y2={ps} stroke={pc} strokeWidth="2.5" />
        </pattern>
      );
    } else if (v.fillPattern === 'grid') {
      patDef = (
        <pattern id={pid} width={ps * 2} height={ps * 2} patternUnits="userSpaceOnUse">
          <rect width={ps * 2} height={ps * 2} fill="none" stroke={pc} strokeWidth="1" />
        </pattern>
      );
    }
    fillRef = `url(#${pid})`;
  }
  const fillOpacity = v.fillPattern === 'solid' ? v.fillOpacity : 1;

  return (
    <svg
      width={W} height={H}
      style={{ background: '#0f172a', borderRadius: 10, display: 'block' }}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>{patDef}</defs>

      {/* Line */}
      {def.geometryType === 'line' && (() => {
        const d = `M 14,${H * 0.68} C 55,${H * 0.68} 75,${H * 0.28} 130,${H * 0.5} S 195,${H * 0.62} ${W - 14},${H * 0.34}`;
        return (
          <>
            {cw > 0 && <path d={d} fill="none" stroke={v.strokeCasingColor} strokeWidth={v.strokeWidth + cw * 2} strokeLinecap="round" />}
            <path d={d} fill="none" stroke={v.strokeColor} strokeWidth={v.strokeWidth}
              strokeOpacity={v.strokeOpacity} strokeDasharray={da} strokeLinecap="round" />
            {v.arrowDirection !== 'none' && (
              <polygon
                points={`${W * 0.52},${H * 0.42} ${W * 0.52 + 9},${H * 0.56} ${W * 0.52 - 9},${H * 0.56}`}
                fill={v.strokeColor} fillOpacity={v.strokeOpacity}
              />
            )}
          </>
        );
      })()}

      {/* Polygon */}
      {def.geometryType === 'polygon' && (
        <polygon
          points={`${W * 0.1},${H * 0.2} ${W * 0.88},${H * 0.14} ${W * 0.92},${H * 0.82} ${W * 0.5},${H * 0.91} ${W * 0.08},${H * 0.74}`}
          fill={fillRef} fillOpacity={fillOpacity}
          stroke={v.strokeColor} strokeWidth={v.strokeWidth}
          strokeOpacity={v.strokeOpacity} strokeDasharray={da}
        />
      )}

      {/* Circle */}
      {def.geometryType === 'circle' && (
        <circle cx={W / 2} cy={H / 2} r={50}
          fill={fillRef} fillOpacity={fillOpacity}
          stroke={v.strokeColor} strokeWidth={v.strokeWidth}
          strokeOpacity={v.strokeOpacity}
        />
      )}

      {/* Point */}
      {def.geometryType === 'point' && (
        <PointShapeSVG
          shape={v.pointShape} cx={W / 2} cy={H / 2} size={v.pointSize * 1.6}
          fill={v.fillColor} stroke={v.strokeColor} sw={v.strokeWidth}
        />
      )}

      {/* Double-stroke overlay */}
      {v.strokeStyle === 'double' && def.geometryType === 'line' && (() => {
        const d2 = `M 14,${H * 0.68} C 55,${H * 0.68} 75,${H * 0.28} 130,${H * 0.5} S 195,${H * 0.62} ${W - 14},${H * 0.34}`;
        return (
          <>
            <path d={d2} fill="none" stroke={v.strokeColor} strokeWidth={v.strokeWidth + 4} strokeOpacity={v.strokeOpacity} strokeLinecap="round" />
            <path d={d2} fill="none" stroke={v.strokeCasingColor || '#0f172a'} strokeWidth={v.strokeWidth} strokeLinecap="round" />
          </>
        );
      })()}

      {/* Icon */}
      {v.icon.enabled && v.icon.dataUrl && (
        <image
          href={v.icon.dataUrl}
          x={W / 2 - 18 * v.icon.size} y={H / 2 - 18 * v.icon.size}
          width={36 * v.icon.size} height={36 * v.icon.size}
        />
      )}

      {/* Label */}
      {v.label.enabled && (v.label.text || def.name) && (
        <text
          x={W / 2} y={H - 9} textAnchor="middle"
          fill={v.label.color} fontSize={Math.min(v.label.fontSize, 15)}
          stroke={v.label.haloColor} strokeWidth="3" paintOrder="stroke"
          style={{ fontFamily: 'system-ui, sans-serif' }}
        >
          {v.label.text || def.name}
        </text>
      )}
    </svg>
  );
}

// ══════════════════════════════════════════════ CONSTANTS ════════════════════

const GEOM_TYPES: { key: GeometryType; label: string; icon: string }[] = [
  { key: 'point',   label: 'נקודה',   icon: '●' },
  { key: 'line',    label: 'קו',      icon: '⟋' },
  { key: 'polygon', label: 'פוליגון', icon: '⬡' },
  { key: 'circle',  label: 'עיגול',   icon: '○' },
];

const STROKE_STYLES: { key: StrokeStyle; label: string; preview: string }[] = [
  { key: 'solid',     label: 'רציף',         preview: '───' },
  { key: 'dashed',    label: 'מקווקו',       preview: '╌╌╌' },
  { key: 'dotted',    label: 'נקודות',       preview: '···' },
  { key: 'long-dash', label: 'מקווקו ארוך',  preview: '━ ━' },
  { key: 'double',    label: 'כפול',         preview: '═══' },
];

const FILL_PATTERNS: { key: FillPattern; label: string }[] = [
  { key: 'solid',      label: 'מוצק'   },
  { key: 'hatched',    label: 'פסים'   },
  { key: 'crosshatch', label: 'סריג'   },
  { key: 'dots',       label: 'נקודות' },
  { key: 'diagonal',   label: 'אלכסון' },
  { key: 'grid',       label: 'תצרת'   },
];

const POINT_SHAPES: { key: PointShape; emoji: string; label: string }[] = [
  { key: 'circle',   emoji: '●', label: 'עיגול'   },
  { key: 'square',   emoji: '■', label: 'ריבוע'   },
  { key: 'triangle', emoji: '▲', label: 'משולש'   },
  { key: 'star',     emoji: '★', label: 'כוכב'    },
  { key: 'diamond',  emoji: '◆', label: 'מעוין'   },
  { key: 'cross',    emoji: '✚', label: 'צלב'     },
  { key: 'hexagon',  emoji: '⬡', label: 'משושה'   },
];

const ARROW_DIRS: { key: ArrowDirection; label: string }[] = [
  { key: 'none',     label: 'ללא' },
  { key: 'forward',  label: '→'   },
  { key: 'backward', label: '←'   },
  { key: 'both',     label: '↔'   },
];

const ICON_PLACEMENTS: { key: IconPlacement; label: string }[] = [
  { key: 'center',       label: 'מרכז'        },
  { key: 'along-line',   label: 'לאורך קו'    },
  { key: 'scatter-fill', label: 'פיזור בשטח'  },
];

type VisualTab = 'stroke' | 'fill' | 'shape' | 'icon' | 'label';

// ══════════════════════════════════════════════ MODAL ════════════════════════

interface ModalProps {
  isOpen:          boolean;
  onClose:         () => void;
  onLibraryChange?: (lib: EntityLibrary) => void;
  dir?:            string;
}

export function EntityLibraryModal({ isOpen, onClose, onLibraryChange, dir = 'rtl' }: ModalProps) {
  const [library,    setLibrary]    = useState<EntityLibrary>(() => loadEntityLibrary());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editDef,    setEditDef]    = useState<EntityTypeDef | null>(null);
  const [activeTab,  setActiveTab]  = useState<VisualTab>('stroke');
  const [tagInput,   setTagInput]   = useState('');

  const fileInputRef   = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // ── Helpers ──

  const persistLib = useCallback((lib: EntityLibrary) => {
    setLibrary(lib);
    saveEntityLibraryToStorage(lib);
    onLibraryChange?.(lib);
  }, [onLibraryChange]);

  // Patch editDef AND immediately persist to library
  const patchDef = useCallback((patch: Partial<EntityTypeDef>) => {
    setEditDef(prev => {
      if (!prev) return prev;
      const next: EntityTypeDef = { ...prev, ...patch };
      setLibrary(lib => {
        const updated = { ...lib, entities: lib.entities.map(e => e.id === next.id ? next : e) };
        saveEntityLibraryToStorage(updated);
        onLibraryChange?.(updated);
        return updated;
      });
      return next;
    });
  }, [onLibraryChange]);

  const patchVisual = useCallback((patch: Partial<EntityVisual>) => {
    setEditDef(prev => {
      if (!prev) return prev;
      const next: EntityTypeDef = { ...prev, visual: { ...prev.visual, ...patch } };
      setLibrary(lib => {
        const updated = { ...lib, entities: lib.entities.map(e => e.id === next.id ? next : e) };
        saveEntityLibraryToStorage(updated);
        onLibraryChange?.(updated);
        return updated;
      });
      return next;
    });
  }, [onLibraryChange]);

  const patchIcon  = (p: Partial<EntityVisual['icon']>)  => patchVisual({ icon:  { ...editDef!.visual.icon,  ...p } });
  const patchLabel = (p: Partial<EntityVisual['label']>) => patchVisual({ label: { ...editDef!.visual.label, ...p } });

  // ── Actions ──

  const handleNew = () => {
    const entity = newEntity();
    const lib: EntityLibrary = { ...library, entities: [...library.entities, entity] };
    persistLib(lib);
    setLibrary(lib);
    setSelectedId(entity.id);
    setEditDef(entity);
    setActiveTab('stroke');
  };

  const handleSelect = (id: string) => {
    const found = library.entities.find(e => e.id === id);
    if (!found) return;
    setSelectedId(id);
    setEditDef({ ...found, visual: { ...found.visual, icon: { ...found.visual.icon }, label: { ...found.visual.label } } });
    setActiveTab('stroke');
  };

  const handleDelete = () => {
    if (!selectedId) return;
    if (!confirm('למחוק יישות זו מהספריה?')) return;
    const lib: EntityLibrary = { ...library, entities: library.entities.filter(e => e.id !== selectedId) };
    persistLib(lib);
    setSelectedId(null);
    setEditDef(null);
  };

  const handleDuplicate = () => {
    if (!editDef) return;
    const copy: EntityTypeDef = { ...editDef, id: `ent_${Date.now()}`, name: `${editDef.name} (עותק)`, createdAt: Date.now() };
    const lib: EntityLibrary = { ...library, entities: [...library.entities, copy] };
    persistLib(lib);
    setSelectedId(copy.id);
    setEditDef(copy);
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(library, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'entity-library.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        if (parsed?.version === 1 && Array.isArray(parsed.entities)) {
          persistLib(parsed as EntityLibrary);
          setSelectedId(null);
          setEditDef(null);
        } else {
          alert('קובץ ספריה לא תקין');
        }
      } catch { alert('שגיאה בקריאת הקובץ'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleIconUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      if (typeof ev.target?.result === 'string')
        patchIcon({ dataUrl: ev.target.result, enabled: true });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const addTag = () => {
    const tag = tagInput.trim();
    if (!tag || !editDef || editDef.tags.includes(tag)) { setTagInput(''); return; }
    patchDef({ tags: [...editDef.tags, tag] });
    setTagInput('');
  };

  // ── Derived ──

  if (!isOpen) return null;

  const availableTabs: VisualTab[] = ['stroke'];
  if (editDef && (editDef.geometryType === 'polygon' || editDef.geometryType === 'circle')) availableTabs.push('fill');
  if (editDef && editDef.geometryType === 'point') availableTabs.push('shape');
  availableTabs.push('icon', 'label');

  const geomColor = (e: EntityTypeDef) =>
    e.geometryType === 'line' ? e.visual.strokeColor : e.visual.fillColor;

  // ── Styles ──

  const BG   = '#0b0f17';
  const BDR  = 'rgba(255,255,255,0.1)';
  const font = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

  const btn = (active?: boolean, danger?: boolean) => ({
    padding: '6px 13px',
    borderRadius: 8,
    cursor: 'pointer' as const,
    fontSize: 13,
    border: `1px solid ${danger ? 'rgba(239,68,68,0.35)' : active ? 'rgba(59,130,246,0.4)' : BDR}`,
    background: danger ? 'rgba(239,68,68,0.12)' : active ? 'rgba(59,130,246,0.22)' : 'rgba(255,255,255,0.07)',
    color: danger ? '#fca5a5' : active ? '#93c5fd' : '#cbd5e1',
    fontWeight: active || danger ? 700 : 400 as number,
    fontFamily: font,
    transition: 'all 0.15s',
  });

  const tab = (active: boolean) => ({
    padding: '7px 16px',
    cursor: 'pointer' as const,
    background: 'none',
    color: active ? '#93c5fd' : 'rgba(255,255,255,0.45)',
    fontWeight: active ? 700 : 400 as number,
    fontSize: 13,
    border: 'none',
    borderBottom: active ? '2px solid #3b82f6' : '2px solid transparent',
    fontFamily: font,
  });

  const inp = {
    padding: '7px 10px',
    background: 'rgba(255,255,255,0.07)',
    border: `1px solid ${BDR}`,
    borderRadius: 8,
    color: 'white',
    fontSize: 14,
    fontFamily: font,
    boxSizing: 'border-box' as const,
  };

  const clr = (value: string, onChange: (v: string) => void) => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input
        type="color" value={value} onChange={e => onChange(e.target.value)}
        style={{ width: 42, height: 34, border: 'none', borderRadius: 6, cursor: 'pointer', background: 'transparent', padding: 0 }}
      />
      <input
        value={value} onChange={e => onChange(e.target.value)}
        style={{ ...inp, width: 100, fontSize: 12 }}
      />
    </div>
  );

  const sliderRow = (label: string, value: number, min: number, max: number, onChange: (n: number) => void, suffix = '') => (
    <div>
      <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>{label}: <b>{value}{suffix}</b></div>
      <input
        type="range" min={min} max={max} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#3b82f6' }}
      />
    </div>
  );

  const fieldLabel = (s: string) => (
    <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 4, fontWeight: 600 }}>{s}</div>
  );

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.68)',
        zIndex: 10100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16, direction: dir as 'rtl' | 'ltr',
        fontFamily: font,
      }}
      onMouseDown={onClose}
    >
      <div
        style={{
          width: 'min(1120px, 96vw)',
          height: '90vh',
          background: BG,
          border: `1px solid ${BDR}`,
          borderRadius: 16,
          boxShadow: '0 28px 64px rgba(0,0,0,0.55)',
          color: '#e8eefc',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
        onMouseDown={e => e.stopPropagation()}
      >

        {/* ══ Header ══ */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 18px', borderBottom: `1px solid ${BDR}`, flexShrink: 0,
        }}>
          <div style={{ fontWeight: 700, fontSize: 17 }}>🗂 ספריית יישויות מרחביות</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={handleExport} style={btn()}>⬇ ייצא JSON</button>
            <button onClick={() => importInputRef.current?.click()} style={btn()}>⬆ טען JSON</button>
            <input ref={importInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImport} />
            <button onClick={onClose} style={{ ...btn(), padding: '6px 14px' }}>✕ סגור</button>
          </div>
        </div>

        {/* ══ Body ══ */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* ── Left: Entity list ── */}
          <div style={{
            width: 230, flexShrink: 0,
            borderLeft: `1px solid ${BDR}`,
            display: 'flex', flexDirection: 'column',
            overflow: 'hidden',
          }}>
            <div style={{ padding: '10px 12px', borderBottom: `1px solid rgba(255,255,255,0.07)` }}>
              <button onClick={handleNew} style={{ ...btn(true), width: '100%', padding: '9px', textAlign: 'center', fontWeight: 700 }}>
                + יישות חדשה
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
              {library.entities.length === 0 && (
                <div style={{ padding: 20, textAlign: 'center', opacity: 0.35, fontSize: 13, lineHeight: 1.6 }}>
                  אין יישויות.<br />לחץ "+ יישות חדשה"
                </div>
              )}
              {library.entities.map(e => (
                <div
                  key={e.id}
                  onClick={() => handleSelect(e.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '9px 14px', cursor: 'pointer',
                    background: e.id === selectedId ? 'rgba(59,130,246,0.15)' : 'transparent',
                    borderRight: e.id === selectedId ? '3px solid #3b82f6' : '3px solid transparent',
                    transition: 'background 0.13s',
                  }}
                >
                  {/* Color preview */}
                  <div style={{
                    width: 14, height: 14, borderRadius: e.geometryType === 'circle' ? '50%' : 3,
                    background: geomColor(e), flexShrink: 0,
                    border: '1px solid rgba(255,255,255,0.18)',
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {e.name || '(ללא שם)'}
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.45 }}>
                      {GEOM_TYPES.find(g => g.key === e.geometryType)?.label}
                      {' · '}
                      {e.snapToRoad ? 'ציר' : 'חופשי'}
                      {e.maxInstances > 0 ? ` · מקס ${e.maxInstances}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{
              padding: '8px 12px', borderTop: `1px solid rgba(255,255,255,0.07)`,
              fontSize: 11, opacity: 0.35, textAlign: 'center',
            }}>
              {library.entities.length} יישויות
            </div>
          </div>

          {/* ── Right: Editor ── */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>

            {!editDef ? (
              <div style={{
                display: 'flex', height: '100%',
                alignItems: 'center', justifyContent: 'center',
                opacity: 0.28, fontSize: 15, flexDirection: 'column', gap: 10,
              }}>
                <div style={{ fontSize: 40 }}>🗺</div>
                <div>בחר יישות מהרשימה או צור יישות חדשה</div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>

                {/* ─ Editor column ─ */}
                <div style={{ flex: 1, minWidth: 0 }}>

                  {/* ── Basic Info ── */}
                  <div style={{
                    background: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: 14, marginBottom: 14,
                    border: `1px solid rgba(255,255,255,0.07)`,
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.45, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
                      פרטים כלליים
                    </div>

                    {/* Name */}
                    <div style={{ marginBottom: 12 }}>
                      {fieldLabel('שם היישות')}
                      <input
                        style={{ ...inp, width: '100%' }}
                        placeholder="למשל: גן ילדים, איכות כביש, שצ״פ..."
                        value={editDef.name}
                        onChange={e => patchDef({ name: e.target.value })}
                      />
                    </div>

                    {/* Geometry type */}
                    <div style={{ marginBottom: 12 }}>
                      {fieldLabel('סוג גאומטריה')}
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {GEOM_TYPES.map(g => (
                          <button
                            key={g.key}
                            style={btn(editDef.geometryType === g.key)}
                            onClick={() => patchDef({ geometryType: g.key })}
                          >
                            {g.icon} {g.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Snap + Max + per-instance */}
                    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                      <div>
                        {fieldLabel('מצב עקיבה')}
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button style={btn(!editDef.snapToRoad)} onClick={() => patchDef({ snapToRoad: false })}>🖊 חופשי</button>
                          <button style={btn(editDef.snapToRoad)}  onClick={() => patchDef({ snapToRoad: true  })}>🛣 עוקב ציר</button>
                        </div>
                      </div>
                      <div>
                        {fieldLabel('כמות מרבית (0 = ללא הגבלה)')}
                        <input
                          type="number" min="0" max="999" value={editDef.maxInstances}
                          onChange={e => patchDef({ maxInstances: Math.max(0, Number(e.target.value)) })}
                          style={{ ...inp, width: 90 }}
                        />
                      </div>
                      <div>
                        {fieldLabel('תגית לכל מופע')}
                        <button
                          style={btn(editDef.allowPerInstanceLabel)}
                          onClick={() => patchDef({ allowPerInstanceLabel: !editDef.allowPerInstanceLabel })}
                        >
                          {editDef.allowPerInstanceLabel ? '✓ כן' : '✗ לא'}
                        </button>
                      </div>
                    </div>

                    {/* Tags */}
                    <div style={{ marginTop: 12 }}>
                      {fieldLabel('תגיות')}
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                        {editDef.tags.map(tag => (
                          <span
                            key={tag}
                            style={{
                              background: 'rgba(59,130,246,0.18)', border: '1px solid rgba(59,130,246,0.3)',
                              borderRadius: 20, padding: '3px 10px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5,
                            }}
                          >
                            #{tag}
                            <span
                              style={{ opacity: 0.55, cursor: 'pointer', fontWeight: 700 }}
                              onClick={() => patchDef({ tags: editDef.tags.filter(t => t !== tag) })}
                            >×</span>
                          </span>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input
                          style={{ ...inp, flex: 1 }}
                          placeholder="הוסף תגית ולחץ Enter..."
                          value={tagInput}
                          onChange={e => setTagInput(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && addTag()}
                        />
                        <button style={btn()} onClick={addTag}>+ הוסף</button>
                      </div>
                    </div>
                  </div>

                  {/* ── Visual Editor ── */}
                  <div style={{
                    background: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: 14, marginBottom: 14,
                    border: `1px solid rgba(255,255,255,0.07)`,
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.45, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
                      עיצוב ויזואלי
                    </div>

                    {/* Tab bar */}
                    <div style={{
                      display: 'flex', gap: 0,
                      borderBottom: `1px solid rgba(255,255,255,0.1)`,
                      marginBottom: 16,
                    }}>
                      {availableTabs.map(t => {
                        const labels: Record<VisualTab, string> = {
                          stroke: 'קו / מסגרת', fill: 'מילוי', shape: 'צורת נקודה', icon: 'אייקון', label: 'תגית',
                        };
                        return (
                          <button key={t} style={tab(activeTab === t)} onClick={() => setActiveTab(t)}>
                            {labels[t]}
                          </button>
                        );
                      })}
                    </div>

                    {/* ── Stroke tab ── */}
                    {activeTab === 'stroke' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                          <div>
                            {fieldLabel('צבע קו')}
                            {clr(editDef.visual.strokeColor, v => patchVisual({ strokeColor: v }))}
                          </div>
                          <div style={{ flex: 1, minWidth: 140 }}>
                            {sliderRow('עובי', editDef.visual.strokeWidth, 1, 20, v => patchVisual({ strokeWidth: v }), 'px')}
                          </div>
                          <div style={{ flex: 1, minWidth: 140 }}>
                            {sliderRow('שקיפות', Math.round(editDef.visual.strokeOpacity * 100), 0, 100, v => patchVisual({ strokeOpacity: v / 100 }), '%')}
                          </div>
                        </div>

                        <div>
                          {fieldLabel('סגנון קו')}
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {STROKE_STYLES.map(s => (
                              <button
                                key={s.key}
                                style={{ ...btn(editDef.visual.strokeStyle === s.key), fontFamily: 'monospace' }}
                                onClick={() => patchVisual({ strokeStyle: s.key })}
                              >
                                <span style={{ marginLeft: 6, fontFamily: 'monospace', letterSpacing: 2 }}>{s.preview}</span> {s.label}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                          <div>
                            {fieldLabel('צבע מסגרת (Casing)')}
                            {clr(editDef.visual.strokeCasingColor, v => patchVisual({ strokeCasingColor: v }))}
                          </div>
                          <div style={{ flex: 1, minWidth: 160 }}>
                            {sliderRow('עובי מסגרת (0 = כבוי)', editDef.visual.strokeCasingWidth, 0, 12, v => patchVisual({ strokeCasingWidth: v }), 'px')}
                          </div>
                        </div>

                        {(editDef.geometryType === 'line') && (
                          <div>
                            {fieldLabel('חץ כיוון')}
                            <div style={{ display: 'flex', gap: 8 }}>
                              {ARROW_DIRS.map(a => (
                                <button key={a.key} style={btn(editDef.visual.arrowDirection === a.key)}
                                  onClick={() => patchVisual({ arrowDirection: a.key })}>
                                  {a.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* ── Fill tab ── */}
                    {activeTab === 'fill' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                          <div>
                            {fieldLabel('צבע מילוי')}
                            {clr(editDef.visual.fillColor, v => patchVisual({ fillColor: v }))}
                          </div>
                          <div style={{ flex: 1, minWidth: 160 }}>
                            {sliderRow('שקיפות מילוי', Math.round(editDef.visual.fillOpacity * 100), 0, 100, v => patchVisual({ fillOpacity: v / 100 }), '%')}
                          </div>
                        </div>

                        <div>
                          {fieldLabel('תבנית מילוי')}
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {FILL_PATTERNS.map(p => (
                              <button key={p.key} style={btn(editDef.visual.fillPattern === p.key)}
                                onClick={() => patchVisual({ fillPattern: p.key })}>
                                {p.label}
                              </button>
                            ))}
                          </div>
                        </div>

                        {editDef.visual.fillPattern !== 'solid' && editDef.visual.fillPattern !== 'crosshatch'
                          && editDef.visual.fillPattern !== 'dots' && editDef.visual.fillPattern !== 'grid' && (
                          <div>
                            {sliderRow('זווית תבנית', editDef.visual.fillPatternAngle, 0, 180, v => patchVisual({ fillPatternAngle: v }), '°')}
                          </div>
                        )}
                      </div>
                    )}

                    {/* ── Shape tab (point) ── */}
                    {activeTab === 'shape' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        <div>
                          {fieldLabel('צורת נקודה')}
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {POINT_SHAPES.map(s => (
                              <button
                                key={s.key}
                                title={s.label}
                                style={{ ...btn(editDef.visual.pointShape === s.key), fontSize: 22, padding: '4px 14px' }}
                                onClick={() => patchVisual({ pointShape: s.key })}
                              >
                                {s.emoji}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                          <div style={{ flex: 1, minWidth: 140 }}>
                            {sliderRow('גודל', editDef.visual.pointSize, 8, 60, v => patchVisual({ pointSize: v }), 'px')}
                          </div>
                          <div>
                            {fieldLabel('צבע מילוי')}
                            {clr(editDef.visual.fillColor, v => patchVisual({ fillColor: v }))}
                          </div>
                          <div>
                            {fieldLabel('צבע מסגרת')}
                            {clr(editDef.visual.strokeColor, v => patchVisual({ strokeColor: v }))}
                          </div>
                          <div style={{ minWidth: 120 }}>
                            {sliderRow('עובי מסגרת', editDef.visual.strokeWidth, 0, 10, v => patchVisual({ strokeWidth: v }), 'px')}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* ── Icon tab ── */}
                    {activeTab === 'icon' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14 }}>
                          <input
                            type="checkbox" checked={editDef.visual.icon.enabled}
                            onChange={e => patchIcon({ enabled: e.target.checked })}
                            style={{ width: 16, height: 16 }}
                          />
                          הפעל אייקון מותאם
                        </label>

                        {editDef.visual.icon.enabled && (
                          <>
                            <div>
                              {fieldLabel('קובץ אייקון (PNG / SVG / GIF)')}
                              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                                <button style={btn()} onClick={() => fileInputRef.current?.click()}>📂 בחר קובץ</button>
                                <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleIconUpload} />
                                {editDef.visual.icon.dataUrl ? (
                                  <>
                                    <img
                                      src={editDef.visual.icon.dataUrl}
                                      style={{ width: 48, height: 48, objectFit: 'contain', borderRadius: 8, background: 'rgba(255,255,255,0.1)', padding: 4 }}
                                    />
                                    <button style={btn(false, true)} onClick={() => patchIcon({ dataUrl: '' })}>× הסר</button>
                                  </>
                                ) : (
                                  <span style={{ opacity: 0.4, fontSize: 13 }}>לא נטען קובץ</span>
                                )}
                              </div>
                            </div>

                            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                              <div style={{ flex: 1, minWidth: 160 }}>
                                {sliderRow('גודל אייקון', +(editDef.visual.icon.size * 10).toFixed(0), 5, 30, v => patchIcon({ size: v / 10 }), `× (${editDef.visual.icon.size.toFixed(1)})`)}
                              </div>
                            </div>

                            <div>
                              {fieldLabel('מיקום אייקון')}
                              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                {ICON_PLACEMENTS.map(p => (
                                  <button key={p.key} style={btn(editDef.visual.icon.placement === p.key)}
                                    onClick={() => patchIcon({ placement: p.key })}>
                                    {p.label}
                                  </button>
                                ))}
                              </div>
                            </div>

                            {editDef.visual.icon.placement === 'along-line' && (
                              <div>
                                {sliderRow('מרווח לאורך קו', editDef.visual.icon.spacing, 20, 500, v => patchIcon({ spacing: v }), 'מ\'')}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}

                    {/* ── Label tab ── */}
                    {activeTab === 'label' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14 }}>
                          <input
                            type="checkbox" checked={editDef.visual.label.enabled}
                            onChange={e => patchLabel({ enabled: e.target.checked })}
                            style={{ width: 16, height: 16 }}
                          />
                          הצג תגית טקסט על המפה
                        </label>

                        {editDef.visual.label.enabled && (
                          <>
                            <div>
                              {fieldLabel('טקסט קבוע (ריק = שם המופע)')}
                              <input
                                style={{ ...inp, width: '100%' }}
                                placeholder="טקסט שיוצג על המפה..."
                                value={editDef.visual.label.text}
                                onChange={e => patchLabel({ text: e.target.value })}
                              />
                            </div>
                            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                              <div style={{ flex: 1, minWidth: 160 }}>
                                {sliderRow('גודל פונט', editDef.visual.label.fontSize, 10, 28, v => patchLabel({ fontSize: v }), 'px')}
                              </div>
                              <div>
                                {fieldLabel('צבע טקסט')}
                                {clr(editDef.visual.label.color, v => patchLabel({ color: v }))}
                              </div>
                              <div>
                                {fieldLabel('צבע הילה (Halo)')}
                                {clr(editDef.visual.label.haloColor, v => patchLabel({ haloColor: v }))}
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  {/* ── Action buttons ── */}
                  <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                    <button style={btn()} onClick={handleDuplicate}>⎘ שכפל</button>
                    <button style={btn(false, true)} onClick={handleDelete}>🗑 מחק יישות</button>
                  </div>
                </div>

                {/* ─ Preview column ─ */}
                <div style={{ width: 272, flexShrink: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.45, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
                    תצוגה מקדימה
                  </div>
                  <EntityPreview def={editDef} />
                  <div style={{ marginTop: 10, fontSize: 11, opacity: 0.38, lineHeight: 1.6 }}>
                    <b>{editDef.name || '(ללא שם)'}</b><br />
                    {GEOM_TYPES.find(g => g.key === editDef.geometryType)?.label}
                    {' · '}
                    {editDef.snapToRoad ? 'עוקב ציר' : 'ציור חופשי'}
                    {editDef.maxInstances > 0 ? ` · מקס ${editDef.maxInstances}` : ' · ללא הגבלה'}
                  </div>

                  {/* Color palette summary */}
                  <div style={{ marginTop: 14 }}>
                    <div style={{ fontSize: 11, opacity: 0.45, marginBottom: 6 }}>צבעים:</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {[
                        { color: editDef.visual.strokeColor, title: 'קו' },
                        { color: editDef.visual.fillColor,   title: 'מילוי' },
                        { color: editDef.visual.label.color, title: 'תגית' },
                      ].map(({ color, title }) => (
                        <div key={title} title={title} style={{
                          width: 28, height: 28, borderRadius: 6,
                          background: color,
                          border: '1px solid rgba(255,255,255,0.2)',
                        }} />
                      ))}
                    </div>
                  </div>

                  {/* Tags preview */}
                  {editDef.tags.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 11, opacity: 0.45, marginBottom: 6 }}>תגיות:</div>
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                        {editDef.tags.map(t => (
                          <span key={t} style={{
                            background: 'rgba(59,130,246,0.15)', borderRadius: 12,
                            padding: '2px 8px', fontSize: 11, opacity: 0.75,
                          }}>#{t}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
