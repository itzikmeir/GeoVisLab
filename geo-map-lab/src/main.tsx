import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { BrowserRouter } from 'react-router-dom'
// שנה את הייבוא מ-BrowserRouter ל-HashRouter
import { HashRouter } from 'react-router-dom';

// ב-render:
<HashRouter>
  <App />
</HashRouter>

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* כאן נמצא הראוטר היחיד באפליקציה, עם ההגדרה לגיטהאב */}
    <BrowserRouter basename="/GeoVisLab">
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)