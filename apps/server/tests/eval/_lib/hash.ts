// One sha256 helper, so a hash in the report and a hash in a test are the same
// function rather than two spellings that agree until one of them is edited.

import { createHash } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
