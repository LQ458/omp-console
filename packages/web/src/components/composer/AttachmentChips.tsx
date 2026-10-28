import { X } from "lucide-react";
import type { ReactNode } from "react";
import type { ImageAttachment } from "./images";
import "./composer.css";

export interface AttachmentChipsProps {
	images: readonly ImageAttachment[];
	onRemove(id: number): void;
}

/** Thumbnails of the images that will go out with the next prompt. */
export function AttachmentChips({ images, onRemove }: AttachmentChipsProps): ReactNode {
	return (
		<ul className="cmp-chips" aria-label="images attached to this prompt">
			{images.map(image => (
				<li key={image.id} className="cmp-chip">
					<img className="cmp-chip-img" src={image.previewUrl} alt={image.name} />
					<span className="cmp-chip-name">{image.name}</span>
					<button
						type="button"
						className="cmp-chip-remove"
						onClick={() => onRemove(image.id)}
						aria-label={`remove ${image.name}`}
					>
						<X size={12} />
					</button>
				</li>
			))}
		</ul>
	);
}
