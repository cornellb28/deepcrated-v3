import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // boot.ts is the entry (still out/main/index.js, which package.json
        // points at). It shows the launch screen, then dynamically imports
        // index.ts — the app and the database — which becomes out/main/app.js.
        input: { index: resolve('src/main/boot.ts') },
        output: {
          // Rollup's default split is the one we need: what boot.ts imports
          // statically (launch screen, deep-link bridge) stays in index.js,
          // and index.ts with everything only it uses — db.ts included —
          // becomes the dynamically loaded chunk. Do not add manualChunks:
          // it pulls shared modules into that chunk and index.js would then
          // require the database up front. Named app.js, flat next to
          // index.js, because code in it resolves paths from __dirname
          // (../preload, ../renderer, the sidecar), which must stay out/main.
          chunkFileNames: (chunk) =>
            chunk.facadeModuleId?.replace(/\\/g, '/').endsWith('/src/main/index.ts')
              ? 'app.js'
              : '[name].js'
        }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          // The launch screen's own preload (src/main/launchScreen.ts).
          splash: resolve('src/preload/splash.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
