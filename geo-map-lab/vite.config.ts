import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/GeoVisLab/',  // <--- ודא שהוספת את השורה הזו עם לוכסנים בשני הצדדים
})
