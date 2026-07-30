// V-298c / V-309e — Team RBAC resource.
//
// All six /v1/team/* endpoints. Team membership IS honored on the auth
// path: send `X-Driftstack-Account: acc_<owner-uuid>` to act on the
// resources of an owner you are a member of. The request is authorized
// against your membership role ('admin' or 'member') and the route's
// required scope; without the header every call acts on your own account.

import type { HttpClient } from '../http.js';

export type TeamRole = 'member' | 'admin';

export interface TeamMember {
  id: string;
  owner_account_id: string;
  member_account_id: string;
  member_email: string;
  role: TeamRole;
  invited_at: string;
  accepted_at: string;
  invited_by_account_id: string | null;
}

export interface TeamInvite {
  id: string;
  owner_account_id: string;
  invitee_email: string;
  role: TeamRole;
  expires_at: string;
  invited_by_account_id: string | null;
  accepted_at: string | null;
  created_at: string;
}

export interface TeamOwner {
  owner_account_id: string;
  owner_email: string;
  owner_name: string | null;
  role: TeamRole;
  membership_id: string;
}

export interface TeamMembersList {
  data: TeamMember[];
}

export interface TeamInvitesList {
  data: TeamInvite[];
}

export interface TeamOwnersList {
  data: TeamOwner[];
}

export interface AcceptInviteResponse {
  membership: TeamMember;
}

export interface InviteOptions {
  role?: TeamRole;
}

export class TeamResource {
  constructor(private readonly http: HttpClient) {}

  /** Invite an email to the calling owner's team. account_owner scope required. */
  invite(email: string, options: InviteOptions = {}): Promise<{ message: string }> {
    return this.http.request<{ message: string }>({
      method: 'POST',
      path: '/v1/team/invites',
      body: { email, ...(options.role !== undefined ? { role: options.role } : {}) },
    });
  }

  // Requires broad read or account_owner.
  /** List confirmed team members for the calling owner. */
  listMembers(): Promise<TeamMembersList> {
    return this.http.request<TeamMembersList>({
      method: 'GET',
      path: '/v1/team/members',
    });
  }

  // Requires broad read or account_owner.
  /** List pending (unaccepted, unexpired) invites for the calling owner. */
  listInvites(): Promise<TeamInvitesList> {
    return this.http.request<TeamInvitesList>({
      method: 'GET',
      path: '/v1/team/invites',
    });
  }

  // Requires broad read or account_owner.
  /** List owner workspaces the calling account has joined. */
  listOwners(): Promise<TeamOwnersList> {
    return this.http.request<TeamOwnersList>({
      method: 'GET',
      path: '/v1/team/owners',
    });
  }

  /**
   * Accept a pending invite. The accepting account's email MUST match
   * the invitee email — server enforces; mismatched accept returns 409.
   * Requires account_owner (dashboard web sessions satisfy it).
   */
  acceptInvite(token: string): Promise<AcceptInviteResponse> {
    return this.http.request<AcceptInviteResponse>({
      method: 'POST',
      path: '/v1/team/invites/accept',
      body: { token },
    });
  }

  /** Remove a member by membership id. account_owner scope required. */
  removeMember(membershipId: string): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: `/v1/team/members/${encodeURIComponent(membershipId)}`,
    });
  }
}
