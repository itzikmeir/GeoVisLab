import { useState } from 'react';
import { Routes, Route, Link } from 'react-router-dom';
import ExportFileManager from './components/ExportFileManager';
import Planner from './components/Planner';
import BatchGenerator from './components/BatchGenerator';

function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  // סטייט חדש לשליטה על פתיחת תפריט ה"אודות"
  const [aboutOpen, setAboutOpen] = useState(false);

  const toggleMenu = () => setMenuOpen(!menuOpen);
  const closeMenu = () => setMenuOpen(false);
  
  // פונקציה לפתיחה/סגירה של תת-התפריט "אודות" מבלי לסגור את התפריט הראשי
  const toggleAbout = (e: React.MouseEvent) => {
    e.stopPropagation(); // מונע סגירה של התפריט הראשי
    setAboutOpen(!aboutOpen);
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#0b0f17', color: '#e2e8f0', fontFamily: 'Arial, sans-serif' }}>
      
      {/* --- בר עליון --- */}
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
        direction: 'rtl'
      }}>
        
        <button 
          onClick={toggleMenu}
          style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '24px', cursor: 'pointer', padding: '0', lineHeight: '1', marginLeft: '15px' }}
          title="תפריט ראשי"
        >
          &#9776;
        </button>

        <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 'bold', letterSpacing: '1px' }}>
          GeoVisLab
        </h1>

        {/* --- תפריט צף --- */}
        {menuOpen && (
          <>
            <div 
              onClick={closeMenu} 
              style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1001 }} 
            />
            
            <nav style={{
              position: 'absolute',
              top: '45px', 
              right: '10px',
              width: '280px', // הרחבתי קצת כדי שיהיה מקום
              background: '#334155',
              border: '1px solid #475569',
              borderRadius: '8px',
              boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
              display: 'flex',
              flexDirection: 'column',
              zIndex: 1002,
              maxHeight: '90vh', // מונע חריגה מהמסך אם התפריט ארוך
              overflowY: 'auto',
              direction: 'rtl'
            }}>
              
              {/* כותרת קטנה לתפריט */}
              <div style={{ padding: '10px 15px', fontSize: '12px', color: '#94a3b8', borderBottom: '1px solid #475569' }}>
                ניווט ראשי
              </div>

              <Link to="/" onClick={closeMenu} style={menuItemStyle}>
                🛠️ תכנון תרחישים
              </Link>
              <Link to="/manage-exports" onClick={closeMenu} style={menuItemStyle}>
                📂 ניהול קבצים מיוצאים
              </Link>
              <Link to="/batch-generator" onClick={closeMenu} style={menuItemStyle}>
                🏭 מחולל המוני (JSON to HTML)
              </Link>
              <a href="https://www.youtube.com/results?search_query=rick+roll+1000+hours" target="_blank" rel="noreferrer" onClick={closeMenu} style={menuItemStyle}>
                ⚙️ הגדרות 
              </a>
    
          
              {/* כפתור עזרה - פותח לשונית חדשה */}
              <a 
                href="/GeoVisLab/help.html" 
                target="_blank" 
                rel="noreferrer"
                onClick={closeMenu}
                style={menuItemStyle}
              >
                ❓ עזרה / מדריך
              </a>

              {/* כפתור אודות - נפתח כ-Accordion */}
              <div 
                onClick={toggleAbout} 
                style={{ ...menuItemStyle, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span>ℹ️ אודות</span>
                <span style={{ transform: aboutOpen ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>▼</span>
              </div>

              {/* תת-תפריט אודות */}
              {aboutOpen && (
                <div style={{ background: '#1e293b', padding: '15px', borderTop: '1px solid #475569', borderBottom: '1px solid #475569', fontSize: '13px', color: '#cbd5e1' }}>
                  <div style={{ marginBottom: '8px', fontWeight: 'bold', color: '#fff' }}>GeoVisLab v1.0.0</div>
                  <div style={{ marginBottom: '4px' }}>• Core Engine: v1.0.2</div>
                  <div style={{ marginBottom: '4px' }}>• Planner Module: v1.2.0</div>
                  <div style={{ marginBottom: '4px' }}>• React: v18.2.0</div>
                  <div style={{ marginTop: '10px', fontSize: '11px', color: '#94a3b8' }}>
                    פותח עבור מחקר אקדמי<br/>
                    © 2026 כל הזכויות שמורות
                  </div>
                </div>
              )}

            </nav>
          </>
        )}
      </header>

      {/* --- אזור התוכן הראשי --- */}
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

// סגנון משותף לכפתורי התפריט למניעת שכפול קוד
const menuItemStyle = {
  padding: '15px', 
  color: 'white', 
  textDecoration: 'none', 
  borderBottom: '1px solid #475569', 
  transition: 'background 0.2s', 
  textAlign: 'right' as const,
  display: 'block'
};

export default App;