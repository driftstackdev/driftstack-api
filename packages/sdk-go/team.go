package driftstack

import (
	"context"
	"net/url"
)

// TeamResource handles /v1/team/*. V-298c routes. Team membership IS
// honored on the auth path: send X-Driftstack-Account: acc_<owner-uuid> to
// act on the resources of an owner you are a member of. The request is
// authorized against your membership role (admin or member) and the route's
// required scope; without the header every call acts on your own account.
type TeamResource struct {
	client *Client
}

// Invite an email to join the calling owner's team.
func (r *TeamResource) Invite(ctx context.Context, body *TeamInviteRequest) (*TeamInviteResponse, error) {
	if body == nil {
		body = &TeamInviteRequest{}
	}
	var out TeamInviteResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/team/invites",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListMembers returns confirmed memberships for the calling owner.
// Requires broad read or account_owner.
func (r *TeamResource) ListMembers(ctx context.Context) (*TeamMembersList, error) {
	var out TeamMembersList
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/team/members",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListInvites returns pending (unaccepted, unexpired) invites for the
// calling owner. Requires broad read or account_owner.
func (r *TeamResource) ListInvites(ctx context.Context) (*TeamInvitesList, error) {
	var out TeamInvitesList
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/team/invites",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListOwners returns owner workspaces the calling account has joined.
// Requires broad read or account_owner.
func (r *TeamResource) ListOwners(ctx context.Context) (*TeamOwnersList, error) {
	var out TeamOwnersList
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/team/owners",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// AcceptInvite consumes a token and creates the membership.
// Requires account_owner.
func (r *TeamResource) AcceptInvite(ctx context.Context, token string) (*TeamAcceptResponse, error) {
	var out TeamAcceptResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/team/invites/accept",
		body:   &TeamAcceptRequest{Token: token},
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// RemoveMember by membership id.
func (r *TeamResource) RemoveMember(ctx context.Context, membershipID string) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/team/members/" + url.PathEscape(membershipID),
	})
}
