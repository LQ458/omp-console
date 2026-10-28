import * as zlib from "node:zlib";

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	// CRC covers the type and the data.
	view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
	return out;
}

/** Encodes straight-alpha RGBA8 pixels (row-major, top row first) as a PNG. Output is deterministic. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
	if (rgba.length !== width * height * 4) {
		throw new Error(`rgba length ${rgba.length} does not match ${width}x${height}`);
	}
	const stride = width * 4;
	// Filter type 0 (none) on every scanline.
	const raw = new Uint8Array((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
	}
	const header = new Uint8Array(13);
	const hv = new DataView(header.buffer);
	hv.setUint32(0, width);
	hv.setUint32(4, height);
	header[8] = 8; // bit depth
	header[9] = 6; // colour type RGBA
	const parts = [
		PNG_SIGNATURE,
		chunk("IHDR", header),
		chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
		chunk("IEND", new Uint8Array(0)),
	];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** Reads width and height from a PNG's IHDR; throws when the bytes are not a PNG. */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } {
	for (let i = 0; i < PNG_SIGNATURE.length; i++) {
		if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error("not a PNG");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Wraps PNG images in an ICO container (PNG-in-ICO, supported by every current browser). */
export function encodeIco(images: { size: number; png: Uint8Array }[]): Uint8Array {
	const headerSize = 6 + 16 * images.length;
	const total = images.reduce((n, image) => n + image.png.length, headerSize);
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint16(2, 1, true); // type: icon
	view.setUint16(4, images.length, true);
	let offset = headerSize;
	images.forEach((image, index) => {
		const entry = 6 + 16 * index;
		out[entry] = image.size >= 256 ? 0 : image.size;
		out[entry + 1] = image.size >= 256 ? 0 : image.size;
		view.setUint16(entry + 4, 1, true); // colour planes
		view.setUint16(entry + 6, 32, true); // bits per pixel
		view.setUint32(entry + 8, image.png.length, true);
		view.setUint32(entry + 12, offset, true);
		out.set(image.png, offset);
		offset += image.png.length;
	});
	return out;
}
