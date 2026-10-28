const settings = document.querySelector('button[aria-label="global settings"]');
if (!settings) { problems.push("no global settings button"); return problems; }
settings.click();
await sleep(1200);
await clickText(".pf-item", "reviewer", 100);
const item = [...document.querySelectorAll(".pf-item")].find(n => n.textContent.includes("Reviews a finished change"));
const btn = item && [...item.querySelectorAll(".pf-btn")].find(b => b.textContent.trim() === "Details");
if (!btn) { problems.push("no Details button"); return problems; }
btn.click();
await sleep(1200);
if (!document.querySelector(".pd-detail .pd-facts")) problems.push("no detail facts");
item.scrollIntoView({ block: "start" });
await sleep(300);
