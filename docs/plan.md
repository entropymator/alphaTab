# AlphaTab Drum Kit Highlighter — Development Plan

## 1. Project Goal

Build a portable AlphaTab-based application that can load a drum score, display the score, show the parts of the drum kit below the score, and highlight the kit parts being hit in real time during playback.

This project is independent from the existing MuseScore plugin/fork. Do not depend on MuseScore internals or MuseScore plugin APIs.

The target is a web-first implementation that can run on desktop browsers and iPad. The preferred long-term packaging format is a Progressive Web App (PWA), not a native app.

---

## 2. Core First Version

The first usable version should do the following:

1. Load a score file supported by AlphaTab.
2. Render the score using AlphaTab.
3. Enable playback using AlphaTab.
4. Detect drum/percussion tracks.
5. Scan the full score before playback to discover all drum kit parts used by the score.
6. Dynamically render a drum kit UI containing all required parts.
7. During playback, detect the currently active beat or notes.
8. Map those notes to drum kit parts.
9. Highlight the corresponding parts in the drum kit UI in real time.

Supported file formats for the first version should preferably be those natively handled by AlphaTab, especially Guitar Pro files and MusicXML.

Do not support `.mscz` in the first version.

---

## 3. Main Design Constraint

A score may reference drum kit parts that are not present in a default kit.

Therefore, do not hard-code a fixed drum kit such as:

```text
kick, snare, hi-hat, crash, ride, tom1, tom2, floor tom
```

Instead, when a score is loaded:

```text
load score
scan all drum/percussion notes
map notes to canonical drum parts
build the list of required kit parts
create the visual kit dynamically
then start playback/highlighting
```

The score is the source of truth. The visual drum kit must adapt to the score.

---

## 4. Recommended Technology Stack

Use a browser-based TypeScript application.

Recommended stack:

```text
TypeScript
Vite
AlphaTab
SVG or HTML/CSS for drum kit rendering
PWA support later
```

Avoid framework complexity in the first version unless needed. A plain TypeScript + Vite prototype is preferred.

If a UI framework is introduced later, React or Vue are acceptable, but the core AlphaTab/drum-mapping logic should remain framework-independent.

---

## 5. Suggested Project Structure

```text
src/
  main.ts
  alphatab/
    alphaTabHost.ts
    alphaTabEvents.ts
  score/
    scoreScanner.ts
    drumTrackDetector.ts
  drums/
    drumTypes.ts
    drumMapping.ts
    drumScanner.ts
    drumHighlighter.ts
  ui/
    drumKitView.ts
    fileLoader.ts
    transportControls.ts
  styles/
    main.css
```

Keep the model and mapping logic separate from rendering.

The important separation is:

```text
AlphaTab score/note model
        ↓
Drum mapping layer
        ↓
Canonical DrumPart model
        ↓
Visual drum kit rendering
```

---

## 6. Core Data Model

Create a canonical representation of drum parts used by the app.

Example:

```ts
type DrumGroup =
  | 'kick'
  | 'snare'
  | 'hihat'
  | 'tom'
  | 'cymbal'
  | 'percussion'
  | 'unknown';

interface DrumPart {
  id: string;
  displayName: string;
  group: DrumGroup;
  aliases: string[];
  midiNotes?: number[];
}
```

Example canonical parts:

```text
kick
snare
sidestick
closed-hihat
open-hihat
pedal-hihat
ride
ride-bell
crash-1
crash-2
splash
china
high-tom
mid-tom
low-tom
floor-tom
cowbell
unknown-percussion
```

The exact initial list can be small, but the code must support adding more parts without changing the architecture.

---

## 7. Drum Mapping Layer

Create a mapping layer that converts AlphaTab notes into canonical `DrumPart` objects.

The mapping should support several possible inputs:

```ts
interface DrumMappingRule {
  id: string;
  displayName: string;
  canonicalPartId: string;
  midiNote?: number;
  alphaTabName?: string;
  noteValue?: number;
  fallbackName?: string;
  group: DrumGroup;
}
```

The mapper should be defensive. Real-world scores may encode drums differently depending on format, editor, exporter, or Guitar Pro/MusicXML conventions.

The mapper should return:

