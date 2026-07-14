// Both customer session-create surfaces must serialize on this exact key before
// checking or binding a persistent profile. Keeping the namespace constructor in
// one module prevents the legacy and agent repositories from silently drifting
// into independent locks again.
export function profileSessionAdvisoryLockKey(profileId: string): string {
  return `profile-session:${profileId}`;
}
