import { X } from "lucide-react";
import type { ReactNode } from "react";
import "./composer.css";

export interface UploadChip {
	id: number;
	name: string;
	size: number;
	loaded: number;
	error?: string;
}

export interface UploadChipsProps {
	uploads: readonly UploadChip[];
	onCancel(id: number): void;
}

function formatSize(size: number): string {
	const units = ["B", "KiB", "MiB", "GiB"];
	let value = size;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** Progress and recoverable failures for files being copied to the session machine. */
export function UploadChips({ uploads, onCancel }: UploadChipsProps): ReactNode {
	if (uploads.length === 0) return null;
	return (
		<ul className="cmp-chips cmp-upload-chips" aria-label="files uploading to this session">
			{uploads.map(upload => (
				<li key={upload.id} className="cmp-chip cmp-upload-chip" data-error={upload.error !== undefined ? "true" : "false"}>
					<span className="cmp-chip-name" title={upload.name}>{upload.name}</span>
					<span className="cmp-upload-size">{formatSize(upload.size)}</span>
					{upload.error === undefined ? (
						<progress
						className="cmp-upload-progress"
						max={Math.max(upload.size, 1)}
						value={upload.loaded}
						aria-label={`uploading ${upload.name}`}
						aria-valuetext={`${upload.loaded} of ${upload.size} bytes`}
					/>
					) : (
						<span className="cmp-upload-error" role="alert">{upload.error}</span>
					)}
					<button
						type="button"
						className="cmp-chip-remove"
						onClick={() => onCancel(upload.id)}
						aria-label={upload.error === undefined ? `cancel upload ${upload.name}` : `dismiss upload error for ${upload.name}`}
					>
						<X size={12} />
					</button>
				</li>
			))}
		</ul>
	);
}