```ts
interface DrumMappingResult {
  part: DrumPart;
  confidence: 'known' | 'fallback' | 'unknown';
  source: string;
}
```

If a note cannot be mapped, return an `unknown-percussion` part and log enough diagnostic information to improve the mapping later.

---

## 8. Score Scanning

Before playback begins, scan the entire score to find all drum parts that may be used.

Pseudo-code:

```ts
function scanRequiredDrumParts(score: Score): Set<string> {
  const requiredParts = new Set<string>();

  for (const track of score.tracks) {
    if (!isDrumTrack(track)) continue;

    for (const staff of track.staves) {
      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            for (const note of beat.notes) {
              const mapped = mapAlphaTabNoteToDrumPart(note, track, staff);
              requiredParts.add(mapped.part.id);
            }
          }
        }
      }
    }
  }

  return requiredParts;
}
```

The scanner should run after AlphaTab has loaded/imported the score and before playback starts.

---

## 9. Drum Track Detection

Create a helper:

```ts
function isDrumTrack(track: Track): boolean
```

Detection can use, in order of preference:

1. AlphaTab percussion/drum metadata if available.
2. MIDI program/channel information if exposed.
3. Track name heuristics, for example:
   - drums
   - drumkit
   - percussion
   - batterie
   - kit
4. Note/percussion metadata heuristics.

For the first version, track name heuristics are acceptable as a fallback, but the code should be structured so better AlphaTab-specific detection can be added later.

---

## 10. Playback Synchronization

Use AlphaTab playback events to synchronize the drum kit highlighting.

The preferred event is likely `activeBeatsChanged`, because it can represent active beats across tracks/voices.

Fallback events may include:

```ts
api.playedBeatChanged.on(...)
api.playerPositionChanged.on(...)
```

The playback event handler should:

1. Receive the active beat or active beats.
2. Inspect the notes in those beats.
3. Map the notes to canonical drum parts.
4. Highlight those parts in the drum kit UI.
5. Clear highlights after a short visual decay unless the same part is hit again.

Pseudo-code:

```ts
api.activeBeatsChanged.on(event => {
  const partsToHighlight = new Set<string>();

  for (const beat of event.activeBeats) {
    for (const note of beat.notes) {
      const mapped = mapAlphaTabNoteToDrumPart(note, beat.track, beat.staff);
      partsToHighlight.add(mapped.part.id);
    }
  }

  drumKitView.highlight(partsToHighlight);
});
```

If the exact AlphaTab event shape differs, adapt the code while preserving the logic.

---

## 11. Drum Kit UI

The first UI can be simple and functional.

Recommended first implementation:

- Render each drum part as a labeled pad or SVG element.
- Group parts visually:
  - kick/feet
  - snare
  - hi-hat
  - toms
  - cymbals
  - other percussion
- Highlight pads when hit.
- Use a short fade-out after each hit.

Do not spend too much time on a realistic drum kit illustration in the first version. Prioritize correct synchronization and mapping.

The UI should be responsive and usable on iPad in landscape mode.

---

## 12. File Loading

First version:

- Use a local file input.
- Let the user choose a Guitar Pro or MusicXML file.
- Load it into AlphaTab.
- Once loaded, scan it for drum parts.
- Render the dynamic drum kit.

No backend should be required for the first version.

This keeps the app portable and iPad-friendly.

---

## 13. iPad / PWA Requirements

Keep the app browser-compatible.

Important constraints:

- Avoid native filesystem assumptions.
- Use local file picker APIs where possible.
- Keep memory use reasonable.
- Avoid very large bundled assets.
- Make touch controls large enough.
- Ensure the layout works in landscape orientation.
- Later add PWA manifest and service worker for offline shell loading.

Audio playback on iPad may require user interaction before audio starts. Design transport controls accordingly.

---

## 14. Development Milestones

### Milestone 1 — Minimal AlphaTab Viewer

Goal: load and render a score.

Tasks:

1. Create Vite + TypeScript project.
2. Install AlphaTab.
3. Add a file input.
4. Load a supported score file.
5. Render the score in the browser.
6. Add basic play/pause controls.

Acceptance criteria:

- A user can open a score file.
- The score appears on screen.
- Playback works.

---

### Milestone 2 — Playback Event Logging

Goal: prove that playback events expose the current beat/note data.

