// Mock data for admin-panel scaffolding. Real reads against
// /v1/admin/* land when the panel moves past scaffolding.

import type { AccountTier } from '@driftstack/api-types';

export interface MockAdminAccount {
  id: string;
  email: string;
  name: string | null;
  tier: AccountTier;
  status: 'active' | 'suspended' | 'deleted';
  createdAt: string;
  lastSeenAt: string | null;
}

export const MOCK_ACCOUNTS: MockAdminAccount[] = [
  {
    id: 'acc_00000000-0000-4000-8000-000000000001',
    email: 'tester@driftstack.local',
    name: 'Tester',
    tier: 'api_builder',
    status: 'active',
    createdAt: '2026-04-15T08:55:00Z',
    lastSeenAt: '2026-05-04T10:00:00Z',
  },
  {
    id: 'acc_00000000-0000-4000-8000-000000000002',
    email: 'agency@driftstack.local',
    name: 'Agency Test',
    tier: 'agency_manual',
    status: 'active',
    createdAt: '2026-04-22T14:00:00Z',
    lastSeenAt: '2026-05-03T22:30:00Z',
  },
  {
    id: 'acc_00000000-0000-4000-8000-000000000003',
    email: 'suspended@driftstack.local',
    name: null,
    tier: 'api_starter',
    status: 'suspended',
    createdAt: '2026-04-10T09:00:00Z',
    lastSeenAt: '2026-04-25T16:45:00Z',
  },
];

export interface MockAuditLogEntry {
  id: string;
  ts: string;
  adminEmail: string;
  action: string;
  targetAccountId: string | null;
  targetResourceId: string | null;
  result: 'success' | 'error';
}

export const MOCK_AUDIT_LOG: MockAuditLogEntry[] = [
  {
    id: 'aud_00000000-0000-4000-8000-0000000000a1',
    ts: '2026-05-04T11:30:00Z',
    adminEmail: 'staff@driftstack.dev',
    action: 'account.tier_changed',
    targetAccountId: 'acc_00000000-0000-4000-8000-000000000001',
    targetResourceId: null,
    result: 'success',
  },
  {
    id: 'aud_00000000-0000-4000-8000-0000000000a2',
    ts: '2026-05-04T11:15:00Z',
    adminEmail: 'staff@driftstack.dev',
    action: 'session.destroyed_by_admin',
    targetAccountId: 'acc_00000000-0000-4000-8000-000000000002',
    targetResourceId: 'ses_00000000-0000-4000-8000-0000000000c1',
    result: 'success',
  },
  {
    id: 'aud_00000000-0000-4000-8000-0000000000a3',
    ts: '2026-05-04T10:45:00Z',
    adminEmail: 'staff@driftstack.dev',
    action: 'webhook_delivery.requeued',
    targetAccountId: 'acc_00000000-0000-4000-8000-000000000002',
    targetResourceId: 'wdl_00000000-0000-4000-8000-0000000000d1',
    result: 'success',
  },
];

export interface MockLead {
  id: string;
  email: string;
  source: 'docs_signup' | 'pricing_cta' | 'email_inbound' | 'other';
  capturedAt: string;
  notes: string | null;
}

export const MOCK_LEADS: MockLead[] = [
  {
    id: 'lead_00000000-0000-4000-8000-0000000000e1',
    email: 'enterprise@example.test',
    source: 'pricing_cta',
    capturedAt: '2026-05-03T16:00:00Z',
    notes: 'Asked about self-hosted enterprise + custom archetype dev.',
  },
  {
    id: 'lead_00000000-0000-4000-8000-0000000000e2',
    email: 'agency@example.test',
    source: 'docs_signup',
    capturedAt: '2026-05-02T09:30:00Z',
    notes: null,
  },
];
