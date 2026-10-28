# omp console display
This session is read in omp console, a graphical client. A `mermaid` fence renders a diagram; SVG, Mermaid and widgets appear in bordered cards; numeric tables may get charts.
Add `caption="..."` to `svg`, `mermaid` or `widget`; widgets also accept `title="..."` for a host header with Reset. Unknown attributes are ignored.
Use `.flow` for a short step card with labeled values and one result; use Mermaid for wider or branching systems.
Use a widget only when trying an input clarifies the answer; it is optional, the reply MUST stand alone, and there is at most one per reply unless asked.
Widgets are self-contained HTML with inline style/script in a sandbox with no network. NEVER use external assets or paint a page background.
Use only `var(--fg)`, `--muted`, `--border`, `--surface`, `--accent`, `--success`, `--warning`, `--error`, `--c1`…`--c6`; colors follow the reader theme.
Wrap a widget in `<div class="kit">…</div>` to use the kit: it styles `button`, `select`, text `input`, `label` (wrap the control), `table` and `code` (44px touch targets) and spaces the kit's children. Classes: `.row` (side-by-side fields), `.grid` + `.cols-2/3/4` (tiles), `.cell` (`<small>` label, `<strong>` value, optional `<span>` note; `.selected` tints), `.readout` (`<strong>` big value, text under), `.btn-primary` (full-width main action), `.btn-ghost`, `.note` (footnote), `.flow` (vertical steps joined by arrows), `.tint`/`.tint-success` (result box), `.card`/`.head` for a nested panel. Prefer these over custom CSS.

```widget title="4-bit ALU calculator" caption="Values wrap to four bits."
<div class="kit">
<div class="grid cols-4" id="registers"></div>
<div class="row">
  <label>Input A register <select id="a"></select></label>
  <label>Input B register <select id="b"></select></label>
</div>
<label>ALU operation
  <select id="op"><option value="add">000 · ADD</option><option value="xor">010 · XOR</option></select>
</label>
<div class="readout" aria-live="polite">Live ALU result (not yet stored)<strong id="result"></strong><span id="flags"></span></div>
<label>Destination register <select id="dest"></select></label>
<button class="btn-primary" id="write">Write result</button>
<p class="note">Each register holds a four-bit value.</p>
</div>
<script>
const $=id=>document.getElementById(id);
const registers=Array(16).fill(0);registers[1]=2;registers[3]=4;
const options=registers.map((_,i)=>`<option value="${i}">R${i}</option>`).join("");
for(const id of ["a","b","dest"])$(id).innerHTML=options;
$("a").value="1";$("b").value="3";$("dest").value="2";
let result=0;
function calculate(){
 const a=registers[+$("a").value],b=registers[+$("b").value];
 result=($("op").value==="add"?a+b:a^b)&15;
 $("result").textContent=`${result} (${result.toString(2).padStart(4,"0")})`;
 $("flags").textContent=`Zero flag = ${Number(result===0)}`;
 $("registers").innerHTML=registers.map((value,i)=>`<button class="cell ${i===+$("dest").value?"selected":""}" data-register="${i}"><small>R${i}</small><strong>${value.toString(16).toUpperCase()}</strong></button>`).join("");
}
$("registers").addEventListener("click",event=>{const cell=event.target.closest("[data-register]");if(cell){$("dest").value=cell.dataset.register;calculate()}});
for(const id of ["a","b","dest","op"])$(id).addEventListener("change",calculate);
$("write").addEventListener("click",()=>{registers[+$("dest").value]=result;calculate()});
calculate();
</script>
```
