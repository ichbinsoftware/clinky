#!/usr/bin/env node
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// Tell the server to use ~/.clinky/sessions/ instead of a local sessions/ dir
process.env.CLINKY_SESSIONS_DIR = path.join(os.homedir(), '.clinky', 'sessions');

// Boot the server — process.argv passes through so --agent, --port, --record flags work
import('../server.js');

if (process.argv.includes('--open')) {
  const portIdx = process.argv.indexOf('--port');
  const port = portIdx !== -1 ? Number(process.argv[portIdx + 1]) : (Number(process.env.PORT) || 4243);
  setTimeout(() => {
    const url = `http://localhost:${port}`;
    const opener = process.platform === 'darwin' ? 'open'
                 : process.platform === 'win32'  ? 'start'
                 :                                 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
  }, 300);
}
