// Wave 29-400 §1+§2 telemetry consumer — parser + aggregator unit tests.
// Sample log lines mirror the schema in docs/internal/driftstack-
// telemetry-event-schema-for-gui-panel.md.

import { describe, expect, it } from 'vitest';
import {
  applyEventLine,
  deriveSpoofingStatus,
  emptySessionTelemetryState,
  reduceEventStream,
} from '../../src/lib/fork-telemetry';

describe('fork-telemetry parser + aggregator', () => {
  it('emptySessionTelemetryState — clean zeros + inactive status', () => {
    const s = emptySessionTelemetryState();
    expect(s.archetypeId).toBeNull();
    expect(s.atlas.main.loaded).toBe(false);
    expect(s.atlas.priority.loaded).toBe(false);
    expect(s.v510Hits.main).toBe(0);
    expect(s.v510Hits.priority).toBe(0);
    expect(s.unknownLines).toBe(0);
    expect(deriveSpoofingStatus(s)).toBe('inactive');
  });

  it('V510 atlas-mapped event populates atlas slot inventory', () => {
    const s = emptySessionTelemetryState();
    applyEventLine(
      s,
      '[Driftstack] V510Atlas[main]: mapped 12345 from /opt/driftstack/atlas/v510-main.bin; 3084 entries; format=v1; file_mtime=1779000000',
    );
    expect(s.atlas.main).toEqual({
      loaded: true,
      bytes: 12345,
      path: '/opt/driftstack/atlas/v510-main.bin',
      entryCount: 3084,
      format: 'v1',
      fileMtimeEpoch: 1779000000,
    });
    expect(s.atlas.priority.loaded).toBe(false);
    expect(deriveSpoofingStatus(s)).toBe('partial');
  });

  it('V510 atlas-not-present event records path but keeps loaded=false', () => {
    const s = emptySessionTelemetryState();
    applyEventLine(
      s,
      '[Driftstack] V510Atlas[priority]: not present at /opt/driftstack/atlas/v510-priority.bin — disabled (auto-learn pre-seeded)',
    );
    expect(s.atlas.priority.loaded).toBe(false);
    expect(s.atlas.priority.path).toBe('/opt/driftstack/atlas/v510-priority.bin');
  });

  it('V510 hit lines per slot increment v510Hits per slot', () => {
    const s = emptySessionTelemetryState();
    applyEventLine(s, '[Driftstack-V510-HIT] slot=main entry=10/3084 off=24 len=128 format=v1');
    applyEventLine(s, '[Driftstack-V510-HIT] slot=main entry=11/3084 off=152 len=128 format=v1');
    applyEventLine(s, '[Driftstack-V510-HIT] slot=priority entry=1/3 off=0 len=64 format=v1');
    expect(s.v510Hits.main).toBe(2);
    expect(s.v510Hits.priority).toBe(1);
  });

  it('W29399 §1 AFP fallback lines increment per-context counters', () => {
    const s = emptySessionTelemetryState();
    applyEventLine(
      s,
      '[Driftstack-W29399-S1-AFP-Fallback-Fired] context=toDataURL w=320 h=240 mime=image/png',
    );
    applyEventLine(
      s,
      '[Driftstack-W29399-S1-AFP-Fallback-Fired] context=Worker w=480 h=320 mime=image/png',
    );
    expect(s.afpFires.toDataURL).toBe(1);
    expect(s.afpFires.Worker).toBe(1);
    expect(s.afpFires.toBlob).toBe(0);
    expect(deriveSpoofingStatus(s)).toBe('active');
  });

  it('W29399 §2 ProbeSig emissions increment per-context counters', () => {
    const s = emptySessionTelemetryState();
    applyEventLine(
      s,
      '[Driftstack-W29399-S2-ProbeSig-toBlob] w=320 h=240 opSeqSha=abcd opSeqBytesB64=ZG9v',
    );
    applyEventLine(
      s,
      '[Driftstack-W29399-S2-ProbeSig-toBlob] w=320 h=240 opSeqSha=efgh opSeqBytesB64=YmFy',
    );
    expect(s.probeSigEmissions.toBlob).toBe(2);
  });

  it('per-hook V-tag lines increment hookFires per tag', () => {
    const s = emptySessionTelemetryState();
    applyEventLine(s, '[Driftstack-V185] noise applied to ImageData scope=tracker');
    applyEventLine(s, '[Driftstack-V184] measureText override fired');
    applyEventLine(s, '[Driftstack-V166-DASA] audio normalize fp=0x1234');
    applyEventLine(s, '[Driftstack-V185] noise applied to canvas scope=tracker');
    expect(s.hookFires.V185).toBe(2);
    expect(s.hookFires.V184).toBe(1);
    expect(s.hookFires['V166-DASA']).toBe(1);
    expect(s.hookFires.V186).toBe(0);
  });

  it('archetype init event populates archetypeId', () => {
    const s = emptySessionTelemetryState();
    applyEventLine(s, '[Driftstack-Archetype-Init] archetype=iphone17_ios18_7_safari26_4');
    expect(s.archetypeId).toBe('iphone17_ios18_7_safari26_4');
  });

  it('unknown driftstack lines increment unknownLines (drift signal)', () => {
    const s = emptySessionTelemetryState();
    applyEventLine(s, '[Driftstack-NewlyAddedEvent] foo=1 bar=2');
    applyEventLine(s, '[Driftstack-FutureSlice] x=y');
    expect(s.unknownLines).toBe(2);
  });

  it('non-driftstack lines are ignored without counting toward unknownLines', () => {
    const s = emptySessionTelemetryState();
    applyEventLine(s, 'CONSOLE LOG: hello from page script');
    applyEventLine(s, '2026-05-19 16:43 [WebKit] random log');
    expect(s.unknownLines).toBe(0);
  });

  it('reduceEventStream — full stream → coherent snapshot, active status', () => {
    const stream = [
      '[Driftstack-Archetype-Init] archetype=iphone17_ios18_7_safari26_4',
      '[Driftstack] V510Atlas[main]: mapped 99999 from /opt/d/atlas-main.bin; 3084 entries; format=v1; file_mtime=1779000000',
      '[Driftstack] V510Atlas[priority]: not present at /opt/d/atlas-priority.bin — disabled (auto-learn pre-seeded)',
      '[Driftstack-V510-HIT] slot=main entry=12/3084 off=0 len=128 format=v1',
      '[Driftstack-V185] hook fired',
      '[Driftstack-V166-DASA] audio fired',
      '[Driftstack-V510-HIT] slot=main entry=13/3084 off=128 len=128 format=v1',
    ];
    const s = reduceEventStream(stream);
    expect(s.archetypeId).toBe('iphone17_ios18_7_safari26_4');
    expect(s.atlas.main.entryCount).toBe(3084);
    expect(s.atlas.priority.loaded).toBe(false);
    expect(s.v510Hits.main).toBe(2);
    expect(s.hookFires.V185).toBe(1);
    expect(s.hookFires['V166-DASA']).toBe(1);
    expect(s.unknownLines).toBe(0);
    expect(deriveSpoofingStatus(s)).toBe('active');
  });

  it('deriveSpoofingStatus — partial when atlas loaded but no hits/hooks', () => {
    const s = emptySessionTelemetryState();
    applyEventLine(
      s,
      '[Driftstack] V510Atlas[main]: mapped 100 from /tmp/x.bin; 3 entries; format=v1; file_mtime=1779000000',
    );
    expect(deriveSpoofingStatus(s)).toBe('partial');
  });
});
