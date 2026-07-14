import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    license: true,
    rolldownOptions: {
      output: {
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
