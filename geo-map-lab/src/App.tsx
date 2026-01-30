import { useState } from 'react';
import { Routes, Route, Link } from 'react-router-dom';
import ExportFileManager from './components/ExportFileManager';
import Planner from './components/Planner';
import BatchGenerator from './components/BatchGenerator';

function App() {
  const [menuOpen, setMenuOpen] = useState(false);

  const toggleMenu = () => setMenuOpen(!menuOpen);
  const closeMenu = () => setMenuOpen(false);

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
        direction: 'rtl' // <--- שינוי 1: כיוון מימין לשמאל
      }}>
        
        {/* כפתור המבורגר */}
        <button 
          onClick={toggleMenu}
          style={{ 
            background: 'transparent', 
            border: 'none', 
            color: '#fff', 
            fontSize: '24px', 
            cursor: 'pointer',
            padding: '0',
            lineHeight: '1',
            marginLeft: '15px' // <--- שינוי 2: הרווח עכשיו בצד שמאל של הכפתור
          }}
          title="תפריט ראשי"
        >
          &#9776;
        </button>

        {/* שם האפליקציה */}
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
              right: '10px', // נשאר צמוד לימין
              width: '270px',
              background: '#334155',
              border: '1px solid #475569',
              borderRadius: '8px',
              boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
              display: 'flex',
              flexDirection: 'column',
              zIndex: 1002,
              overflow: 'hidden',
              direction: 'rtl' // גם התפריט עצמו יהיה מימין לשמאל
            }}>
              <Link 
                to="/" 
                onClick={closeMenu}
                style={{ 
                  padding: '15px', 
                  color: 'white', 
                  textDecoration: 'none', 
                  borderBottom: '1px solid #475569',
                  transition: 'background 0.2s',
                  textAlign: 'right' // יישור טקסט לימין
                }}
                onMouseOver={(e) => e.currentTarget.style.background = '#475569'}
                onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
              >
                🛠️ תכנון תרחישים
              </Link>
              <Link 
                to="/manage-exports" 
                onClick={closeMenu}
                style={{ 
                  padding: '15px', 
                  color: 'white', 
                  textDecoration: 'none',
                  borderBottom: '1px solid #475569',
                  textAlign: 'right' // יישור טקסט לימין
                }}
                onMouseOver={(e) => e.currentTarget.style.background = '#475569'}
                onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
              >
                📂 ניהול קבצים מיוצאים
              </Link>
              <Link 
                to="/batch-generator" 
                onClick={closeMenu}
                style={{ 
                  padding: '15px', 
                  color: 'white', 
                  textDecoration: 'none',
                  borderBottom: '1px solid #475569',
                  textAlign: 'right' // יישור טקסט לימין
                }}
                onMouseOver={(e) => e.currentTarget.style.background = '#475569'}
                onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
              >
                🏭 מחולל המוני (JSON to HTML)
              </Link>
               <Link 
                to="/https://www.youtube.com/results?search_query=rick+roll+1000+hours" 
                onClick={closeMenu}
                style={{ 
                  padding: '15px', 
                  color: 'white', 
                  textDecoration: 'none',                }}
                onMouseOver={(e) => e.currentTarget.style.background = '#475569'}
                onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
              >
               ⚙️ הגדרות 
              </Link>
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

export default App;