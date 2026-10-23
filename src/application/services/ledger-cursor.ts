import { BadRequestException } from '@nestjs/common';

export interface LedgerCursor {
  version: 1;
  walletId: string;
  createdAt: string;
  id: string;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TIMESTAMP_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}Z$/;

export function encodeLedgerCursor(
  cursor: LedgerCursor,
): string {
  return Buffer.from(
    JSON.stringify(cursor),
    'utf8',
  ).toString('base64url');
}

export function decodeLedgerCursor(
  encoded: unknown,
  walletId: string,
): LedgerCursor {
  if (
    typeof encoded !== 'string' ||
    encoded.length === 0 ||
    encoded.length > 1024 ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    throw new BadRequestException('INVALID_LEDGER_CURSOR');
  }

  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(encoded, 'base64url')
        .toString('utf8'),
    );

    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      Array.isArray(decoded)
    ) {
      throw new Error('INVALID_CURSOR_OBJECT');
    }

    const value = decoded as Record<string, unknown>;

    if (
      value.version !== 1 ||
      value.walletId !== walletId ||
      typeof value.id !== 'string' ||
      !UUID_REGEX.test(value.id) ||
      typeof value.createdAt !== 'string' ||
      !TIMESTAMP_REGEX.test(value.createdAt) ||
      Number.isNaN(Date.parse(value.createdAt))
    ) {
      throw new Error('INVALID_CURSOR_DATA');
    }

    return {
      version: 1,
      walletId,
      id: value.id,
      createdAt: value.createdAt,
    };
  } catch {
    throw new BadRequestException('INVALID_LEDGER_CURSOR');
  }
}
