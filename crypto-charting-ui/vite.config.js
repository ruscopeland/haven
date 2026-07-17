import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from 'node:process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Cloudflare's domain cache keeps JavaScript assets for several hours. Include
// the deployment revision in every JS filename so a newly deployed HTML shell
// can never load a previous deployment's lazy-loaded chunks from that cache.
const buildRevision = env.VITE_BUILD_ID || 'local'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    license: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        landing: path.resolve(__dirname, 'landing.html'),
      },
    },
    rolldownOptions: {
      output: {
        entryFileNames: `assets/[name]-[hash]-${buildRevision}.js`,
        chunkFileNames: `assets/[name]-[hash]-${buildRevision}.js`,
        codeSplitting: {
          groups: [
            { name: 'react-vendor', test: /node_modules[\\/]react(?:-dom)?[\\/]/ },
            { name: 'auth-wallet-vendor', test: /node_modules[\\/](?:@clerk|ethers)[\\/]/ },
            { name: 'editor-shell-vendor', test: /node_modules[\\/]@uiw[\\/]/ },
            { name: 'editor-core-vendor', test: /node_modules[\\/](?:@codemirror|@lezer)[\\/]/ },
            { name: 'chart-vendor', test: /node_modules[\\/]lightweight-charts[\\/]/ },
          ],
        },
      },
    },
  },
  resolve: {
    // Shared strategy runtime (also imported by marker-engine) lives outside
    // this app so both runtimes execute the exact same code.
    alias: {
      '@sdk': path.resolve(__dirname, '../strategy-sdk/src'),
      // Guide markdown ships with the SDK so docs version with the contract.
      '@sdk-docs': path.resolve(__dirname, '../strategy-sdk/docs'),
    },
  },
  server: {
    // Vite's default fs root is this folder; without this the @sdk import is
    // silently 403'd by the dev server.
    fs: { allow: [__dirname, path.resolve(__dirname, '../strategy-sdk')] },
  },
})
