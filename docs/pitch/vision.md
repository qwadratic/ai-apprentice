# Product vision: from apprentice to agent maker

This is the moonshot slide and the last line of both videos.

## The idea

Clipa learns a person's judgment the way an apprentice does: by watching the work, asking why at the right moment and having the expert confirm what she understood. The result is a **confirmed Work Map**:
- the steps, each tied to the screen moment it happened in;
- the rules, each with its limits and exceptions in the expert's own words;
- the processes those steps and rules belong to.

A map like that is exactly what an AI agent lacks today. Agents can click and type, but they do not know *why* a team does things its own way: the customer with a signed Net 30, the prepaid licence spread over four quarters, the venue rejected because the meeting needs a private room.

So the long-term product is this: **Clipa turns an expert's confirmed judgment into agents that work the expert's way, and keeps them honest by asking the expert only about what changed.**

## The path, step by step

| Stage | What Clipa does | Status today (4 Oct) |
| --- | --- | --- |
| 1. Apprentice | Watches any app, asks why at pauses, builds and confirms the Work Map by voice | Live: Show and Reflect on the web and on macOS |
| 2. Tutor | Coaches a new hire on a new case, warns before a rule is broken, explains with the expert's words | Live: Pass it on |
| 3. Memory | Recognises a learned process on screen, asks only about what is different, and keeps a library of processes | First version live: process library and recognition. Maps are kept on disk and survive a restart |
| 4. Agent maker | Exports a confirmed process as agent instructions (steps, rules, stop-and-ask points) and serves the guardrails over MCP, so any agent can check "would the expert stop here?" before it acts | Next: the brief's own stretch goal ("export the Work Map as instructions an agent can follow") and TASK-3.58 (the brain as an MCP server) |
| 5. Supervisor | Watches the agents work the way she watched the expert, and brings a person in only when something new happens | Moonshot |

## Why this order is honest

- Every agent instruction comes from a map the expert confirmed by voice, with evidence for each line. Nothing is written afterwards from a recording nobody watched.
- People come first: the expert teaches, a new hire learns, and only then does an agent get the same rules.
- The guardrails stay checkable. An agent asks the same `guardrail_check` the tutor uses today, against the same confirmed rules.

## One line for the slide

**Clipa learns how your best people decide, teaches it to the next person, and turns it into agents that ask before they break your rules.**
