CREATE TABLE "legal_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"document_key" text NOT NULL,
	"version" text NOT NULL,
	"content_hash" text NOT NULL,
	"accepted_from_ip" text,
	"accepted_user_agent" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "legal_acceptances_account_doc_idx" ON "legal_acceptances" USING btree ("account_id","document_key");
--> statement-breakpoint
CREATE INDEX "legal_acceptances_account_idx" ON "legal_acceptances" USING btree ("account_id");
--> statement-breakpoint
CREATE INDEX "legal_acceptances_doc_version_idx" ON "legal_acceptances" USING btree ("document_key","version");
