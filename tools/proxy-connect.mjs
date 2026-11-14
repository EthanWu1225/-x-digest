#!/usr/bin/env node
/**
 * SSH ProxyCommand：把 stdio 通过本地 HTTP 代理的 CONNECT 隧道转出去。
 *
 * 用途：国内直连 github.com:22 会被阻断，但 HTTPS 代理是通的。
 * 用法（在 ~/.ssh/config 或命令行里）：
 *
 *   ssh -o ProxyCommand="node proxy-connect.mjs %h %p" git@github.com
 *
 * 代理地址从 HTTPS_PROXY 环境变量读，默认 http://127.0.0.1:7897
 */
import net from 'node:net';
import process from 'node:process';

const [host, port] = process.argv.slice(2);
if (!host || !port) {
  console.error('用法: node proxy-connect.mjs <host> <port>');
  process.exit(2);
}

const proxyUrl = new URL(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7897');
const proxyPort = Number(proxyUrl.port || 7897);
const proxyHost = proxyUrl.hostname || '127.0.0.1';

const socket = net.connect(proxyPort, proxyHost, () => {
  socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
});

let connected = false;
let buffer = '';

socket.on('data', (chunk) => {
  if (connected) {
    process.stdout.write(chunk);
    return;
  }
  buffer += chunk.toString('binary');
  const idx = buffer.indexOf('\r\n\r\n');
  if (idx === -1) return;

  const head = buffer.slice(0, idx);
  const rest = buffer.slice(idx + 4);
  const status = Number((head.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1] || 0);

  if (status !== 200) {
    console.error(`代理拒绝 CONNECT ${host}:${port}（HTTP ${status}）`);
    process.exit(1);
  }
  connected = true;
  if (rest) process.stdout.write(Buffer.from(rest, 'binary'));
});

socket.on('error', (err) => {
  console.error(`连不上代理 ${proxyHost}:${proxyPort}：${err.message}`);
  process.exit(1);
});

process.stdin.on('data', (d) => socket.write(d));
process.stdin.on('end', () => socket.end());
process.stdin.on('error', () => socket.end());
