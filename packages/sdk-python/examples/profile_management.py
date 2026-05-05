"""Profile management — profiles surface end-to-end.

Profiles are persistent browser-state slots: cookies, localStorage,
IndexedDB. Sessions can attach to a profile to resume a logged-in
state across runs. The Manual ladder uses profile count as the
tier-defining metric (Solo Manual = 10, Team Manual = 50, Agency
Manual = 200); the API ladder also caps profiles per ADR-004.

Walks: create → list (paginated via iterate) → get → update → delete.

Run::

    DRIFTSTACK_API_KEY=ds_live_… python examples/profile_management.py
"""

from __future__ import annotations

import os
import sys
import time

from driftstack import Driftstack


def main() -> int:
    api_key = os.environ.get("DRIFTSTACK_API_KEY")
    if not api_key:
        print("DRIFTSTACK_API_KEY environment variable is required", file=sys.stderr)
        return 1

    base_url = os.environ.get("DRIFTSTACK_BASE_URL", "https://api.driftstack.dev")
    client = Driftstack(api_key=api_key, base_url=base_url)

    # 1. Create a fresh profile. Archetype defaults to the locked
    #    iPhone 16 Pro / iOS 18.7 / Safari 26.4 surface server-side
    #    if omitted (V-136 LOCKED_ARCHETYPE_ID).
    print("creating profile…")
    created = client.profiles.create(
        {
            "name": f"demo-{int(time.time())}",
            "description": "Profile-management example fixture",
        }
    )
    print(f"  → {created['id']}  ({created['name']})")

    # 2. List all profiles for this account, paginated.
    #    iterate() walks the cursor automatically. For very large
    #    accounts prefer list(limit=...) + cursor pagination.
    print("listing all profiles…")
    count = 0
    for profile in client.profiles.iterate(limit=50):
        count += 1
        if count <= 5:
            print(f"  {profile['id']}  {profile['name']}  {profile['archetype']}")
    print(f"  → {count} profile(s) total")

    # 3. Fetch a single profile by id.
    print("fetching the new profile by id…")
    fetched = client.profiles.get(created["id"])
    print(f"  → {fetched['id']}  description={fetched.get('description', '')!r}")

    # 4. Update — rename + change description. Profile-name uniqueness
    #    is scoped to (account_id, name) per D-032.
    print("updating profile…")
    updated = client.profiles.update(
        created["id"],
        {
            "name": f"{created['name']}-renamed",
            "description": "Updated via profile-management example",
        },
    )
    print(f"  → {updated['id']}  new name={updated['name']!r}")

    # 5. Delete.
    print("deleting profile…")
    client.profiles.delete(created["id"])
    print("  → deleted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
