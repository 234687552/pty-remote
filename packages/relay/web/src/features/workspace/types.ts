import type { ChatAttachment, ProviderId } from '@lzdi/pty-remote-protocol/runtime-types.ts';

export type WorkspacePane = 'chat' | 'terminal';

export interface StatusBadge {
  className: string;
  label: string;
  value: string;
}

export interface ComposerAttachment extends ChatAttachment {
  cliId: string;
  conversationId: string;
  error?: string;
  localId: string;
  providerId: ProviderId;
  status: 'uploading' | 'ready' | 'error';
}

export interface SentAttachmentBinding {
  attachments: ChatAttachment[];
  composedContent: string;
  conversationId: string;
  createdAt: string;
  displayText: string;
  id: string;
}
