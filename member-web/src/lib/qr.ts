/**
 * QR rendering for the member card (and club invite links later): turns a
 * token string into an SVG path of dark modules via the zero-dependency
 * `qrcode-generator` encoder. Pure and synchronous, so components can
 * render the code inline and tests can assert on the geometry.
 */
import qrcode from 'qrcode-generator';

export interface QrSvgData {
  /** Modules per side (the SVG viewBox is `0 0 size size`). */
  size: number;
  /** One `M{x} {y}h1v1h-1z` square per dark module. */
  path: string;
}

/**
 * Encode `text` at error-correction level M with an auto-sized type
 * number. Draw with `shape-rendering: crispEdges` and leave a quiet zone
 * (padding) around the viewBox.
 */
export function qrSvgData(text: string): QrSvgData {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();

  const size = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
    }
  }
  return { size, path };
}
