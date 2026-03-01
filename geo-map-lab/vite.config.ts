import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/GeoVisLab/', // חשוב מאוד! זה השם של הרפוזיטורי שלך
})