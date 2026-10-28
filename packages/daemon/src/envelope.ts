import { ENVELOPE_HEADER_LENGTH } from "@oh-my-pi/pi-wire";

/** Reads the destination peer id of a host frame (`[4B uint32 BE peerId][sealed payload]`). */
export function readEnvelopePeer(data: Uint8Array): number | null {
	if (data.byteLength < ENVELOPE_HEADER_LENGTH) return null;
	return new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
}

/** Rewrites the peer id in place without copying the sealed payload. */
export function rewriteEnvelopePeer(data: Uint8Array, peerId: number): void {
	new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).setUint32(0, peerId, false);
}
