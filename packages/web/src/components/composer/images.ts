/**
 * Prompt images (spec 5.5): attachments held by the composer and how they reach the host. The collab wire carries
 * `images` on a prompt frame and `GuestClient.sendPrompt(text, images?)` sends them; {@link supportsPromptImages}
 * checks that the client declares the parameter, so a client without it refuses attachments instead of dropping them.
 */
import type { ImageContent } from "@oh-my-pi/pi-wire";
import { PROMPT_IMAGE_TYPES } from "../../lib/mentions";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 8;

export interface ImageAttachment {
	id: number;
	name: string;
	mimeType: string;
	/** Base64 without a data-URL prefix, as the wire expects. */
	data: string;
	/** Object URL for the thumbnail; revoked when the attachment goes away. */
	previewUrl: string;
}

export interface TextPromptClient {
	sendPrompt(text: string): void;
}

export interface ImagePromptClient {
	sendPrompt(text: string, images?: ImageContent[]): void;
}

/**
 * True when the client's `sendPrompt` declares an `images` parameter. A method that ignores a second argument has
 * `length` 1, so this never claims support the transport lacks. The client must declare it as `images?:`, not as a
 * defaulted parameter (a default drops the declared length).
 */
export function supportsPromptImages(client: TextPromptClient): boolean {
	return client.sendPrompt.length >= 2;
}

export function isPromptImage(file: { type: string }): boolean {
	return PROMPT_IMAGE_TYPES.has(file.type);
}

export type AttachRejection = "not-an-image" | "too-large" | "too-many";

/** Why `file` cannot be attached next to `existing` attachments, or null when it can. */
export function attachRejection(file: { type: string; size: number }, existing: number): AttachRejection | null {
	if (!isPromptImage(file)) return "not-an-image";
	if (file.size > MAX_IMAGE_BYTES) return "too-large";
	if (existing >= MAX_IMAGES) return "too-many";
	return null;
}

export function rejectionMessage(name: string, reason: AttachRejection): string {
	switch (reason) {
		case "not-an-image":
			return `${name}: only PNG, JPEG, GIF and WebP images can be attached`;
		case "too-large":
			return `${name}: larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`;
		case "too-many":
			return `At most ${MAX_IMAGES} images per prompt`;
	}
}

/** Base64 of the file's bytes (chunked so large images do not overflow `String.fromCharCode`'s argument limit). */
export async function fileToBase64(file: Blob): Promise<string> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

export function toImageContent(attachments: readonly ImageAttachment[]): ImageContent[] {
	return attachments.map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
}

/** Sends one prompt; images ride along only when the client can carry them. Returns whether they were sent. */
export function submitPrompt(client: TextPromptClient, text: string, attachments: readonly ImageAttachment[]): boolean {
	if (attachments.length > 0 && supportsPromptImages(client)) {
		(client as ImagePromptClient).sendPrompt(text, toImageContent(attachments));
		return true;
	}
	client.sendPrompt(text);
	return false;
}
