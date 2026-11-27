# Activity v1.2.0

- Match the refusal to its cause. A judged block points to a safe alternative, a review that judged nothing invites a retry, and a review Activity cannot run says the block repeats until it is configured. All three are shorter than before.
- Add opt-in `auto.judgeResponseFormat` so a Chat Completions chat judge can be asked to return its verdict in a constrained format. It is off by default and never changes what can authorize a call.
- Add optional personal `activity.local.json` overrides. Nested objects merge, while arrays and other values replace; project files are still ignored.
- Install and remove examples now name the package instead of one pinned version, and link to the releases page.

Set `auto.judgeResponseFormat` to `json_schema` for the exact `{"decision":"allow"|"block","reason":"..."}` object, or `json_object` for plain JSON. Only `openai-completions` receives the parameter. The OpenAI Responses APIs expect `text.format` rather than `response_format`, so they keep the plain request, as do the classifier backend and every other API. On an explicit format rejection, Activity drops the parameter for any remaining attempts within the existing retry budget. Activity always parses and checks the verdict itself.
