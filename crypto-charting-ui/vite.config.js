import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
