import { defineConfig } from 'vite';
import { agentBridge } from './server/bridge';

export default defineConfig({
  plugins: [agentBridge()],
  server: { host: '127.0.0.1', port: 5199, strictPort: true },
  preview: { host: '127.0.0.1', port: 5199, strictPort: true },
});
