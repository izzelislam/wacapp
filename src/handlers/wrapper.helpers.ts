import type { AnyMessageContent } from '@whiskeysockets/baileys';
import { SessionRegistry } from '../core/session-registry';
import { MessageOptions } from '../types';
import { Session } from '../core/session';

type MediaPayload = {
  url?: string;
  buffer?: Buffer;
  mimetype?: string;
  caption?: string;
  fileName?: string;
};

/**
 * Resolve a session from registry or throw descriptive error.
 */
export function getSessionOrThrow(registry: SessionRegistry, sessionId: string): Session {
  const session = registry.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }
  return session;
}

/**
 * Resolve socket from session or throw.
 */
export function getSocketOrThrow(session: Session): any {
  const socket = session.getSocket();
  if (!socket) {
    throw new Error(`Session ${session.getInfo().sessionId} is not connected`);
  }
  return socket;
}

/**
 * Send text via registry
 */
export async function sendText(
  registry: SessionRegistry,
  sessionId: string,
  jid: string,
  text: string,
  options?: Partial<MessageOptions>
): Promise<any> {
  const session = getSessionOrThrow(registry, sessionId);
  const socket = getSocketOrThrow(session);

  const message: AnyMessageContent = { text };

  if (options?.quoted) {
    return socket.sendMessage(jid, message, { quoted: options.quoted });
  }

  if (options?.mentions) {
    return socket.sendMessage(jid, { text, mentions: options.mentions });
  }

  return socket.sendMessage(jid, message);
}

/**
 * Build media content block based on mimetype
 */
function buildMediaContent(media: MediaPayload): Record<string, any> {
  const content: Record<string, any> = {};
  const mimetype = media.mimetype || '';

  if (mimetype.startsWith('image/')) {
    content.image = media.url || media.buffer;
    if (media.caption) content.caption = media.caption;
  } else if (mimetype.startsWith('video/')) {
    content.video = media.url || media.buffer;
    if (media.caption) content.caption = media.caption;
  } else if (mimetype.startsWith('audio/')) {
    content.audio = media.url || media.buffer;
    content.mimetype = mimetype;
  } else {
    content.document = media.url || media.buffer;
    content.mimetype = mimetype;
    if (media.fileName) content.fileName = media.fileName;
    if (media.caption) content.caption = media.caption;
  }

  return content;
}

/**
 * Send media via registry
 */
export async function sendMedia(
  registry: SessionRegistry,
  sessionId: string,
  jid: string,
  media: MediaPayload
): Promise<any> {
  const session = getSessionOrThrow(registry, sessionId);
  const socket = getSocketOrThrow(session);
  const content = buildMediaContent(media);
  return socket.sendMessage(jid, content);
}

/**
 * Create a new WhatsApp group
 */
export async function createGroup(
  registry: SessionRegistry,
  sessionId: string,
  subject: string,
  participantJids: string[]
): Promise<any> {
  const session = getSessionOrThrow(registry, sessionId);
  const socket = getSocketOrThrow(session);
  return socket.groupCreate(subject, participantJids);
}

type GroupAction = 'add' | 'remove' | 'promote' | 'demote';

/**
 * Update participants of an existing group
 */
export async function updateGroupParticipants(
  registry: SessionRegistry,
  sessionId: string,
  groupJid: string,
  participantJids: string[],
  action: GroupAction
): Promise<any> {
  const session = getSessionOrThrow(registry, sessionId);
  const socket = getSocketOrThrow(session);
  return socket.groupParticipantsUpdate(groupJid, participantJids, action);
}
