export const WIDGET_KIT_CSS = String.raw`
:where(.kit){display:grid;gap:14px;color:var(--fg);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
:where(.kit) *,:where(.kit) *::before,:where(.kit) *::after{box-sizing:border-box}
:where(.kit) button,:where(.kit) select,:where(.kit) input:where(:not([type=checkbox],[type=radio],[type=range],[type=color],[type=file])){max-width:100%;height:44px;min-height:44px;padding:0 14px;border:1px solid var(--border);border-radius:12px;background:var(--surface);color:var(--fg);font:inherit;font-size:.95rem}
:where(.kit) select,:where(.kit) input:where(:not([type=checkbox],[type=radio],[type=range],[type=color],[type=file])){width:100%}
:where(.kit) select{appearance:none;-webkit-appearance:none;padding-right:36px;background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);background-position:calc(100% - 20px) 50%,calc(100% - 15px) 50%;background-size:5px 5px;background-repeat:no-repeat}
:where(.kit) button{display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;touch-action:manipulation;transition:background-color var(--dur-fast,120ms) var(--ease-out,ease-out),border-color var(--dur-fast,120ms) var(--ease-out,ease-out),transform var(--dur-fast,120ms) var(--ease-out,ease-out)}
:where(.kit) button:hover{background:color-mix(in srgb,var(--fg) 5%,var(--surface))}
:where(.kit) select:hover,:where(.kit) input:where(:not([type=checkbox],[type=radio],[type=range],[type=color],[type=file])):hover{border-color:color-mix(in srgb,var(--fg) 30%,var(--border))}
:where(.kit) button:active{transform:translateY(1px)}
:where(.kit) button:disabled{opacity:.45;cursor:default}
:where(.kit) button:focus-visible,:where(.kit) select:focus-visible,:where(.kit) input:where(:not([type=checkbox],[type=radio],[type=range],[type=color],[type=file])):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
:where(.kit) label{display:grid;gap:6px;color:var(--fg);font-size:.9rem;font-weight:500}
:where(.kit) table{width:100%;border-collapse:collapse;color:var(--fg);font-size:.92rem}
:where(.kit) th,:where(.kit) td{padding:8px 10px;border-bottom:1px solid var(--border);text-align:left}
:where(.kit) th{color:var(--muted);font-size:.82em;font-weight:600}
:where(.kit) h1,:where(.kit) h2,:where(.kit) h3{margin:0;font-size:1.05rem;font-weight:650}
:where(.kit) .card{display:grid;gap:16px;width:100%;padding:16px;border:1px solid var(--border);border-radius:14px;color:var(--fg)}
:where(.kit)>.card:only-child{padding:0;border:0}
:where(.kit) .stack{display:grid;gap:12px}
:where(.kit) .row{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr));gap:12px}
:where(.kit) .head{display:flex;align-items:center;justify-content:space-between;gap:12px}
:where(.kit) .head>:first-child{font-size:1.05rem;font-weight:650}
:where(.kit) .head button{height:32px;min-height:32px;padding:0 12px;border-radius:999px;font-size:.88rem}
:where(.kit) .btn-primary{width:100%;border-color:var(--fg);background:var(--fg);color:var(--surface);font-weight:600}
:where(.kit) .btn-primary:hover{background:color-mix(in srgb,var(--fg) 85%,var(--surface))}
:where(.kit) .btn-ghost{border-color:transparent;background:transparent;color:var(--muted)}
:where(.kit) .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,5.5rem),1fr));gap:4px}
:where(.kit) .cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}:where(.kit) .cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}:where(.kit) .cols-4{grid-template-columns:repeat(4,minmax(0,1fr))}
:where(.kit) .cell{display:flex;min-width:0;height:auto;min-height:64px;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:8px;border:0;border-radius:10px;background:transparent;text-align:center}
:where(.kit) button.cell:hover{background:color-mix(in srgb,var(--fg) 5%,transparent)}
:where(.kit) .cell small{display:block;color:var(--muted);font-size:.72rem;font-weight:500;letter-spacing:.02em}
:where(.kit) .cell strong{display:block;color:var(--fg);font-size:1.3rem;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums}
:where(.kit) .cell span{display:block;color:var(--muted);font-size:.82rem}
:where(.kit) .cell.selected{background:color-mix(in srgb,var(--accent) 14%,transparent)}
:where(.kit) .readout{display:grid;justify-items:center;gap:4px;padding:6px;text-align:center;color:var(--muted);font-size:.85rem}
:where(.kit) .readout strong{color:var(--fg);font-size:1.8rem;font-weight:650;line-height:1.15;font-variant-numeric:tabular-nums}
:where(.kit) .readout strong small{color:var(--muted);font-size:.55em;font-weight:500}
:where(.kit) .note{color:var(--muted);font-size:.85rem;line-height:1.5}
:where(.kit) .flow{display:grid;justify-items:center;gap:28px;text-align:center}
:where(.kit) .flow>*{width:100%}
:where(.kit) .flow>*+*{position:relative}
:where(.kit) .flow>*+*::before{position:absolute;top:-24px;inset-inline:0;display:block;height:18px;color:var(--muted);content:"↓";line-height:18px;text-align:center}
:where(.kit) .tint,:where(.kit) .tint-success{display:block;padding:14px;line-height:1.5;border:1px solid color-mix(in srgb,var(--accent) 30%,var(--border));border-radius:12px;background:color-mix(in srgb,var(--accent) 8%,transparent);text-align:center}
:where(.kit) .tint>*+*,:where(.kit) .tint-success>*+*{margin-top:4px}
:where(.kit) .tint-success{border-color:color-mix(in srgb,var(--success) 40%,var(--border));background:color-mix(in srgb,var(--success) 10%,transparent)}
:where(.kit) code{padding:1px 5px;border-radius:6px;background:color-mix(in srgb,var(--fg) 7%,transparent);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em}
@media(max-width:420px){:where(.kit) .card{gap:12px;padding:12px}:where(.kit) .grid:not(.cols-2):not(.cols-3){grid-template-columns:repeat(4,minmax(0,1fr))}:where(.kit) .cell{min-height:54px;padding:6px}:where(.kit) .cell strong{font-size:1.1rem}}
@media(prefers-reduced-motion:reduce){:where(.kit) *,:where(.kit) *::before,:where(.kit) *::after{animation-duration:0ms!important;animation-delay:0ms!important;transition-duration:0ms!important;transition-delay:0ms!important;scroll-behavior:auto!important}:where(.kit) button:active{transform:none}}
`;

export const WIDGET_THEME_BRIDGE = `addEventListener("message",event=>{
if(event.source!==parent||!event.data||typeof event.data!=="object")return;
const update=event.data.deckWidgetTheme;
if(!update||typeof update!=="object"||!update.palette||typeof update.palette!=="object")return;
const root=document.documentElement.style;
for(const [token,value] of Object.entries(update.palette)){
if(!/^(?:fg|muted|border|surface|accent|success|warning|error|c[1-6])$/.test(token)||typeof value!=="string")continue;
root.setProperty("--"+token,value);
}
root.colorScheme=update.dark===true?"dark":"light";
if(update.motion&&typeof update.motion==="object"){
for(const [token,value] of Object.entries(update.motion)){
if(!/^(?:dur-fast|dur-base|dur-slow|ease-out|ease-in-out|ease-spring)$/.test(token)||typeof value!=="string")continue;
root.setProperty("--"+token,value);
}
}
});`;
