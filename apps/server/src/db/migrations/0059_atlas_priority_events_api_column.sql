-- Wave 29-400 §10 forward-compat — atlas_priority_events.api column +
-- nullable mime.
--
-- When Agent 1's §10 hooks light up the additional canvas-readback
-- APIs (getImageData, gl.readPixels, etc.) they emit probe signatures
-- that DON'T have a MIME type (raw pixel buffers vs encoded images)
-- and that need to be distinguished from the §2 toBlob path. Adds an
-- `api` discriminator column (CHECK-constrained to the 8 known readback
-- APIs) and relaxes the mime NOT NULL constraint so raw-buffer probes
-- can omit it.
--
-- Existing rows in atlas_priority_events default to api='toBlob' (the
-- §2 starting hook) per the DEFAULT clause. Future inserts can
-- override; the route layer (§8.2) extends its body schema to accept
-- optional api at the same time, and Drizzle insertEmittedWithDedup
-- gains an args field for it.
--
-- Constraint values mirror the 8 known canvas-readback paths in the
-- Mac fork's harvester surface — keep this list in sync with
-- §10 hook definitions.

ALTER TABLE "atlas_priority_events"
  ADD COLUMN "api" text NOT NULL DEFAULT 'toBlob';

ALTER TABLE "atlas_priority_events"
  ADD CONSTRAINT "atlas_priority_events_api_check"
  CHECK ("api" IN (
    'toDataURL',
    'toBlob',
    'convertToBlob',
    'getImageData',
    'readPixels',
    'transferToImageBitmap',
    'captureStream',
    'webgpuReadback'
  ));

ALTER TABLE "atlas_priority_events" ALTER COLUMN "mime" DROP NOT NULL;
