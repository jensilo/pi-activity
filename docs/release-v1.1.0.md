# Activity v1.1.0

- Add optional classifier judges to full and short review, and an opt-in cascade mode with a quick decision followed by context-aware review when needed.
- Remove the tool approval dialog. An unavailable review or a final block stops the call and returns a reason. Optional acclass installation consent is unchanged.
- Use provider timeouts and cancellable backoff for judge and summary requests. Add optional fallback models and retain context-limit recovery.

Full mode with the chat backend remains the default. To use cascade, set `auto.judgeMode` to `cascade` and `auto.judgeModel` to an exact registered classifier reference. Summaries default to the current chat model with `low` thinking.
