/// <reference types="vite/client" />

// Compact local build stamp (MM-DD HH:MM:SS) baked in by vite.config.ts's
// `define` at build time. Absent under vitest (no define) — always read it
// through a `typeof __BUILD_STAMP__ !== 'undefined'` guard so test renders of
// build-stamp consumers don't ReferenceError.
declare const __BUILD_STAMP__: string;
