# CL-23 · List · when a session says NEEDS ANSWER
Priority: P2 · Verified by: dry test `test/needsAnswer.test.js` + manual

## Goal
A session that has asked something and is waiting says so on its row — not
only a background job that reports itself blocked, but an ordinary
interactive session too, which the registry can only ever describe as
"idle". **Whether anybody is running it does not come into it**: quitting
the app kills every terminal, and the question in the transcript is no less
unanswered afterwards.

## Preconditions
- One session sitting at a question it asked ("Which one do you want?").
- One session sitting at a permission prompt it is holding.
- One session that simply finished and said so.
- One session that is busy right now.
- One session that asked a question, whose process is **gone** (the app was
  restarted, or the terminal was closed).
- One conversation older than three days that ends with a question.

## Steps
1. Read the four rows.
2. Answer the question in the first session and read its row again.
3. Fold the group they are in shut (CL-06) and read the header.
4. Open the Agents tab, if any of them was started as an agent.
5. Quit the app and start it again, then read the rows once more.

## Expected state
- The session that asked a question and the one holding a permission prompt
  both carry the **needs answer** badge — the same badge a blocked job has
  always had.
- The session that only reported what it did carries nothing, and the busy
  one carries nothing either, whatever its last message said.
- The session whose process is gone carries the badge all the same, and
  still carries it after step 5 — a restart does not clear it.
- The conversation older than three days carries nothing, whatever it ends
  with: it is history, not a pending question.
- After the question is answered, the badge goes at the next poll.
- The folded group's header carries the badge as well, and so does the
  session's row under its agent in the Agents tab: all three read the same
  flag.

## Evidence
- `test/needsAnswer.test.js`, against fixture tails:
  - "a question at the end of the last message needs an answer" and "a
    question mark inside closing punctuation still counts".
  - "a needs input: line needs an answer wherever it sits" and "needs input
    near the end of the message counts too" (and not far above it).
  - "an explicit ask needs an answer, in either language".
  - "a tool call nobody answered is a pending permission prompt" — and "a
    tool call that came back is not".
  - "a plain statement does not need an answer".
  - "a busy session never needs an answer, whatever it last said" and "the
    tail decides on its own, with no process anywhere in it".
  - "a transcript touched moments ago is asked the question", "a transcript
    older than three days is never flagged", "a missing or nonsensical
    modification time is not recent" and "a time in the future (a clock
    that jumped) still counts as recent".
  - "the last assistant turn is the one that counts, not an earlier
    question".
  - "a tail that starts mid-line is read from the first whole line" — the
    transcript is read from the end, so the first line is usually cut.
  - "the answer is worked out once per transcript state" and "a busy
    session is answered without reading anything" — the cache.
- Manual, with screenshots: the badge on a real session that asked a
  question, and on one whose process is gone (`needs-answer-dead.png`).

## Out of scope
- The Running / Waiting colors themselves: CL-01.
- Blocked background jobs, which said so already: CL-01.

## What the dry tests do not prove
- That reading the tail of every listed transcript is quick enough not to
  be felt on a list of sixty rows, and that the badge appears within one poll of the
  question being asked: manual.
