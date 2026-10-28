/**
 * Windowing math for a variable-height list. Framework-free so the anchoring rules are unit-tested.
 *
 * Coordinates are list-space pixels: item `i` starts at `offsetOf(i)`, the list's own top edge is 0.
 * Measured heights are cached by item key, so they survive prepends, appends and re-ordering of the
 * key list; unmeasured items count as `estimate` (the mean of what was measured, refreshed whenever
 * the key list changes or `reestimate` finds it stale).
 *
 * Internally a Fenwick tree holds `measured - estimate` per item, so a height update, a prefix sum
 * and a "which item contains y" lookup are all O(log n) and a 50k-item list never rescans.
 */

export interface WindowRange {
	/** First mounted item. */
	start: number;
	/** One past the last mounted item. */
	end: number;
}

/** A scroll position pinned to an item: where that item's top sits relative to the viewport top. */
export interface ScrollAnchor {
	key: string;
	/** `offsetOf(item) - scrollTop` when captured; negative while the item is partly above the viewport. */
	delta: number;
}

const CHANGE_EPSILON = 0.01;
/** Fewer measured items than this and the mean is too noisy to replace the estimate. */
const MIN_SAMPLES_TO_REESTIMATE = 8;
/** Relative drift of the mean from the estimate that justifies a rebuild. */
const REESTIMATE_DRIFT = 0.2;

export class VirtualModel {
	#keys: readonly string[] = [];
	#indexByKey = new Map<string, number>();
	readonly #measured = new Map<string, number>();
	#estimate: number;
	/** 1-based Fenwick tree over `measured - estimate`; unmeasured items contribute 0. */
	#tree = new Float64Array(1);
	#topBit = 0;

	constructor(initialEstimate: number) {
		this.#estimate = Math.max(1, initialEstimate);
	}

	get length(): number {
		return this.#keys.length;
	}

	get estimate(): number {
		return this.#estimate;
	}

	get totalHeight(): number {
		return this.offsetOf(this.#keys.length);
	}

	/** Replaces the key list. Heights of keys that remain are kept; the rest are forgotten. */
	setKeys(keys: readonly string[]): void {
		this.#keys = keys;
		const index = new Map<string, number>();
		for (let i = 0; i < keys.length; i++) index.set(keys[i]!, i);
		this.#indexByKey = index;
		for (const key of this.#measured.keys()) {
			if (!index.has(key)) this.#measured.delete(key);
		}
		this.#adoptMeanEstimate();
		this.#rebuild();
	}

	/**
	 * Adopts the measured mean as the estimate when it drifted by more than 20%. Returns true when
	 * offsets of unmeasured items changed, so callers must re-render and re-anchor.
	 */
	reestimate(): boolean {
		if (this.#measured.size < MIN_SAMPLES_TO_REESTIMATE) return false;
		const mean = this.#meanMeasured();
		if (Math.abs(mean - this.#estimate) / this.#estimate <= REESTIMATE_DRIFT) return false;
		this.#estimate = mean;
		this.#rebuild();
		return true;
	}

	/** Forgets every measurement (the container width changed, so every wrap point moved). */
	invalidate(): void {
		if (this.#measured.size === 0) return;
		this.#adoptMeanEstimate();
		this.#measured.clear();
		this.#rebuild();
	}

	indexOfKey(key: string): number {
		return this.#indexByKey.get(key) ?? -1;
	}

	heightOf(index: number): number {
		return this.#measured.get(this.#keys[index]!) ?? this.#estimate;
	}

	isMeasured(index: number): boolean {
		return this.#measured.has(this.#keys[index]!);
	}

	/** Records a measurement. Returns true when the height moved by more than a hundredth of a pixel. */
	setHeight(index: number, height: number): boolean {
		const key = this.#keys[index];
		if (key === undefined) return false;
		const previous = this.#measured.get(key);
		const before = previous ?? this.#estimate;
		if (previous !== undefined && Math.abs(previous - height) <= CHANGE_EPSILON) return false;
		this.#measured.set(key, height);
		const delta = height - before;
		for (let i = index + 1; i < this.#tree.length; i += i & -i) this.#tree[i]! += delta;
		return Math.abs(delta) > CHANGE_EPSILON;
	}

	/** Top edge of item `index` (`index === length` gives the total height). */
	offsetOf(index: number): number {
		let sum = 0;
		for (let i = Math.min(index, this.#keys.length); i > 0; i -= i & -i) sum += this.#tree[i]!;
		return this.#estimate * Math.min(Math.max(index, 0), this.#keys.length) + sum;
	}

	/** Index of the item containing `y`, clamped to the list. 0 for an empty list. */
	indexAt(y: number): number {
		const n = this.#keys.length;
		if (n === 0 || y <= 0) return 0;
		let pos = 0;
		let acc = 0;
		for (let step = this.#topBit; step > 0; step >>= 1) {
			const next = pos + step;
			if (next > n) continue;
			const acc2 = acc + this.#tree[next]!;
			if (this.#estimate * next + acc2 <= y) {
				pos = next;
				acc = acc2;
			}
		}
		return Math.min(pos, n - 1);
	}

	/** Items to mount for a viewport at `scrollTop`, widened by `overscan` pixels on both sides. */
	rangeFor(scrollTop: number, viewportHeight: number, overscan: number): WindowRange {
		const n = this.#keys.length;
		if (n === 0) return { start: 0, end: 0 };
		const start = this.indexAt(Math.max(0, scrollTop - overscan));
		const end = Math.min(n, this.indexAt(scrollTop + viewportHeight + overscan) + 1);
		return { start, end: Math.max(end, start + 1) };
	}

	/** Window for a viewport pinned to the bottom: always ends at the last item. */
	tailRange(viewportHeight: number, overscan: number): WindowRange {
		const n = this.#keys.length;
		if (n === 0) return { start: 0, end: 0 };
		return { start: this.indexAt(Math.max(0, this.totalHeight - viewportHeight - overscan)), end: n };
	}

	/** Pins the item under the viewport top. Null for an empty list. */
	captureAnchor(scrollTop: number): ScrollAnchor | null {
		if (this.#keys.length === 0) return null;
		const index = this.indexAt(scrollTop);
		return { key: this.#keys[index]!, delta: this.offsetOf(index) - scrollTop };
	}

	/** The scrollTop that puts the anchored item back where it was; null when the item is gone. */
	scrollTopForAnchor(anchor: ScrollAnchor): number | null {
		const index = this.#indexByKey.get(anchor.key);
		return index === undefined ? null : this.offsetOf(index) - anchor.delta;
	}

	#meanMeasured(): number {
		let sum = 0;
		for (const height of this.#measured.values()) sum += height;
		return sum / this.#measured.size;
	}

	#adoptMeanEstimate(): void {
		if (this.#measured.size > 0) this.#estimate = Math.max(1, this.#meanMeasured());
	}

	#rebuild(): void {
		const n = this.#keys.length;
		const tree = new Float64Array(n + 1);
		for (let i = 0; i < n; i++) {
			const height = this.#measured.get(this.#keys[i]!);
			if (height !== undefined) tree[i + 1]! += height - this.#estimate;
		}
		for (let i = 1; i <= n; i++) {
			const parent = i + (i & -i);
			if (parent <= n) tree[parent]! += tree[i]!;
		}
		this.#tree = tree;
		this.#topBit = n === 0 ? 0 : 2 ** Math.floor(Math.log2(n));
	}
}
