# Wacap Wrapper

Comprehensive TypeScript wrapper for [Baileys WhatsApp Web API](https://github.com/WhiskeySockets/Baileys) with multi-session support, flexible storage options, and easy-to-use event handling.

[<img src="https://www.owlstown.com/assets/icons/bmc-yellow-button-941f96a1.png" alt="Buy Me A Coffee" width="150" />](https://www.buymeacoffee.com/pakor)

## Features

✨ **Easy to Use** - Simple, intuitive API for sends, groups, and lifecycle
🔄 **Multi-Session Support** - Manage hundreds of WhatsApp connections simultaneously
💾 **Flexible Storage** - SQLite (default, WAL) or Prisma (MySQL/PostgreSQL)
📡 **Event Wrapper** - Global + per-session events with normalized payloads
🔒 **Type-Safe** - Full TypeScript support with comprehensive type definitions
🛡️ **SaaS Ready** - Auto-reconnect with backoff, status tracking, and session loader
📦 **Readable & Maintainable** - Clean, modular handlers for connection/message/group flows

## Installation

```bash
npm i @pakor/wacap-wrapper
```

### Dependencies

The package requires these peer dependencies:

```bash
npm install @whiskeysockets/baileys pino better-sqlite3 qrcode-terminal eventemitter3
```

### Optional: For Prisma Storage

```bash
npm install @prisma/client prisma
```

## Quick Start

### Basic Usage (SQLite)

```typescript
import { WacapWrapper } from 'wacap-wrapper';

// Create wrapper instance
const wacap = new WacapWrapper({
  sessionsPath: './sessions',
  autoDisplayQR: true,
});

// Initialize
await wacap.init();

// Start a session (or resume if it exists)
const session = await wacap.sessions.start('my-session');

// Listen for QR code
session.getEventManager().onQRCode((data) => {
  console.log('Scan this QR code:', data.qr);
});

// Listen for connection
session.getEventManager().onConnectionOpen(() => {
  console.log('Connected!');
});

// Listen for messages
session.getEventManager().onMessageReceived(async (data) => {
  console.log('Message:', data.body);
  console.log('From:', data.from);
  
  // Reply
  if (data.from) {
    await wacap.send.text('my-session', data.from, 'Hello!');
  }
});

// Create a group and add participants
await wacap.groups.create('my-session', 'My Team', ['628xx@s.whatsapp.net']);
await wacap.groups.addParticipants('my-session', '12345-67890@g.us', ['628yy@s.whatsapp.net']);
```

### Multi-Session Support

```typescript
// Start multiple sessions
const session1 = await wacap.sessions.start('session-1');
const session2 = await wacap.sessions.start('session-2');
const session3 = await wacap.sessions.start('session-3');

// Each session operates independently
session1.getEventManager().onMessageReceived((data) => {
  console.log('[Session 1]:', data.body);
});

session2.getEventManager().onMessageReceived((data) => {
  console.log('[Session 2]:', data.body);
});

// Find a session
const session = wacap.findSession('session-1');

// Get all sessions
const allSessions = wacap.getAllSessions();

// Stop a session
await wacap.sessions.stop('session-2');

// Boot all saved sessions on startup
await wacap.sessions.startAll();
// Or start a subset explicitly
await wacap.sessions.startByIds(['session-1', 'session-3']);
```

### Global Event Bus

Subscribe once to receive events from ALL sessions.

```typescript
// Listen for any QR code emitted by any session
wacap.onGlobal(WacapEventType.QR_CODE, (data) => {
  console.log('[GLOBAL] QR for', data.sessionId);
});

// Aggregate all incoming messages
wacap.onGlobal(WacapEventType.MESSAGE_RECEIVED, (data) => {
  console.log(`[GLOBAL][${data.sessionId}] ${data.body}`);
});

// Every global emit auto-includes { sessionId, timestamp }
```

### Using Prisma Storage (MySQL/PostgreSQL)

```typescript
import { WacapWrapper } from 'wacap-wrapper';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const wacap = new WacapWrapper({
  storageAdapter: 'prisma',
  prismaClient: prisma,
  sessionsPath: './sessions',
});

await wacap.init();
const session = await wacap.sessionStart('prisma-session');
```

**Prisma Setup:**

1. Copy `prisma-schema.example` to `prisma/schema.prisma`
2. Configure your `DATABASE_URL` in `.env`
3. Run migrations: `npx prisma migrate dev`

## API Reference

### WacapWrapper

Main class for managing WhatsApp sessions.

#### Constructor Options

```typescript
interface WacapConfig {
  sessionsPath?: string;           // Default: './sessions'
  storageAdapter?: 'sqlite' | 'prisma'; // Default: 'sqlite'
  debug?: boolean;                 // Default: false
  logger?: { level: string };      // Default: { level: 'warn' }
  prismaClient?: any;              // Required if using Prisma
  autoDisplayQR?: boolean;         // Default: true
  browser?: [string, string, string]; // Default: ['Wacap', 'Chrome', '1.0.0']
  connectionTimeout?: number;      // Default: 60000
  maxRetries?: number;             // Default: 5
}
```

#### Methods

##### Session helpers (ergonomic)
- `sessions.start(id, config?)` – start or resume a session
- `sessions.stop(id)` – stop one session
- `sessions.stopAll()` – stop all active sessions
- `sessions.restartAll()` – restart all active sessions
- `sessions.startAll()` – load + start all sessions found in storage
- `sessions.startByIds(ids, config?)` – start specific sessions
- `sessions.list()` – list active session ids
- `sessions.info(id)` – get `SessionInfo` (includes status/lastSeen/error)
- `sessions.get(id)` – get `Session` instance

##### Send helpers
- `send.text(sessionId, jid, text, options?)`
- `send.media(sessionId, jid, media)`
  - media: `{ url?: string; buffer?: Buffer; mimetype?: string; caption?: string; fileName?: string; }`

Both throw if session/socket not ready.

##### Group helpers
- `groups.create(sessionId, subject, participants[])`
- `groups.addParticipants(sessionId, groupId, participants[])`
- `groups.removeParticipants(sessionId, groupId, participants[])`
- `groups.promoteParticipants(sessionId, groupId, participants[])`
- `groups.demoteParticipants(sessionId, groupId, participants[])`

##### Legacy (still available)
- `sessionStart`, `sessionStop`, `findSession`, `getAllSessions`, `getSessionIds`, `hasSession`, `deleteSession`
- `sendMessage`, `sendMedia`

##### `on(sessionId: string, event: WacapEventType, handler: EventHandler): void`
Register an event handler.

```typescript
wacap.on('my-session', WacapEventType.MESSAGE_RECEIVED, (data) => {
  console.log(data);
});
```

##### `onGlobal(event: WacapEventType, handler: EventHandler): void`
Listen to an event from all sessions simultaneously.

```typescript
wacap.onGlobal(WacapEventType.CONNECTION_OPEN, (data) => {
  console.log('Any session connected:', data.sessionId);
});
```

##### `onceGlobal(event: WacapEventType, handler: EventHandler): void`
One-time listener across all sessions.

```typescript
wacap.onceGlobal(WacapEventType.SESSION_START, (data) => {
  console.log('First session started:', data.sessionId);
});
```

##### `getSocket(sessionId: string): WASocket | null`
Get raw Baileys socket for advanced usage.

```typescript
const socket = wacap.getSocket('my-session');
if (socket) {
  const groups = await socket.groupFetchAllParticipating();
}
```

### Session

Individual WhatsApp session instance.

#### Methods

##### `getEventManager(): EventManager`
Get the event manager for this session.

```typescript
const eventManager = session.getEventManager();
```

##### `getSocket(): WASocket | null`
Get the raw Baileys socket.

##### `getInfo(): SessionInfo`
Get session information.

```typescript
const info = session.getInfo();
console.log(info.status);      // 'connecting' | 'qr' | 'connected' | 'disconnected' | 'error'
console.log(info.lastSeenAt);  // timestamp of last activity
console.log(info.error);       // last error message if any
```

##### `isActive(): boolean`
Check if session is currently active.

### EventManager

Event management for webhooks and custom handlers.

#### Event Methods

All event methods accept an async handler function:

```typescript
// Connection events
eventManager.onConnectionUpdate(handler);
eventManager.onConnectionOpen(handler);
eventManager.onConnectionClose(handler);
eventManager.onQRCode(handler);

// Message events
eventManager.onMessageReceived(handler);
eventManager.onMessageSent(handler);
eventManager.onMessageUpdate(handler);

// Group events
eventManager.onGroupParticipantsUpdate(handler);

// Presence events
eventManager.onPresenceUpdate(handler);

// Generic event handler
eventManager.on(WacapEventType.MESSAGE_RECEIVED, handler);
eventManager.once(WacapEventType.CONNECTION_OPEN, handler);
eventManager.off(WacapEventType.MESSAGE_RECEIVED, handler);
```

### Event Types (normalized payload)

```typescript
enum WacapEventType {
  // Connection
  CONNECTION_UPDATE = 'connection.update',
  CONNECTION_OPEN = 'connection.open',
  CONNECTION_CLOSE = 'connection.close',
  QR_CODE = 'qr.code',
  
  // Messages
  MESSAGE_RECEIVED = 'message.received',
  MESSAGE_SENT = 'message.sent',
  MESSAGE_UPDATE = 'message.update',
  MESSAGE_DELETE = 'message.delete',
  
  // Chats
  CHAT_UPDATE = 'chat.update',
  CHAT_DELETE = 'chat.delete',
  
  // Contacts
  CONTACT_UPDATE = 'contact.update',
  
  // Groups
  GROUP_UPDATE = 'group.update',
  GROUP_PARTICIPANTS_UPDATE = 'group.participants.update',
  
  // Presence
  PRESENCE_UPDATE = 'presence.update',
  
  // Call
  CALL = 'call',
  
  // Session
  SESSION_START = 'session.start',
  SESSION_STOP = 'session.stop',
  SESSION_ERROR = 'session.error',
}
```

All emitted events include `{ sessionId, timestamp, ...data }` so listeners always know the origin session.

## Webhook Integration

Easy webhook integration for external services:

```typescript
const webhookUrl = 'https://your-webhook.com/whatsapp';

const sendToWebhook = async (eventType: string, data: any) => {
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: eventType, data })
  });
};

// Forward all events
session.getEventManager().onMessageReceived((data) => {
  sendToWebhook('message.received', data);
});

session.getEventManager().onConnectionUpdate((data) => {
  sendToWebhook('connection.update', data);
});
```

## Advanced Usage

### Access All Baileys Features

```typescript
const socket = wacap.getSocket('my-session');

if (socket) {
  // Fetch all groups
  const groups = await socket.groupFetchAllParticipating();
  
  // Get profile picture
  const ppUrl = await socket.profilePictureUrl(jid);
  
  // Update profile status
  await socket.updateProfileStatus('Hello!');
  
  // Read messages
  await socket.readMessages([{ remoteJid: jid, id: messageId }]);
  
  // Send presence
  await socket.sendPresenceUpdate('available', jid);
  
  // And much more...
}
```

## Examples

Check the `examples/` directory for more comprehensive examples:

- `basic-usage.ts` - Basic usage with SQLite
- `prisma-usage.ts` - Using Prisma with MySQL/PostgreSQL
- `complete-features.ts` - Full demo of events, sending, and Baileys extras

## Storage

### SQLite (Default)

- ✅ Zero configuration
- ✅ File-based storage
- ✅ Perfect for small to medium deployments
- ✅ Automatic setup
- ⚠️ Uses WAL mode to reduce corruption; avoid sharing the same db file across multi-process clusters unless you understand the risk.
- Stores metadata (timestamps) and chats/messages/contacts; auth keys stay on disk via Baileys multi-file auth.

### Prisma (MySQL/PostgreSQL)

- ✅ Scalable for large deployments
- ✅ Supports MySQL, PostgreSQL, SQL Server, etc.
- ✅ Advanced querying capabilities
- ✅ Database migration support

## Project Structure

```
wacap-wrapper/
├── src/
│   ├── core/           # Core session management
│   ├── events/         # Event handling (per-session managers + global bus)
│   ├── storage/        # Storage adapters
│   ├── types/          # TypeScript types
│   ├── utils/          # Helper utilities
│   └── index.ts        # Main exports
├── examples/           # Usage examples
├── prisma-schema.example  # Prisma schema template
└── package.json
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

If you find this project useful, consider supporting us and starring the repository!

[<img src="https://www.owlstown.com/assets/icons/bmc-yellow-button-941f96a1.png" alt="Buy Me A Coffee" width="150" />](https://www.buymeacoffee.com/pakor)

## License

MIT License - see LICENSE file for details

## Credits

Built on top of the amazing [Baileys](https://github.com/WhiskeySockets/Baileys) library.

## Disclaimer

This project is not affiliated with WhatsApp or Meta. Use at your own risk and in accordance with WhatsApp's Terms of Service.

---
