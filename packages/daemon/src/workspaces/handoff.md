<handoff>
<title>{{escapeXml title}}</title>
{{#if goal}}<goal>{{escapeXml goal}}</goal>{{/if}}
<decisions>
{{#each decisions}}<decision>{{escapeXml this}}</decision>
{{/each}}</decisions>
<files>
{{#each files}}<file>{{escapeXml this}}</file>
{{/each}}</files>
{{#if outcome}}<outcome>{{escapeXml outcome}}</outcome>{{/if}}
<open-questions>
{{#each openQuestions}}<question>{{escapeXml this}}</question>
{{/each}}</open-questions>
</handoff>
