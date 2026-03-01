import { useState } from 'react';
import { Routes, Route, Link } from 'react-router-dom';
import ExportFileManager from './components/ExportFileManager';
import Planner from './components/Planner';
import BatchGenerator from './components/BatchGenerator';
import { useLanguage } from './i18n/index.tsx';

const AVAILABLE_LANGS = [
  { code: 'he', label: 'עברית' },
  { code: 'en', label: 'English' },
];

function App() {
  const { dir, t, lang, setLang } = useLanguage();
  const isRtl = dir === 'rtl';

  const [menuOpen, setMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);

  const toggleMenu = () => setMenuOpen(!menuOpen);
  const closeMenu = () => { setMenuOpen(false); setAboutOpen(false); setLangOpen(false); };

  const toggleAbout = (e: React.MouseEvent) => {
    e.stopPropagation();
    setAboutOpen(!aboutOpen);
    setLangOpen(false);
  };

  const toggleLangPanel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setLangOpen(!langOpen);
    setAboutOpen(false);
  };

  const menuItemStyle: React.CSSProperties = {
    padding: '15px',
    color: 'white',
    textDecoration: 'none',
    borderBottom: '1px solid #475569',
    transition: 'background 0.2s',
    textAlign: isRtl ? 'right' : 'left',
    display: 'block',
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#0b0f17', color: '#e2e8f0', fontFamily: 'Arial, sans-serif' }}>

      {/* Header */}
      <header style={{
        height: '40px',
        display: 'flex',
        alignItems: 'center',
        padding: '0 15px',
        background: '#1e293b',
        borderBottom: '1px solid #334155',
        flexShrink: 0,
        position: 'relative',
        zIndex: 1000,
        direction: dir,
      }}>

        <button
          onClick={toggleMenu}
          style={{
            background: 'transparent', border: 'none', color: '#fff',
            fontSize: '24px', cursor: 'pointer', padding: '0', lineHeight: '1',
            [isRtl ? 'marginLeft' : 'marginRight']: '15px',
          } as React.CSSProperties}
          title={t('menu.navTitle')}
        >
          &#9776;
        </button>

        <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 'bold', letterSpacing: '1px' }}>
          GeoVisLab
        </h1>

        {/* Floating menu */}
        {menuOpen && (
          <>
            <div onClick={closeMenu} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1001 }} />
            <nav style={{
              position: 'absolute',
              top: '45px',
              [isRtl ? 'right' : 'left']: '10px',
              width: '280px',
              background: '#334155',
              border: '1px solid #475569',
              borderRadius: '8px',
              boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
              display: 'flex',
              flexDirection: 'column',
              zIndex: 1002,
              maxHeight: '90vh',
              overflowY: 'auto',
              direction: dir,
            }}>

              <div style={{ padding: '10px 15px', fontSize: '12px', color: '#94a3b8', borderBottom: '1px solid #475569' }}>
                {t('menu.navTitle')}
              </div>

              <Link to="/" onClick={closeMenu} style={menuItemStyle}>
                {t('menu.scenarios')}
              </Link>
              <Link to="/manage-exports" onClick={closeMenu} style={menuItemStyle}>
                {t('menu.manageExports')}
              </Link>
              <Link to="/batch-generator" onClick={closeMenu} style={menuItemStyle}>
                {t('menu.batchGenerator')}
              </Link>

              {/* Language / Settings panel */}
              <div
                onClick={toggleLangPanel}
                style={{ ...menuItemStyle, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span>{t('menu.langSwitch.title')}</span>
                <span style={{ transform: langOpen ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>▼</span>
              </div>
              {langOpen && (
                <div style={{ background: '#1e293b', padding: '10px 15px', borderTop: '1px solid #475569', borderBottom: '1px solid #475569' }}>
                  {AVAILABLE_LANGS.map(l => (
                    <button
                      key={l.code}
                      onClick={() => { setLang(l.code); closeMenu(); }}
                      style={{
                        display: 'block', width: '100%', padding: '8px 10px',
                        marginBottom: '4px', borderRadius: '6px', border: 'none',
                        cursor: 'pointer', fontSize: '14px', textAlign: isRtl ? 'right' : 'left',
                        background: lang === l.code ? '#3b82f6' : '#334155',
                        color: 'white', fontWeight: lang === l.code ? 'bold' : 'normal',
                      }}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Help */}
              <a
                href="/GeoVisLab/help.html"
                target="_blank"
                rel="noreferrer"
                onClick={closeMenu}
                style={menuItemStyle}
              >
                {t('menu.help')}
              </a>

              {/* About accordion */}
              <div
                onClick={toggleAbout}
                style={{ ...menuItemStyle, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span>{t('menu.about')}</span>
                <span style={{ transform: aboutOpen ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>▼</span>
              </div>
              {aboutOpen && (
                <div style={{ background: '#1e293b', padding: '15px', borderTop: '1px solid #475569', borderBottom: '1px solid #475569', fontSize: '13px', color: '#cbd5e1' }}>
                  <div style={{ marginBottom: '8px', fontWeight: 'bold', color: '#fff' }}>GeoVisLab v1.0.0</div>
                  <div style={{ marginBottom: '4px' }}>• {t('menu.aboutContent.coreEngine')}</div>
                  <div style={{ marginBottom: '4px' }}>• {t('menu.aboutContent.plannerModule')}</div>
                  <div style={{ marginBottom: '4px' }}>• {t('menu.aboutContent.react')}</div>
                  <div style={{ marginTop: '10px', fontSize: '11px', color: '#94a3b8' }}>
                    {t('menu.aboutContent.academic')}<br />
                    {t('menu.aboutContent.rights')}
                  </div>
                </div>
              )}

            </nav>
          </>
        )}
      </header>

      {/* Main content */}
      <main style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <Routes>
          <Route path="/" element={<Planner />} />
          <Route path="/manage-exports" element={<ExportFileManager />} />
          <Route path="/batch-generator" element={<BatchGenerator />} />
        </Routes>
      </main>

    </div>
  );
}

export default App;
