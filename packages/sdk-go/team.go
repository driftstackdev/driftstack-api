package driftstack

import (
	"context"
	"net/url"
)

// TeamResource handles /v1/team/*. V-298c routes; auth path
// integration is V-298d — accepted members can sign in but the
// membership grants no implicit permissions on the owner's resources
// until V-298d ships.
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
