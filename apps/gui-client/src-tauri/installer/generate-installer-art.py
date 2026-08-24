#!/usr/bin/env python3
"""Compose the Driftstack mark onto brand-coloured NSIS installer artwork.

NSIS wants 24-bit, bottom-up BMP. `sips` emits 32-bit top-down (verified:
"164 x -314 x 32"), which NSIS rejects — so the encoding is done here instead
of trusting a converter that produces the wrong thing quietly.

Pure stdlib: zlib for the PNG IDAT, a hand-rolled unfilter, a box-filter
downscale, and a BMP writer. No Pillow/ImageMagick on this machine.
"""
import struct
import sys
import zlib

BG = (0x0B, 0x0F, 0x14)  # near-black, the icon's own ground and the GUI shell's


def read_png_rgba(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'not a PNG'
    pos, idat, w, h, bitd, ctype = 8, b'', 0, 0, 0, 0
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h, bitd, ctype = struct.unpack('>IIBB', body[:10])
        elif typ == b'IDAT':
            idat += body
        elif typ == b'IEND':
            break
        pos += 12 + ln
    assert bitd == 8, f'only 8-bit supported, got {bitd}'
    assert ctype in (2, 6), f'only RGB/RGBA supported, got {ctype}'
    nch = 4 if ctype == 6 else 3
    raw = zlib.decompress(idat)
    stride = w * nch
    out, prev = [], bytearray(stride)
    p = 0
    for _ in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        # PNG filters operate on the byte before, which is nch back.
        for i in range(stride):
            a = line[i - nch] if i >= nch else 0
            b = prev[i]
            c = prev[i - nch] if i >= nch else 0
            x = line[i]
            if f == 1:   line[i] = (x + a) & 0xFF
            elif f == 2: line[i] = (x + b) & 0xFF
            elif f == 3: line[i] = (x + ((a + b) >> 1)) & 0xFF
            elif f == 4:
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (x + pr) & 0xFF
        out.append(bytes(line))
        prev = line
    px = []
    for line in out:
        row = []
        for i in range(0, len(line), nch):
            r, g, b = line[i], line[i + 1], line[i + 2]
            al = line[i + 3] if nch == 4 else 255
            row.append((r, g, b, al))
        px.append(row)
    return w, h, px


def flatten_and_scale(px, sw, sh, tw, th):
    """Box-filter downscale, compositing alpha onto BG as we go."""
    out = []
    for ty in range(th):
        y0, y1 = ty * sh // th, max(ty * sh // th + 1, (ty + 1) * sh // th)
        row = []
        for tx in range(tw):
            x0, x1 = tx * sw // tw, max(tx * sw // tw + 1, (tx + 1) * sw // tw)
            r = g = b = n = 0
            for y in range(y0, y1):
                for x in range(x0, x1):
                    sr, sg, sb, sa = px[y][x]
                    a = sa / 255.0
                    r += sr * a + BG[0] * (1 - a)
                    g += sg * a + BG[1] * (1 - a)
                    b += sb * a + BG[2] * (1 - a)
                    n += 1
            row.append((int(r / n), int(g / n), int(b / n)))
        out.append(row)
    return out


def write_bmp24(path, w, h, rows):
    """24-bit, BOTTOM-UP (positive height) — the shape NSIS accepts."""
    pad = (4 - (w * 3) % 4) % 4
    body = bytearray()
    for y in range(h - 1, -1, -1):          # bottom-up row order
        for (r, g, b) in rows[y]:
            body += bytes((b, g, r))         # BMP is BGR
        body += b'\x00' * pad
    hdr = struct.pack('<IiiHHIIiiII', 40, w, h, 1, 24, 0, len(body), 2835, 2835, 0, 0)
    fh = b'BM' + struct.pack('<IHHI', 14 + len(hdr) + len(body), 0, 0, 14 + len(hdr))
    open(path, 'wb').write(fh + hdr + body)


def compose(src, dst, tw, th, logo_frac):
    sw, sh, px = read_png_rgba(src)
    side = int(min(tw, th) * logo_frac)
    logo = flatten_and_scale(px, sw, sh, side, side)
    canvas = [[BG for _ in range(tw)] for _ in range(th)]
    ox, oy = (tw - side) // 2, (th - side) // 2
    for y in range(side):
        for x in range(side):
            canvas[oy + y][ox + x] = logo[y][x]
    write_bmp24(dst, tw, th, canvas)
    print(f'wrote {dst} ({tw}x{th}, logo {side}px)')


if __name__ == '__main__':
    src = sys.argv[1]
    compose(src, sys.argv[2], 164, 314, 0.62)   # sidebar: welcome/finish panel
    compose(src, sys.argv[3], 150, 57, 0.80)    # header: per-page banner strip
