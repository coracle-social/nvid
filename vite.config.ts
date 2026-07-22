import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5173,
    // Handy for testing broadcast on one device and playback on another. Note that
    // getUserMedia needs a secure context, so over LAN you also need HTTPS — see README.
    host: true,
  },
})
