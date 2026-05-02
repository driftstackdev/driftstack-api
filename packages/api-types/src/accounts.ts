import { z } from 'zod';
import { AccountIdSchema, AccountTierSchema, Iso8601Schema } from './common.js';

export const AccountStatusSchema = z.enum(['active', 'suspended', 'deleted']);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const AccountSchema = z.object({
  id: AccountIdSchema,
  email: z.string().email(),
  name: z.string().nullable(),
  tier: AccountTierSchema,
  status: AccountStatusSchema,
  created_at: Iso8601Schema,
  updated_at: Iso8601Schema,
});

export type Account = z.infer<typeof AccountSchema>;
