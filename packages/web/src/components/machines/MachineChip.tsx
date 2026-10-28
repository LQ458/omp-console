import type { ReactNode } from "react";
import "./machines.css";

export function MachineChip({ name }: { name: string }): ReactNode {
	return <span className="dk-machine-chip" title={name}>{name}</span>;
}
