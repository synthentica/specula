// Minimal RFC 6455 WebSocket server for the realtime channel (/api/v2/ws).
// Clients authenticate with {action:"auth", token} and subscribe with {action:"subscribe", event}.

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { userForToken } from './auth.ts';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1024 * 1024;

interface Client {
  socket: Duplex;
  userId?: number;
  events: Set<string>;
}

const clients = new Set<Client>();

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendJson(client: Client, message: unknown): void {
  if (!client.socket.writable) return;
  client.socket.write(frame(0x1, Buffer.from(JSON.stringify(message))));
}

function close(client: Client, code = 1000): void {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  if (client.socket.writable) client.socket.end(frame(0x8, payload));
  clients.delete(client);
}

function onMessage(client: Client, text: string): void {
  let msg: { action?: unknown; token?: unknown; event?: unknown };
  try {
    msg = JSON.parse(text) as typeof msg;
  } catch {
    sendJson(client, { action: 'error', success: false, message: 'Messages must be JSON.' });
    return;
  }
  if (msg.action === 'auth') {
    const user = typeof msg.token === 'string' ? userForToken(msg.token) : undefined;
    if (user) {
      client.userId = user.id;
      sendJson(client, { action: 'auth.success', success: true });
    } else {
      sendJson(client, { action: 'auth.error', success: false, message: 'The token is invalid or has expired.' });
    }
  } else if (msg.action === 'subscribe' && typeof msg.event === 'string') {
    if (client.userId === undefined) sendJson(client, { action: 'error', success: false, message: 'Authenticate first.' });
    else client.events.add(msg.event);
  } else if (msg.action === 'unsubscribe' && typeof msg.event === 'string') {
    client.events.delete(msg.event);
  }
}

/** Sends an event to every authenticated client of a user that subscribed to it. */
export function publish(userId: number, event: string, data: unknown): void {
  for (const c of clients) if (c.userId === userId && c.events.has(event)) sendJson(c, { action: 'event', event, data });
}

export function handleUpgrade(req: IncomingMessage, socket: Duplex): void {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));

  const client: Client = { socket, events: new Set() };
  clients.add(client);
  let buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const fin = (buffer[0]! & 0x80) !== 0;
      const opcode = buffer[0]! & 0x0f;
      const masked = (buffer[1]! & 0x80) !== 0;
      let len = buffer[1]! & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) return close(client, 1009);
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_FRAME) return close(client, 1009);
      if (!masked) return close(client, 1002); // clients must mask
      if (buffer.length < offset + 4 + len) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
      buffer = buffer.subarray(offset + 4 + len);

      if (opcode === 0x8) return close(client);
      if (opcode === 0x9) {
        socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(fragments).toString('utf8');
          fragments = [];
          onMessage(client, text);
        }
      }
      // Binary frames are ignored.
    }
  });
  socket.on('close', () => clients.delete(client));
  socket.on('error', () => clients.delete(client));
}

export function closeAll(): void {
  for (const c of clients) close(c, 1001);
}
