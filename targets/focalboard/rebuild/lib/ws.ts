// The realtime channel at /ws: a minimal RFC 6455 server (handshake, text frames, ping/pong, close).
// Clients send {action:"AUTH", token}, then {action:"SUBSCRIBE_TEAM", teamId}; the server never
// answers these, it only pushes changes to authenticated sockets subscribed to the team.

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024;

interface Client {
  socket: Duplex;
  token?: string;
  userId?: string;
  teams: Set<string>;
}

const clients = new Set<Client>();

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
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

function write(client: Client, message: unknown): void {
  if (client.socket.writable) client.socket.write(frame(0x1, Buffer.from(JSON.stringify(message))));
}

function close(client: Client, code = 1000): void {
  clients.delete(client);
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  if (client.socket.writable) client.socket.end(frame(0x8, payload));
  else client.socket.destroy();
}

function onMessage(client: Client, text: string, userForToken: (token: string) => string | undefined): void {
  let msg: { action?: unknown; token?: unknown; teamId?: unknown };
  try {
    msg = JSON.parse(text) as typeof msg;
  } catch {
    return; // not JSON: ignored, like every other unknown message
  }
  if (!msg || typeof msg !== 'object') return;
  if (msg.action === 'AUTH' && typeof msg.token === 'string') {
    const userId = userForToken(msg.token);
    if (userId !== client.userId) client.teams.clear();
    client.userId = userId;
    client.token = userId ? msg.token : undefined;
  } else if (msg.action === 'SUBSCRIBE_TEAM' && typeof msg.teamId === 'string') {
    if (client.userId) client.teams.add(msg.teamId);
  } else if (msg.action === 'UNSUBSCRIBE_TEAM' && typeof msg.teamId === 'string') {
    client.teams.delete(msg.teamId);
  }
}

/**
 * Pushes one message to every socket that is signed in and subscribed to the team, and whose user
 * `canSee` allows (a board's members, a category's owner).
 */
export function publish(teamId: string, message: Record<string, unknown>, canSee: (userId: string) => boolean): void {
  const body = { ...message, teamId };
  for (const c of clients) if (c.userId && c.teams.has(teamId) && canSee(c.userId)) write(c, body);
}

/** A signed-out session no longer receives anything on sockets that authenticated with it. */
export function forgetToken(token: string): void {
  for (const c of clients) {
    if (c.token !== token) continue;
    c.token = undefined;
    c.userId = undefined;
    c.teams.clear();
  }
}

export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, userForToken: (token: string) => string | undefined): void {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));

  const client: Client = { socket, teams: new Set() };
  clients.add(client);
  let buffer: Buffer = Buffer.from(head);
  let fragments: Buffer[] = [];
  let fragmentSize = 0;

  const consume = () => {
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
        if (big > BigInt(MAX_MESSAGE)) return close(client, 1009);
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_MESSAGE) return close(client, 1009);
      if (!masked) return close(client, 1002); // a client must mask its frames
      if (buffer.length < offset + 4 + len) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
      buffer = buffer.subarray(offset + 4 + len);

      if (opcode === 0x8) return close(client);
      if (opcode === 0x9) {
        if (socket.writable) socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        fragmentSize += payload.length;
        if (fragmentSize > MAX_MESSAGE) return close(client, 1009);
        fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(fragments).toString('utf8');
          fragments = [];
          fragmentSize = 0;
          onMessage(client, text, userForToken);
        }
      }
    }
  };

  socket.on('data', (chunk: Buffer) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    consume();
  });
  socket.on('close', () => clients.delete(client));
  socket.on('error', () => clients.delete(client));
  if (buffer.length) consume();
}

export function closeAll(): void {
  for (const c of clients) close(c, 1001);
}
