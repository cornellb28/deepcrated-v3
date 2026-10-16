---
name: "deepcrated-pain-point-library"
description: Maintain and use the DeepCrated Pain Point Library, the single source of truth that links every DeepCrated feature to the DJ problem it solves, the hidden pain, emotional trigger, consequence, desired outcome, marketing angle, hook, ad and CTA, plus the evidence behind each. Use this skill whenever the user asks for DeepCrated marketing of any kind (ads, hooks, TikTok/Reels scripts, landing page copy, App Store copy, emails, launch announcements, content calendars, personas, A/B tests), whenever a new DeepCrated feature ships or is being designed and needs positioning, whenever someone asks "what pain does this feature solve" or "what should we say about X", and whenever customer research or ad results need to be logged against a feature. Trigger even if the user never says "pain point library" or "skill".
---

# DeepCrated Pain Point Library

This skill keeps one living document, the Pain Point Library, that every piece of DeepCrated marketing is built from. The point of a single source of truth is consistency: if an ad, a landing page and an email all come from the same library entry, they tell the same story and make only claims the product and the evidence can support.

DeepCrated is the archive, organization system, preparation environment and intelligence layer for a DJ's music collection. It is not another DJ playback app and it is not a streaming service. The larger idea behind every entry: **DJs aren't just playing music, they're building a music collection**, and DeepCrated preserves and activates that collection.

## The chain every entry follows

```
Feature → DJ problem → hidden pain → emotional trigger → consequence
→ desired outcome → marketing angle → hook → ad → CTA → evidence
```

Marketing starts from the DJ's problem, never from the feature. A DJ doesn't fall in love with a feature; they recognize themselves in a problem. The test for any piece of copy is whether a DJ reads it and thinks "that's me, I have that exact problem."

## Where the library lives

The canonical library is a markdown file the user keeps, `deepcrated-pain-point-library.md`, in their working folder or repo. This skill bundles a starter copy at `references/seed-library.md`.

- If `deepcrated-pain-point-library.md` already exists in the working folder, read it and treat it as the truth. Never replace it with the seed.
- If it doesn't exist, copy the seed into the working folder under that name before doing anything else, then work from the copy.
- Edit entries in place and keep prior hooks and ads that were tested, marked with their results, rather than deleting them. Test history is part of the value.

Read `references/entry-template.md` for the exact fields and what a strong answer looks like in each one. Read `references/audiences-and-territories.md` when choosing audiences, emotional territories or angles.

## Workflows

Pick the one that matches the request. Several can chain (for example, add an entry, then generate ads from it).

### 1. Add or revise an entry for a feature

Use when a feature is new, changed, or has no entry yet.

1. Establish what the feature actually does today and its status (shipped, in build, designed, idea). Ask the user if unclear. Copy must never promise what the product doesn't do yet.
2. Pick the audience segment(s) it matters most to. Different DJs feel different pain, so one entry can carry segment-specific variants of the problem and hook.
3. Work through the chain in order, writing each field in the template. The early fields (problem, hidden pain, consequence) are where most weak entries fail, so spend time there. Be specific: "you've spent 15 years building your library but still search three drives and two DJ programs for a track you know you own" beats "managing music is hard."
4. Assign evidence honestly (see Evidence rules) and list the research that would upgrade it.
5. Add the entry to the library file and show the user the finished entry.

### 2. Generate marketing from the library

Use when the user wants ads, hooks, scripts, copy, emails and similar.

1. Find the entry (or entries) in the library. If none covers the request, run workflow 1 first so the copy has a foundation.
2. State the audience, pain and angle you are using in a line or two, so the user can redirect early.
3. Write the requested format. Produce variations across different emotional angles (time, money, fear, frustration, confidence, discovery, identity, legacy, convenience), then say which angle you expect to resonate most and why.
4. Give 2 to 5 variations framed as an A/B test, with what is being tested and what result would count as a win.
5. Check every claim in the copy against the entry's status and evidence. Remove or soften anything that isn't supported.
6. If the new hooks or ads are worth keeping, add them to the entry marked "untested".

### 3. Log evidence or results

Use when the user brings customer interviews, survey answers, support tickets, ad performance, or quotes.

1. Match each finding to the entry it speaks to (or note that it suggests a new entry).
2. Record it in the Evidence field with source, date and sample size where known. Quote customers only with exact wording they gave.
3. Re-grade the evidence level if warranted, and note when a hook or ad has won or lost a test.
4. Flag when evidence contradicts an entry, and suggest revising the problem, angle or hook rather than defending the original.

### 4. Audit the library

Use when asked what's missing, what's strongest, or what to research next.

Report: features with no entry, entries still at Hypothesis level, audiences with thin coverage, emotional territories nobody is using, and the three research questions that would most upgrade the library. Keep it short and ranked.

## Evidence rules

The library is only a source of truth if it separates what is known from what is hoped. Every entry carries one of these evidence levels, and the copy built on it must respect that level:

- **Verified**: observed or measured (interviews, survey data, support logs, product analytics, ad results). Cite the source.
- **Likely**: strongly consistent with known DJ behavior but not yet measured for DeepCrate's audience.
- **Hypothesis**: a reasoned guess about the pain. Fine to test in ads, not fine to state as fact in copy ("DJs lose hours every week" needs backing).
- **Needs research**: unknown; write the question to ask.

Never invent statistics, testimonials, user counts, or "studies show" claims. If an ad would be stronger with proof the library doesn't have, say so and write the research or product-proof task needed to get it (a screenshot of a library health report, a real before/after, a customer quote with permission). Proof can be product-demonstrated (showing the feature working) as well as customer-supplied.

## Positioning guardrails

These come from how DeepCrate wants to show up in the market:

- **Competitors**: don't attack Serato, Rekordbox, Traktor or others without evidence. Name the gap instead: DJ software helps you play music; DeepCrate helps you understand, organize, protect and preserve the collection behind the performance.
- **Mobile**: not "manage your music from your phone." The idea is that the library shouldn't be trapped behind one computer. Never imply streaming; the collection stays the DJ's own.
- **AI**: position as a music librarian or archivist that understands your collection, not a robot DJ and not generic "AI-powered" copy. Only describe AI capabilities that exist or are clearly labeled as planned.
- **Destructive actions**: where a feature removes data (for example removing a track from the cloud), the copy should build trust through clarity about what is and isn't deleted, never make it sound casual.
- **Local-first and ownership**: the DJ's files and organizational work are theirs. Lean on control and preservation, not lock-in.

## Output style

Lead with the DJ's problem in the DJ's own language. Be concrete, specific and a little blunt, the way a working DJ talks. Avoid feature lists in hooks, avoid "revolutionary" and "game-changing," and avoid generic pain. When presenting an entry, use the template layout exactly so entries stay scannable and comparable. Keep any commentary to what the user needs to decide.
