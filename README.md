# BlackRoad Screen Share -- Sovereign Screen Sharing

Peer-to-peer screen sharing built on pure WebRTC. No Zoom. No Google Meet. No external services. Your screen stays between you and your peer.

## How It Works

- Browser captures your screen via `getDisplayMedia()`
- WebRTC establishes a direct peer-to-peer connection
- A lightweight signaling server (Node.js, zero deps) coordinates the handshake
- Video streams directly between browsers -- the server never sees your screen
- Optional: record your screen locally as WebM

## Requirements

- Node.js 16+
- A modern browser (Chrome, Firefox, Edge, Safari 15+)

## Usage

```bash
node server.js
```

Open `http://localhost:8803` in your browser. Click **Share Screen**. Copy the room link and send it to whoever needs to see your screen. They open it, click **Watch**, done.

Custom port:

```bash
node server.js --port 9000
```

## Health Check

```
GET /health
```

Returns room count, peer count, and uptime.

## No External Dependencies

- Zero npm packages
- WebSocket signaling server is a raw RFC 6455 implementation
- STUN uses Google's public server for NAT traversal (no data flows through it)
- Everything else is peer-to-peer

## License

Proprietary -- BlackRoad OS, Inc. All rights reserved.
