# Demo: "The 90-second bug fix, blindfolded"

**The pitch in one line:** a blindfolded developer, with the screen physically turned off, gets a bug report by text, finds and fixes the bug in their code, verifies the fix in a browser, and replies, faster than most sighted people would.

Why this demo and not "text a friend": messaging alone has been done and it's too simple. This shows the whole computer: OS window switching, a code editor, a browser, and messages, driven *step by step by the human*. That's the difference from a delegate-everything agent. It's also live, unscripted, and has a timer.

## Setup (before going on stage)

1. `npm run demo:site` (Tandem landing page at http://localhost:3000; "Join the beta" 404s because of a typo on `demo/acme-site/app.js:39`).
2. VS Code open on `demo/acme-site` with the bridge installed (`npm run bridge:install`, then reload). Close other VS Code windows.
3. Messages signed in on the demo laptop. Give a judge or teammate the demo phone number.
4. Projector shows the **Callbacks window** (mirror only that window, or put it on the external display). The audience sees the transcript, the numbered options, and the braille display filling in. The laptop's own screen gets the curtain.
5. `.env` has Anthropic + Cartesia (+ Gemini) keys. Speed set around 1.6× so the audience can follow; mention real users run 2-3×.

## Script (~2:00 total; the live flow is ~90s)

**0:00 Hook (presenter, 15s).** "2.2 million Americans are blind. The tools they use read the screen one element at a time, like reading a book through a straw. Callbacks lets you say where you want to go. [Teammate] is going to fix a production bug. Blindfolded. With the screen off."

Blindfold on. Say **"screen off"**. The laptop goes black and the projector keeps showing the Callbacks window. Start the timer on screen.

**0:15 The bug report arrives (live).** A judge texts: *"the join the beta button is broken"* (ask them to word it however they like; unscripted is the point).
- 🗣 **"unread messages"** → "One person. [Judge]: the join the beta button is broken. Say a number to hear a thread, or reply to a name."

**0:25 Reproduce it in the Lens.**
- 🗣 **"open localhost 3000"** → "Tandem. Regions, 4 items. 1, navigation…"
- 🗣 **"links"** → "Links, 6 items… 4, Join the beta…"
- 🗣 **"4"** → "Opened Join the beta. 404 Not Found." (The audience sees the yellow focus ring and the 404.)

**0:40 Find it in code: steps, not delegation.**
- ⌨ `o code` → "Visual Studio Code, app.js, line 1."
- 🗣 **"what links to signup in this file?"** (Claude: reads the file via the bridge) → "Line 39 sets the call-to-action link to slash s-i-n-g-u-p. That looks like a typo for signup."
- 🗣 **"go to line 39"** → "line 39: cta.href equals slash singup."

**0:55 Fix it.**
- 🗣 **"replace line 39 with cta dot href equals slash signup semicolon"** (Claude converts the spoken code and keeps the indentation) → "Line 39 replaced."
- 🗣 **"read line"** → "line 39: cta.href = '/signup';"
- 🗣 **"save"** → "Saved."

**1:10 Verify.**
- 🗣 **"open localhost 3000"**, then **"links"**, then **"4"** → "Opened Join the beta. Join the beta. Regions… form, 2 fields, 1 button."

**1:20 Reply and close the loop.**
- 🗣 **"reply fixed, try it now"** → "Sent to [Judge]: fixed, try it now."
- Stop the timer. 🗣 **"screen on"**. Take off the blindfold.

**1:30 The point (presenter, 30s).** "That was every part of a real workflow: messages, a browser, a code editor. All of it driven by a person who couldn't see, at the speed of thought. Notice Claude never took over. It read, it found, it typed what she said. Common commands are about a millisecond because they never touch an LLM. Claude handles everything else. Gemini looks when apps hide their UI from screen readers. Cartesia makes it talk back fast enough to keep up. Every word you heard also went out as braille."

## Backup moves if something breaks

- STT mishears: type the shortcode instead (`g 39`, `o code`, `u`). That *is* a feature: "you can always type."
- Wi-Fi dies: say **"performance mode"**. Commands and the demo site still work locally; `TTS_PROVIDER=say` keeps speech going offline.
- Messages fails: skip it and open with "a user reported the signup button is broken."

## Optional 20-second add-on: the VoiceOver comparison

Pre-record the same "find the Join the beta link and open it" task with VoiceOver (VO+U rotor, arrowing). Show it side by side, sped up 4×, with its time on screen.

## Before judging: talk to a real user

Anthropic's track asks for a named community and a real problem that "you have lived or talked to someone who has." Before demoing, reach out to a blind CS student or developer (Berkeley DSP, the NFB's blind programmers list, r/Blind) for 10 minutes. Get one quote about what's slow for them today, and put it on the first slide.
