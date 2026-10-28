Write a compact session card using the conversation excerpt provided as data.

Return exactly one JSON object with these fields:
- `title`: a concise, useful title on one line.
- `stoppedAt`: one short line describing the latest point reached.
- `nextStep`: one short line describing the next action, or an empty string when there is no clear next action.

Write in the language the user's own messages use (not tool output or quoted text); when that is unclear, use English. Do not invent progress or plans that are not supported by the messages. Return valid JSON only, without Markdown fences or commentary.
