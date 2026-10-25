# Research behind nyxOS

Four papers on non-visual and voice-driven computer use, what each found, and what nyxOS does because of it. Each feature is built and tested. Where nyxOS approximates a paper's method instead of reproducing it, the section says so.

| Paper | Venue | What nyxOS took from it |
|---|---|---|
| [SaIL: Saliency-Driven Injection of ARIA Landmarks](#1-sail-saliency-driven-injection-of-aria-landmarks) | IUI 2020 | Regions and items ranked by visual prominence; the first glance leads with what a sighted eye notices first |
| [Screen Recognition: Creating Accessibility Metadata for Mobile Applications from Pixels](#2-screen-recognition-creating-accessibility-metadata-from-pixels) | CHI 2021 (Best Paper) | Clickable elements found from a screenshot when a page has no usable HTML (canvas games, unlabeled icons) |
| ["Siri Talks at You": VAPA Usage by Individuals Who Are Blind](#3-siri-talks-at-you) | ASSETS 2018 | User-controlled verbosity, a discreet mode that never says names or message text, and fixing a message before it's sent instead of re-dictating it |
| [Accessible Skimming: Faster Screen Reading of Web Pages](#4-accessible-skimming) | UIST 2012 | A "skim" command that reads an article's key sentences in order, instantly and on-device |

---

## 1. SaIL: Saliency-Driven Injection of ARIA Landmarks

**Citation:** Ali Selman Aydin, Shirin Feiz, Vikas Ashok, and I. V. Ramakrishnan. 2020. *SaIL: Saliency-Driven Injection of ARIA Landmarks.* In Proceedings of the 25th International Conference on Intelligent User Interfaces (IUI '20), 111–115. ([NSF PAR record](https://par.nsf.gov/biblio/10186666), [ODU repository](https://digitalcommons.odu.edu/computerscience_fac_pubs/183))

**Problem.** ARIA landmarks let screen-reader users jump between the sections of a page, but developers use them inconsistently, and many pages have none.

**Idea.** SaIL predicts which regions a sighted person would look at, using a deep model trained on eye-tracking data from sighted users. It then injects landmarks for those regions, so a screen-reader user can jump straight to them. A pilot study showed it could reduce the time and effort needed to navigate.

**In nyxOS** (`src/renderer/lens/extract.ts`, `src/main/executor.ts`)
- **Salience score:** every region, and the first 400 items on a page, gets a salience score from 0 to 1. The score uses:
  - visible area within the first one and a half screens
  - how close it sits to the top
  - horizontal centering
  - font size
  - whether it contains a picture
  - a penalty for navigation, headers and footers
- **Region order:** the region list is spoken most prominent first, not in source order.
- **First glance:** Claude receives a "most visually prominent" list ahead of the rest of the page and is told to lead with it.
- **Honest difference:** SaIL learns salience from real gaze data. nyxOS approximates it from layout signals in the page itself, with no extra model and no added latency. Swapping in a learned saliency model would only change the scoring function.

## 2. Screen Recognition: Creating Accessibility Metadata from Pixels

**Citation:** Xiaoyi Zhang, Lilian de Greef, Amanda Swearngin, Samuel White, Kyle Murray, Lisa Yu, Qi Shan, Jeffrey Nichols, Jason Wu, Chris Fleizach, Aaron Everitt, and Jeffrey P. Bigham. 2021. *Screen Recognition: Creating Accessibility Metadata for Mobile Applications from Pixels.* In Proceedings of CHI '21. DOI [10.1145/3411764.3445186](https://doi.org/10.1145/3411764.3445186). ([arXiv:2101.04893](https://arxiv.org/abs/2101.04893))

**Problem.** Many apps don't provide the accessibility metadata screen readers depend on, so their controls are invisible or unlabeled to VoiceOver.

**Idea.**
- Detect UI elements directly from screen pixels, using an on-device model trained on 77,637 screens from 4,068 iPhone apps.
- Add heuristics for grouping and ordering, plus models for content, state and interactivity.
- Feed the result to VoiceOver as generated metadata.
- In a study with 9 screen-reader users, it made existing apps more accessible, including some that had been unusable.

**In nyxOS** (`detectElements` in `src/main/claude.ts`; `detectOnScreen` in `src/main/executor.ts`)
- **"What can I click?" / "find the buttons":** nyxOS takes a screenshot of the Lens page and asks Claude (Haiku, with a structured JSON schema) for the interactive elements. Each comes back with a human name, a kind, and its center point.
- **Clickable options:** each detected element becomes a normal option. Say its name or number and nyxOS clicks that point on the page.
- **Automatic on drawn pages:** when a page is mostly a canvas (games), nyxOS looks at the screen while it prepares the first glance, and adds "On screen: …" to it.
- **Honest difference:** the paper uses a purpose-built, on-device detector. nyxOS uses a general vision-language model in the cloud, which takes about 3–5 seconds and needs no training data. The pipeline is the same: pixels in, accessibility metadata out, then used for navigation.

Example: on Cookie Clicker, "what can I click" → "On screen, by looking: big cookie, options, stats, info, legacy, and 16 more."

## 3. "Siri Talks at You"

**Citation:** Ali Abdolrahmani, Ravi Kuber, and Stacy M. Branham. 2018. *"Siri Talks at You": An Empirical Investigation of Voice-Activated Personal Assistant (VAPA) Usage by Individuals Who Are Blind.* In Proceedings of ASSETS '18, 249–258. DOI [10.1145/3234695.3236344](https://doi.org/10.1145/3234695.3236344).

**Study.** Semi-structured interviews with 14 legally blind adults who used home or mobile voice assistants daily or weekly. Findings nyxOS acts on:
- **Too much or too little.** Six participants found feedback too verbose or irrelevant, or too thin to be useful, and couldn't customize how much was said.
- **Privacy.** One participant whispered a contact's name at work, and Siri announced it aloud to the office. She wanted to be able to turn off that kind of feedback, for example a plain "OK" instead of the full name.
- **Fixing mistakes.** Correcting an error in a long dictated message meant re-dictating the whole message.
- **Results lists instead of answers.** Participants were frustrated when a complex query produced a list of search results they then had to sort through themselves.
- **Speed and conversation.** Participants wanted control over speech rate, follow-up questions that keep context, and an assistant that talks *with* them, not *at* them.

**In nyxOS**
- **Verbosity levels:**
  - "be brief" gives replies under about 8 words and 3 options per list.
  - "normal mode" is the default: under about 12 words and 5 options.
  - "detailed mode" allows up to 3 sentences and 8 options.
  - The level applies everywhere: Claude's replies, page first glances, skimming, and how many options are read out.
- **Discreet mode** ("discreet mode on"): nyxOS never says contact names, phone numbers or message text aloud. A draft is confirmed with "Message ready. Say yes to send", and "Sent." follows. The text stays on screen and on the braille line.
- **Fix a message instead of re-dictating it.** While a message waits for "yes", you can edit it by voice, and it's read back:
  - "change 6 to 7"
  - "add bring snacks"
  - "remove the word maybe"
  - "make it see you tomorrow"
  - "read it back"
- **Already in nyxOS, and backed by the paper:**
  - Questions get answers, not results lists.
  - Speech rate is adjustable ("faster" / "slower", default 1.6×).
  - Follow-ups use the context of what was just said.
  - Push-to-talk instead of a wake word, so nothing activates by accident.
  - Every message is read back before sending.

## 4. Accessible Skimming

**Citation:** Faisal Ahmed, Yevgen Borodin, Andrii Soviak, Muhammad Asiful Islam, I. V. Ramakrishnan, and Terri Hedgpeth. 2012. *Accessible Skimming: Faster Screen Reading of Web Pages.* In Proceedings of the 25th ACM Symposium on User Interface Software and Technology (UIST '12), 367–378. DOI [10.1145/2380116.2380164](https://doi.org/10.1145/2380116.2380164).

**Problem.** Sighted readers skim: their eyes jump to the sentences that carry a page. Screen-reader users hear content in order, with no cue about what they can skip.

**Idea.** Automatic summarization supports non-visual skimming of web pages. In a study with 23 screen-reader users, participants read and searched articles faster while understanding and remembering most of what they read.

**In nyxOS** (`src/core/skim.ts`, shared with the iOS app)
- **"Skim" / "skim this page" / "give me the gist":** nyxOS reads the article's key sentences in their original order, in about 0.1 seconds, without calling a model.
- **How it picks sentences:**
  - **Frequency:** content words the article keeps returning to.
  - **Position:** lead sentences of paragraphs, and especially the opening.
  - **Length:** a penalty for very long and very short sentences.
- **What it skims:** only the article's real paragraphs (no infobox coordinates, menus or captions).
- **How much it keeps:** about one sentence in seven at normal verbosity, less when brief, more when detailed.
- **After a skim,** "read article" or "next" reads the full text paragraph by paragraph.
- **Honest difference:** the paper evaluated its own summarizer and called it only moderately successful, a viable starting point. nyxOS uses a lightweight extractive scorer in the same spirit, chosen for speed and offline use. A question like "what is this about?" still goes to Claude, for an abstractive answer.

---

## Where these meet

A typical page in nyxOS uses three of the four ideas at once:
1. The first glance leads with the most prominent content (SaIL).
2. "Skim" gives the gist before you commit to the whole article (Accessible Skimming).
3. If the page draws its controls instead of using HTML, nyxOS looks at the screen to find them (Screen Recognition).

How much of each is spoken, and whether names are said aloud, is yours to set ("Siri Talks at You").
