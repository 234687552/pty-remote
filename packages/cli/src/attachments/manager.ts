import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ProviderId } from '@lzdi/pty-remote-protocol/runtime-types.ts';

export interface UploadAttachmentInput {
  contentBase64: string;
  conversationKey: string | null;
  cwd: string;
  filename: string;
  mimeType: string;
  providerId: ProviderId;
  sessionId: string | null;
  size: number;
}

export interface UploadedAttachmentRecord {
  attachmentId: string;
  conversationKey: string | null;
  cwd: string;
  filename: string;
  mimeType: string;
  path: string;
  providerId: ProviderId;
  sessionId: string | null;
  size: number;
  status: 'pending' | 'sent';
  createdAt: number;
}

const ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;
const ATTACHMENT_PENDING_TTL_MS = 30 * 60 * 1000;
const ATTACHMENT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function sanitizeSegment(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, '-');
  return normalized.slice(0, 80) || 'attachment';
}

function sanitizeFilename(filename: string): string {
  return sanitizeSegment(filename).replace(/\.\.+/g, '.');
}

function estimateBase64Bytes(base64: string): number {
  const len = base64.length;
  if (len === 0) {
    return 0;
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

function createConversationDirectoryName(input: {
  conversationKey: string | null;
  cwd: string;
  sessionId: string | null;
}): string {
  const basis = input.conversationKey ?? input.sessionId ?? input.cwd;
  const hash = createHash('sha1').update(basis).digest('hex').slice(0, 12);
  const label = sanitizeSegment(path.basename(input.cwd) || (input.conversationKey ?? input.sessionId ?? 'draft'));
  return `${label}-${hash}`;
}

export class AttachmentManager {
  private readonly attachments = new Map<string, UploadedAttachmentRecord>();

  private readonly rootDir = path.join(os.homedir(), '.pty-remote', 'uploads');

  private cleanupTimer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredPending();
    }, ATTACHMENT_CLEANUP_INTERVAL_MS);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async uploadAttachment(input: UploadAttachmentInput): Promise<UploadedAttachmentRecord> {
    const estimatedBytes = estimateBase64Bytes(input.contentBase64);
    if (estimatedBytes > ATTACHMENT_MAX_BYTES || input.size > ATTACHMENT_MAX_BYTES) {
      throw new Error('图片不能超过 4MB');
    }

    const attachmentId = randomUUID();
    const directory = path.join(
      this.rootDir,
      input.providerId,
      createConversationDirectoryName({
        conversationKey: input.conversationKey,
        cwd: input.cwd,
        sessionId: input.sessionId
      })
    );
    const filename = `${Date.now()}-${attachmentId}-${sanitizeFilename(input.filename)}`;
    const filePath = path.join(directory, filename);
    const buffer = Buffer.from(input.contentBase64, 'base64');

    if (buffer.length > ATTACHMENT_MAX_BYTES) {
      throw new Error('图片不能超过 4MB');
    }

    await mkdir(directory, { recursive: true });
    await writeFile(filePath, buffer);

    const record: UploadedAttachmentRecord = {
      attachmentId,
      conversationKey: input.conversationKey,
      cwd: input.cwd,
      createdAt: Date.now(),
      filename: input.filename,
      mimeType: input.mimeType,
      path: filePath,
      providerId: input.providerId,
      sessionId: input.sessionId,
      size: input.size,
      status: 'pending'
    };

    this.attachments.set(attachmentId, record);
    return record;
  }

  async deleteAttachment(attachmentId: string): Promise<void> {
    const record = this.attachments.get(attachmentId);
    if (!record) {
      return;
    }

    this.attachments.delete(attachmentId);
    await rm(record.path, { force: true }).catch(() => undefined);
  }

  markReferencedPathsAsSent(content: string): void {
    for (const record of this.attachments.values()) {
      if (record.status === 'sent') {
        continue;
      }
      if (content.includes(`@${record.path}`)) {
        record.status = 'sent';
      }
    }
  }

  async cleanupConversation(target: {
    conversationKey: string | null;
    cwd: string;
    providerId: ProviderId;
    sessionId: string | null;
  }): Promise<void> {
    const removals = [...this.attachments.values()].filter(
      (record) =>
        record.providerId === target.providerId &&
        record.cwd === target.cwd &&
        record.conversationKey === target.conversationKey &&
        record.sessionId === target.sessionId
    );

    await Promise.all(removals.map((record) => this.deleteAttachment(record.attachmentId)));
  }

  async cleanupProject(target: { cwd: string; providerId: ProviderId }): Promise<void> {
    const removals = [...this.attachments.values()].filter(
      (record) => record.providerId === target.providerId && record.cwd === target.cwd
    );

    await Promise.all(removals.map((record) => this.deleteAttachment(record.attachmentId)));
  }

  async cleanupExpiredPending(): Promise<void> {
    const cutoff = Date.now() - ATTACHMENT_PENDING_TTL_MS;
    const removals = [...this.attachments.values()].filter(
      (record) => record.status === 'pending' && record.createdAt < cutoff
    );

    await Promise.all(removals.map((record) => this.deleteAttachment(record.attachmentId)));
  }

  async shutdown(): Promise<void> {
    this.stop();
    const removals = [...this.attachments.values()].map((record) => this.deleteAttachment(record.attachmentId));
    await Promise.all(removals);
  }
}
