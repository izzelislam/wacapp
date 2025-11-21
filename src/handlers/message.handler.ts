import { WacapEventType } from '../types';
import { HandlerContext } from './index';

export function registerMessageHandlers(ctx: HandlerContext): void {
  const { socket, storageAdapter, sessionId, emit, touchActivity } = ctx;

  socket.ev.on('messages.upsert', async ({ messages }) => {
    for (const message of messages) {
      touchActivity();
      await storageAdapter.saveMessage(sessionId, message);

      const eventData = {
        message,
        isFromMe: message.key.fromMe,
        messageType: Object.keys(message.message || {})[0],
        body: getMessageBody(message),
        from: message.key.remoteJid,
      };

      if (message.key.fromMe) {
        emit(WacapEventType.MESSAGE_SENT, eventData);
      } else {
        emit(WacapEventType.MESSAGE_RECEIVED, eventData);
      }
    }
  });

  socket.ev.on('messages.update', async (updates) => {
    for (const update of updates) {
      touchActivity();
      emit(WacapEventType.MESSAGE_UPDATE, {
        message: update as any,
      });
    }
  });

  socket.ev.on('messages.delete', async () => {
    touchActivity();
    emit(WacapEventType.MESSAGE_DELETE, {});
  });

  socket.ev.on('chats.upsert', async (chats) => {
    for (const chat of chats) {
      await storageAdapter.saveChat(sessionId, chat);
    }
    touchActivity();
    emit(WacapEventType.CHAT_UPDATE, {});
  });
}

function getMessageBody(message: any): string | undefined {
  const messageContent = message.message;
  if (!messageContent) return undefined;

  return (
    messageContent.conversation ||
    messageContent.extendedTextMessage?.text ||
    messageContent.imageMessage?.caption ||
    messageContent.videoMessage?.caption ||
    messageContent.documentMessage?.caption ||
    undefined
  );
}
