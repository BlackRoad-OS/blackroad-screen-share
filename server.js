#!/usr/bin/env node
// BlackRoad Screen Share — Signaling Server
// Zero dependencies. Raw WebSocket over HTTP.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 8803;

// Room storage: roomId -> Set of websocket connections
const rooms = new Map();

// Serve static files
function serveFile(res, filePath, contentType) {
  const absPath = path.join(__dirname, filePath);
  fs.readFile(absPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    const roomCount = rooms.size;
    let peerCount = 0;
    rooms.forEach(r => peerCount += r.size);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: roomCount, peers: peerCount, uptime: process.uptime() }));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    serveFile(res, 'index.html', 'text/html');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// Raw WebSocket implementation (RFC 6455) — zero dependencies
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const match = url.pathname.match(/^\/room\/([a-zA-Z0-9_-]+)$/);

  if (!match) {
    socket.destroy();
    return;
  }

  const roomId = match[1];
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  // WebSocket handshake
  const GUID = '258EAFA5-E914-47DA-95CA-5AB9D08C76B5';
  const acceptKey = crypto.createHash('sha1').update(key + GUID).digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
    '\r\n'
  );

  // Initialize room
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  const room = rooms.get(roomId);

  const peerId = crypto.randomBytes(4).toString('hex');
  const peer = { socket, id: peerId, roomId };
  room.add(peer);

  console.log(`[room:${roomId}] peer ${peerId} joined (${room.size} in room)`);

  // Notify existing peers
  const joinMsg = JSON.stringify({ type: 'peer-joined', peerId, peerCount: room.size });
  room.forEach(p => { if (p !== peer) wsSend(p.socket, joinMsg); });

  // Send room info to new peer
  const peers = [];
  room.forEach(p => { if (p !== peer) peers.push(p.id); });
  wsSend(socket, JSON.stringify({ type: 'room-info', roomId, peerId, peers }));

  let buffer = Buffer.alloc(0);

  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);

    while (buffer.length >= 2) {
      const parsed = wsParseFrame(buffer);
      if (!parsed) break;

      buffer = buffer.slice(parsed.totalLength);

      if (parsed.opcode === 0x8) {
        // Close frame
        socket.end();
        return;
      }
      if (parsed.opcode === 0x9) {
        // Ping — respond with pong
        wsSendRaw(socket, parsed.payload, 0xA);
        continue;
      }
      if (parsed.opcode === 0x1) {
        // Text frame — relay to other peers in room
        try {
          const msg = JSON.parse(parsed.payload.toString('utf8'));
          msg.from = peerId;
          const relay = JSON.stringify(msg);
          room.forEach(p => {
            if (p !== peer && (!msg.to || msg.to === p.id)) {
              wsSend(p.socket, relay);
            }
          });
        } catch (e) {
          // ignore malformed
        }
      }
    }
  });

  socket.on('close', () => cleanup());
  socket.on('error', () => cleanup());

  function cleanup() {
    room.delete(peer);
    console.log(`[room:${roomId}] peer ${peerId} left (${room.size} in room)`);
    if (room.size === 0) {
      rooms.delete(roomId);
    } else {
      const leaveMsg = JSON.stringify({ type: 'peer-left', peerId, peerCount: room.size });
      room.forEach(p => wsSend(p.socket, leaveMsg));
    }
  }
});

function wsParseFrame(buf) {
  if (buf.length < 2) return null;

  const firstByte = buf[0];
  const secondByte = buf[1];
  const opcode = firstByte & 0x0F;
  const masked = (secondByte & 0x80) !== 0;
  let payloadLength = secondByte & 0x7F;
  let offset = 2;

  if (payloadLength === 126) {
    if (buf.length < 4) return null;
    payloadLength = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buf.length < 10) return null;
    payloadLength = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  const maskSize = masked ? 4 : 0;
  const totalLength = offset + maskSize + payloadLength;
  if (buf.length < totalLength) return null;

  let payload = Buffer.alloc(payloadLength);
  if (masked) {
    const mask = buf.slice(offset, offset + 4);
    const data = buf.slice(offset + 4, offset + 4 + payloadLength);
    for (let i = 0; i < payloadLength; i++) {
      payload[i] = data[i] ^ mask[i % 4];
    }
  } else {
    buf.copy(payload, 0, offset, offset + payloadLength);
  }

  return { opcode, payload, totalLength };
}

function wsSend(socket, message) {
  const data = Buffer.from(message, 'utf8');
  wsSendRaw(socket, data, 0x1);
}

function wsSendRaw(socket, payload, opcode) {
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  try {
    socket.write(Buffer.concat([header, payload]));
  } catch (e) {
    // socket dead
  }
}

server.listen(PORT, () => {
  console.log(`BlackRoad Screen Share`);
  console.log(`Signaling server on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