Tasks:

1. Subscribe to AlphaTab playback events.
2. Log active beat changes.
3. Log notes found in the active beat.
4. Identify which event gives the best synchronization.

Acceptance criteria:

- During playback, the console logs active beats/notes in real time.
- The app can identify drum note events during playback.

---

### Milestone 3 — Score Scanner

Goal: scan the full score before playback.

Tasks:

1. Implement track traversal.
2. Implement drum track detection.
3. Implement note traversal.
4. Collect all unique drum notes/parts found in the score.
5. Display the discovered parts as text for debugging.

Acceptance criteria:

- When a score is loaded, the app displays the list of detected kit parts.
- The list changes depending on the score.

---

### Milestone 4 — Drum Mapping

Goal: convert raw AlphaTab notes into canonical drum parts.

Tasks:

1. Define `DrumPart` model.
2. Define initial mapping rules.
3. Implement `mapAlphaTabNoteToDrumPart`.
4. Add fallback handling for unknown notes.
5. Add debug output for unknown notes.

Acceptance criteria:

- Common drum notes map to meaningful parts.
- Unknown notes do not crash the app.
- Unknown notes appear as `unknown-percussion` or similar.

---

### Milestone 5 — Dynamic Drum Kit UI

Goal: render only the parts required by the loaded score.

Tasks:

1. Implement `drumKitView.setParts(parts)`.
2. Render grouped pads or SVG elements.
3. Add labels.
4. Make layout responsive.
5. Ensure extra parts appear dynamically.

Acceptance criteria:

- Loading different scores creates different visible kit parts.
- Parts missing from the default kit are still shown.

---

### Milestone 6 — Real-Time Highlighting

Goal: highlight kit parts during playback.

Tasks:

1. Connect playback events to the mapping layer.
2. Highlight mapped parts in the UI.
3. Add visual decay/fade-out.
4. Handle simultaneous hits.
5. Handle repeated hits on the same part.

Acceptance criteria:

- As the score plays, the corresponding drum kit parts highlight in sync.
- Multiple simultaneous parts can highlight together.

---

### Milestone 7 — iPad Polish

Goal: make the prototype usable on iPad.

Tasks:

1. Improve responsive layout.
2. Add touch-friendly transport controls.
3. Test file loading on iPad Safari.
4. Handle audio start restrictions.
5. Add PWA manifest.
6. Add offline app shell if useful.

Acceptance criteria:

- The app is usable on iPad in landscape mode.
- The score and drum kit are both visible enough to practice.

---

## 15. Debugging Requirements

Add a developer/debug panel early.

It should show:

- Loaded file name.
- Detected tracks.
- Which tracks are considered drum tracks.
- Detected drum parts.
- Unknown notes.
- Current beat/tick/time.
- Currently highlighted parts.

This will be very useful because real-world drum files may encode percussion differently.

---

## 16. Future Features

Do not implement these in the first version, but keep the architecture compatible with them.

Possible future features:

- User-editable drum mapping.
- Save/load mapping profiles.
- Different visual kit layouts.
- Left/right hand sticking suggestions.
- Foot highlighting for kick and hi-hat pedal.
- Upcoming-hit preview.
- Slow-down mode.
- Loop selected bars.
- Count-in.
- MIDI input evaluation.
- Practice scoring.
- Export/share practice setup.
- Support for multiple drum tracks.
- Better MusicXML percussion support.
- Optional support for MuseScore files through external conversion, but not initially.

---

## 17. Non-Goals for First Version

Do not implement these initially:

- Native iOS app.
- Backend server.
- User accounts.
- Cloud storage.
- MuseScore `.mscz` support.
- Beautiful realistic drum animation.
- AI-generated fingering/sticking.
- Full notation editor.

The first version is a local, browser-based drum-score player/highlighter.

---

## 18. First Coding Task for Codex

Start by creating a minimal Vite + TypeScript AlphaTab web app.

Implement:

1. File input.
2. AlphaTab score rendering.
3. Basic playback controls.
4. Playback event logging.
5. Placeholder drum kit area below the score.

Do not start with the full drum mapping system. First prove that AlphaTab can load a file, play it, and emit playback events with enough information to identify notes.

Once playback events are confirmed, proceed to the scanner and mapping layer.

