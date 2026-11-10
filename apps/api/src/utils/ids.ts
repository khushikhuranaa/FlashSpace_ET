import { randomUUID, randomBytes } from 'node:crypto';

export const newId = (): string => randomUUID();

export const newToken = (bytes = 32): string => randomBytes(bytes).toString('hex');
