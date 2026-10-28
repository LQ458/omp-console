// Knowledge workspace (teal) with plan + vibe badges and the project-drift card polled for this session.
await open("Job: notes triage");
await sleep(4500);
expectThat(document.querySelector('.ws-badge[data-badge="vibe"]'), "no vibe badge");
expectThat(document.querySelector(".sf-drift"), "no drift card");
expectThat(document.querySelector(".sf-agent-label"), "agent text is not labelled");
return problems;
