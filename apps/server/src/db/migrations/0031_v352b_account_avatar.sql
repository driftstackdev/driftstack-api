-- V-352b — customer-uploaded avatar reference. Stores the R2 object
-- key (path within bucketPublic). Route layer surfaces a presigned
-- GET URL on /v1/account/me reads. Null = no avatar.

ALTER TABLE "accounts" ADD COLUMN "avatar_r2_key" text;
