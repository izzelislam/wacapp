# Wacap Wrapper

Comprehensive TypeScript wrapper for [Baileys WhatsApp Web API](https://github.com/WhiskeySockets/Baileys) with multi-session support, flexible storage options, and easy-to-use event handling.

## Features

✨ **Easy to Use** - Simple, intuitive API for all WhatsApp operations
🔄 **Multi-Session Support** - Manage multiple WhatsApp connections simultaneously
💾 **Flexible Storage** - SQLite (default) or Prisma (MySQL/PostgreSQL)
📡 **Event Wrapper** - Simplified event handling for webhook integration
🔒 **Type-Safe** - Full TypeScript support with comprehensive type definitions
🎯 **Complete Baileys Features** - Access to all Baileys functionality
📦 **Readable & Maintainable** - Clean, well-documented code

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

// Start a session
const session = await wacap.sessionStart('my-session');

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
    await wacap.sendMessage('my-session', data.from, 'Hello!');
  }
});
```

### Multi-Session Support

```typescript
// Start multiple sessions
const session1 = await wacap.sessionStart('session-1');
const session2 = await wacap.sessionStart('session-2');
const session3 = await wacap.sessionStart('session-3');

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
await wacap.sessionStop('session-2');
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

##### `sessionStart(sessionId: string, customConfig?: Partial<WacapConfig>): Promise<Session>`
Start a new session or resume existing one.

```typescript
const session = await wacap.sessionStart('my-session');
```

##### `sessionStop(sessionId: string): Promise<void>`
Stop an active session.

```typescript
await wacap.sessionStop('my-session');
```

##### `findSession(sessionId: string): Session | undefined`
Find and return a session.

```typescript
const session = wacap.findSession('my-session');
```

##### `getAllSessions(): Map<string, Session>`
Get all active sessions.

```typescript
const sessions = wacap.getAllSessions();
```

##### `getSessionIds(): string[]`
Get all session IDs.

```typescript
const ids = wacap.getSessionIds();
```

##### `hasSession(sessionId: string): boolean`
Check if session exists.

```typescript
if (wacap.hasSession('my-session')) {
  // Session exists
}
```

##### `deleteSession(sessionId: string): Promise<void>`
Delete session data from storage.

```typescript
await wacap.deleteSession('my-session');
```

##### `sendMessage(sessionId: string, jid: string, text: string, options?): Promise<WAMessage>`
Send a text message.

```typescript
await wacap.sendMessage('my-session', '6281234567890@s.whatsapp.net', 'Hello!');

// With mentions
await wacap.sendMessage('my-session', jid, 'Hello @user!', {
  mentions: ['6281234567890@s.whatsapp.net']
});
```

##### `sendMedia(sessionId: string, jid: string, media): Promise<WAMessage>`
Send media (image, video, audio, document).

```typescript
// Send image
await wacap.sendMedia('my-session', jid, {
  url: 'https://example.com/image.jpg',
  mimetype: 'image/jpeg',
  caption: 'Check this out!'
});

// Send document
await wacap.sendMedia('my-session', jid, {
  buffer: fileBuffer,
  mimetype: 'application/pdf',
  fileName: 'document.pdf'
});
```

##### `on(sessionId: string, event: WacapEventType, handler: EventHandler): void`
Register an event handler.

```typescript
wacap.on('my-session', WacapEventType.MESSAGE_RECEIVED, (data) => {
  console.log(data);
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
console.log(info.phoneNumber);
console.log(info.isActive);
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

### Event Types

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

## Storage

### SQLite (Default)

- ✅ Zero configuration
- ✅ File-based storage
- ✅ Perfect for small to medium deployments
- ✅ Automatic setup

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
│   ├── events/         # Event handling
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

## License

MIT License - see LICENSE file for details

## Credits

Built on top of the amazing [Baileys](https://github.com/WhiskeySockets/Baileys) library.

## Disclaimer

This project is not affiliated with WhatsApp or Meta. Use at your own risk and in accordance with WhatsApp's Terms of Service.
