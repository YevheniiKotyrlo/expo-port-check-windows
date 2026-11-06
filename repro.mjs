// `expo start --port 8081` on Windows while another process already listens on port 8081 at 127.0.0.1, then at 0.0.0.0.
// Exits 1 while Expo starts Metro on the held port, 0 once it refuses the port or moves to another, 2 when a step fails first.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';

const PORT = 8081;
const HOLDER_HOSTS = ['127.0.0.1', '0.0.0.0'];
const START_TIMEOUT_MS = Number(process.env.REPRO_START_TIMEOUT_MS ?? 180_000);
const REFUSAL = /Port \d+ is unavailable|PORT_IN_USE/;

const require = createRequire(import.meta.url);
const expoVersion = require('expo/package.json').version;
const cliVersion = createRequire(require.resolve('expo/package.json'))('@expo/cli/package.json').version;
const expoCli = process.env.REPRO_EXPO_CLI ?? require.resolve('expo/bin/cli');

// A connection the client leaves open keeps `server.close` from finishing, so the holder ends its own.
const holdPort = (host) =>
  new Promise((resolve, reject) => {
    const connections = new Set();
    const server = net.createServer((socket) => {
      connections.add(socket);
      socket.once('close', () => connections.delete(socket));
      socket.end('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 6\r\nconnection: close\r\n\r\nholder');
    });
    server.once('error', reject);
    server.listen({ host, port: PORT }, () =>
      resolve({
        close: () =>
          new Promise((closed) => {
            server.close(() => closed());
            for (const connection of connections) {
              connection.destroy();
            }
          }),
      }),
    );
  });

const readBody = (url) =>
  new Promise((resolve) => {
    const request = http.get(url, { agent: false, timeout: 5000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve(body.trim()));
    });
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', (error) => resolve(`error ${error.code ?? error.message}`));
  });

// Reads expo's output until it names the port Metro serves on, refuses the port, or ends.
const startExpo = () =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [expoCli, 'start', '--port', String(PORT)], {
      env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let settled = false;
    const settle = (outcome) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ...outcome, child });
      }
    };
    const timer = setTimeout(
      () => settle({ kind: 'failed', reason: `expo start named no port within ${START_TIMEOUT_MS / 1000} s` }),
      START_TIMEOUT_MS,
    );
    const read = (chunk) => {
      output += chunk;
      const started = /Waiting on http:\/\/localhost:(\d+)/.exec(output);
      if (started) {
        settle({ kind: 'started', port: Number(started[1]) });
      } else if (REFUSAL.test(output)) {
        settle({ kind: 'refused', line: output.split('\n').find((line) => REFUSAL.test(line)).trim() });
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', (code) =>
      settle({ kind: 'failed', reason: `expo start exited ${code} before naming a port: ${output.trim().split('\n').at(-1)}` }),
    );
  });

const stop = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  });

console.log(`node ${process.version}, expo ${expoVersion}, @expo/cli ${cliVersion}, ${os.platform()} ${os.release()} ${os.arch()}`);
if (process.platform !== 'win32') {
  console.log('summary: this reproduction needs Windows, where a wildcard bind beside the holder succeeds (exit 2)');
  process.exit(2);
}

const results = [];
for (const host of HOLDER_HOSTS) {
  let holder;
  try {
    holder = await holdPort(host);
  } catch (error) {
    const reason = `the holder could not listen on ${host}:${PORT}: ${error.code ?? error.message}`;
    console.log(reason);
    results.push({ host, kind: 'failed', reason });
    continue;
  }
  console.log(`holder: listening on ${host}:${PORT}`);
  const expo = await startExpo();
  if (expo.kind === 'started' && expo.port === PORT) {
    console.log(`expo start: Metro serves on port ${PORT}`);
    console.log(`GET http://127.0.0.1:${PORT}/status -> ${await readBody(`http://127.0.0.1:${PORT}/status`)}`);
    console.log(`GET http://[::1]:${PORT}/status -> ${await readBody(`http://[::1]:${PORT}/status`)}`);
    results.push({ host, kind: 'took' });
  } else if (expo.kind === 'started') {
    console.log(`expo start: moved to port ${expo.port}`);
    results.push({ host, kind: 'refused' });
  } else if (expo.kind === 'refused') {
    console.log(`expo start: ${expo.line}`);
    results.push({ host, kind: 'refused' });
  } else {
    console.log(`expo start: ${expo.reason}`);
    results.push({ host, kind: 'failed', reason: expo.reason });
  }
  await stop(expo.child);
  await holder.close();
}

const took = results.filter((result) => result.kind === 'took').map((result) => result.host);
const failed = results.filter((result) => result.kind === 'failed');
if (took.length > 0) {
  console.log(`summary: expo start took port ${PORT} while a holder listened on ${took.join(' and ')} (exit 1)`);
  process.exitCode = 1;
} else if (failed.length > 0) {
  console.log(`summary: a step failed before the check — ${failed.map((result) => result.reason).join('; ')} (exit 2)`);
  process.exitCode = 2;
} else {
  console.log(`summary: expo start refused port ${PORT} beside every holder (exit 0)`);
  process.exitCode = 0;
}
