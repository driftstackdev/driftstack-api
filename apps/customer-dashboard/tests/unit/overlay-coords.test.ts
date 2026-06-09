// Unit tests for the W267 manual-control overlay coordinate projection.
// Validates the object-contain unscale + letterbox handling against a known
// geometry. The is:inline overlay script transcribes the same math.

import { describe, expect, it } from 'vitest';
import { projectToDeviceCoords } from '../../src/lib/overlay-coords';

// A 390x844 iPhone stream (device-CSS) displayed in a wider 600x844 overlay box
// → letterboxed left/right (scale = 1, displayed 390 wide, 105px bars each side).
const VIDEO = { videoWidth: 390, videoHeight: 844 };
const WIDE_BOX = { left: 0, top: 0, width: 600, height: 844 }; // scale 1, x-letterbox 105

describe('projectToDeviceCoords', () => {
  it('no stream yet (videoWidth 0) → null', () => {
    expect(
      projectToDeviceCoords({
        clientX: 50,
        clientY: 50,
        videoRect: WIDE_BOX,
        videoWidth: 0,
        videoHeight: 0,
      }),
    ).toBeNull();
  });

  it('center of the box → center of the device', () => {
    const r = projectToDeviceCoords({ clientX: 300, clientY: 422, videoRect: WIDE_BOX, ...VIDEO });
    expect(r).toEqual({ x: 195, y: 422 });
  });

  it('left edge of the displayed video (x=105px) → device x=0', () => {
    const r = projectToDeviceCoords({ clientX: 105, clientY: 0, videoRect: WIDE_BOX, ...VIDEO });
    expect(r).toEqual({ x: 0, y: 0 });
  });

  it('right edge of the displayed video (x=495px) → device x=390', () => {
    const r = projectToDeviceCoords({ clientX: 495, clientY: 844, videoRect: WIDE_BOX, ...VIDEO });
    expect(r).toEqual({ x: 390, y: 844 });
  });

  it('a click in the left letterbox (x=40 < 105) → null (not on the phone)', () => {
    expect(
      projectToDeviceCoords({ clientX: 40, clientY: 400, videoRect: WIDE_BOX, ...VIDEO }),
    ).toBeNull();
  });

  it('downscales a 2x stream: 780x1688 in a 390x844 box → scale 0.5', () => {
    const box = { left: 0, top: 0, width: 390, height: 844 };
    // box center (195, 422) → device (390, 844) center
    const r = projectToDeviceCoords({
      clientX: 195,
      clientY: 422,
      videoRect: box,
      videoWidth: 780,
      videoHeight: 1688,
    });
    expect(r).toEqual({ x: 390, y: 844 });
  });

  it('respects a non-zero rect origin (offset box)', () => {
    const box = { left: 100, top: 50, width: 390, height: 844 }; // scale 1, no letterbox
    const r = projectToDeviceCoords({ clientX: 100, clientY: 50, videoRect: box, ...VIDEO });
    expect(r).toEqual({ x: 0, y: 0 });
  });
});
