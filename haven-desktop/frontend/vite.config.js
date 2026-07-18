import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'strip-crossorigin',
      transformIndexHtml: {
        order: 'post',
        handler(html) {
          return html.replace(/crossorigin /g, '')
        },
      },
    },
  ],
  base: '/',
  build: {
    outDir: 'dist',
    modulePreload: false,
  },
})
