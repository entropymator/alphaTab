import * as alphaTab from '@coderline/alphatab';
import type { DrumMappingResult, DrumMappingRule, DrumPart, UnknownDrumNote } from './drumTypes';

export const unknownPercussionPart: DrumPart = {
    id: 'unknown-percussion',
    displayName: 'Unknown percussion',
    group: 'unknown',
    aliases: ['Unknown percussion']
};

const mappingRules: DrumMappingRule[] = [
    { canonicalPartId: 'kick', displayName: 'Kick', group: 'kick', midiNote: 35, nameIncludes: ['kick'] },
    { canonicalPartId: 'kick', displayName: 'Kick', group: 'kick', midiNote: 36, nameIncludes: ['kick'] },
    { canonicalPartId: 'snare', displayName: 'Snare', group: 'snare', midiNote: 38, nameIncludes: ['snare (hit)'] },
    { canonicalPartId: 'sidestick', displayName: 'Sidestick', group: 'snare', midiNote: 37, nameIncludes: ['side stick', 'sticks'] },
    { canonicalPartId: 'snare-rimshot', displayName: 'Snare rimshot', group: 'snare', midiNote: 38, nameIncludes: ['rim shot'] },
    { canonicalPartId: 'closed-hihat', displayName: 'Closed hi-hat', group: 'hihat', midiNote: 42, nameIncludes: ['hi-hat (closed)', 'charley'] },
    { canonicalPartId: 'open-hihat', displayName: 'Open hi-hat', group: 'hihat', midiNote: 46, nameIncludes: ['hi-hat (open)'] },
    { canonicalPartId: 'pedal-hihat', displayName: 'Pedal hi-hat', group: 'hihat', midiNote: 44, nameIncludes: ['pedal hi-hat'] },
    { canonicalPartId: 'half-open-hihat', displayName: 'Half-open hi-hat', group: 'hihat', midiNote: 46, nameIncludes: ['hi-hat (half)'] },
    { canonicalPartId: 'ride', displayName: 'Ride', group: 'cymbal', midiNote: 51, nameIncludes: ['ride (middle)', 'ride cymbal 2'] },
    { canonicalPartId: 'ride-edge', displayName: 'Ride edge', group: 'cymbal', midiNote: 51, nameIncludes: ['ride (edge)'] },
    { canonicalPartId: 'ride-bell', displayName: 'Ride bell', group: 'cymbal', midiNote: 53, nameIncludes: ['ride (bell)'] },
    { canonicalPartId: 'crash-1', displayName: 'Crash 1', group: 'cymbal', midiNote: 49, nameIncludes: ['crash high'] },
    { canonicalPartId: 'crash-2', displayName: 'Crash 2', group: 'cymbal', midiNote: 57, nameIncludes: ['crash medium'] },
    { canonicalPartId: 'splash', displayName: 'Splash', group: 'cymbal', midiNote: 55, nameIncludes: ['splash'] },
    { canonicalPartId: 'china', displayName: 'China', group: 'cymbal', midiNote: 52, nameIncludes: ['china'] },
    { canonicalPartId: 'high-tom', displayName: 'High tom', group: 'tom', midiNote: 48, nameIncludes: ['tom high'] },
    { canonicalPartId: 'mid-tom', displayName: 'Mid tom', group: 'tom', midiNote: 47, nameIncludes: ['tom medium'] },
    { canonicalPartId: 'low-tom', displayName: 'Low tom', group: 'tom', midiNote: 45, nameIncludes: ['tom low'] },
    { canonicalPartId: 'floor-tom', displayName: 'Floor tom', group: 'tom', midiNote: 41, nameIncludes: ['floor tom', 'tom very low'] },
    { canonicalPartId: 'cowbell', displayName: 'Cowbell', group: 'percussion', midiNote: 56, nameIncludes: ['cowbell'] },
    { canonicalPartId: 'tambourine', displayName: 'Tambourine', group: 'percussion', midiNote: 54, nameIncludes: ['tambourine'] },
    { canonicalPartId: 'hand-clap', displayName: 'Hand clap', group: 'percussion', midiNote: 39, nameIncludes: ['hand clap'] },
    { canonicalPartId: 'shaker', displayName: 'Shaker', group: 'percussion', midiNote: 82, nameIncludes: ['shaker'] },
    { canonicalPartId: 'conga-high', displayName: 'High conga', group: 'percussion', midiNote: 63, nameIncludes: ['conga high', 'open hi conga'] },
    { canonicalPartId: 'conga-low', displayName: 'Low conga', group: 'percussion', midiNote: 64, nameIncludes: ['conga low', 'low conga'] }
];

const partsById = new Map<string, DrumPart>();

for (const rule of mappingRules) {
    const part = partsById.get(rule.canonicalPartId) ?? {
        id: rule.canonicalPartId,
        displayName: rule.displayName,
        group: rule.group,
        aliases: [],
        midiNotes: []
    };

    for (const alias of rule.nameIncludes ?? []) {
        if (!part.aliases.includes(alias)) {
            part.aliases.push(alias);
        }
    }
    if (rule.midiNote !== undefined && !part.midiNotes?.includes(rule.midiNote)) {
        part.midiNotes?.push(rule.midiNote);
    }
    partsById.set(part.id, part);
}

export function mapAlphaTabNoteToDrumPart(note: alphaTab.model.Note): DrumMappingResult {
    const articulation = resolveArticulation(note);
    const articulationName = articulation?.name ?? '';
    const midiNote = articulation?.outputMidiNumber;
    const normalizedName = normalizeName(articulationName);

    for (const rule of mappingRules) {
        const matchesName = rule.nameIncludes?.some(name => normalizedName.includes(normalizeName(name))) ?? false;
        if (matchesName) {
            return {
                part: partsById.get(rule.canonicalPartId)!,
                confidence: rule.confidence ?? 'known',
                source: `articulation:${articulationName}`
            };
        }
    }

    if (midiNote !== undefined) {
        const midiRule = mappingRules.find(rule => rule.midiNote === midiNote);
        if (midiRule) {
            return {
                part: partsById.get(midiRule.canonicalPartId)!,
                confidence: 'fallback',
                source: `midi:${midiNote}`
            };
        }
    }

    return {
        part: unknownPercussionPart,
        confidence: 'unknown',
        source: articulationName ? `unknown-articulation:${articulationName}` : 'unknown'
    };
}

export function createUnknownDrumNote(note: alphaTab.model.Note, mapping: DrumMappingResult): UnknownDrumNote {
    const beat = note.beat;
    const staff = beat.voice.bar.staff;
    const track = staff.track;
    const articulation = resolveArticulation(note);
    const articulationName = articulation?.name ?? '';

    return {
        articulationId: Number.isNaN(note.percussionArticulation) ? null : note.percussionArticulation,
        articulationName,
        barIndex: beat.voice.bar.index,
        beatIndex: beat.index,
        midiNote: articulation?.outputMidiNumber ?? null,
        noteId: note.id,
        source: mapping.source,
        staffIndex: staff.index,
        trackIndex: track.index,
        trackName: track.name || `Track ${track.index + 1}`
    };
}

function normalizeName(value: string): string {
    return value.toLocaleLowerCase().replaceAll('-', ' ').replaceAll(/\s+/g, ' ').trim();
}

interface ResolvedArticulation {
    name: string;
    outputMidiNumber: number;
}

const fallbackArticulationsById = new Map<number, ResolvedArticulation>([
    [29, { name: 'Ride (choke) 2', outputMidiNumber: 59 }],
    [30, { name: 'Reverse Cymbal (hit)', outputMidiNumber: 49 }],
    [31, { name: 'Snare (side stick)', outputMidiNumber: 40 }],
    [33, { name: 'Metronome (hit)', outputMidiNumber: 37 }],
    [34, { name: 'Metronome (bell)', outputMidiNumber: 38 }],
    [35, { name: 'Kick (hit)', outputMidiNumber: 35 }],
    [36, { name: 'Kick (hit) 2', outputMidiNumber: 36 }],
    [37, { name: 'Snare (side stick)', outputMidiNumber: 37 }],
    [38, { name: 'Snare (hit)', outputMidiNumber: 38 }],
    [39, { name: 'Hand Clap (hit)', outputMidiNumber: 39 }],
    [40, { name: 'Electric Snare (hit)', outputMidiNumber: 40 }],
    [41, { name: 'Low Floor Tom (hit)', outputMidiNumber: 41 }],
    [42, { name: 'Hi-Hat (closed)', outputMidiNumber: 42 }],
    [43, { name: 'Very Low Tom (hit)', outputMidiNumber: 43 }],
    [44, { name: 'Pedal Hi-Hat (hit)', outputMidiNumber: 44 }],
    [45, { name: 'Low Tom (hit)', outputMidiNumber: 45 }],
    [46, { name: 'Hi-Hat (open)', outputMidiNumber: 46 }],
    [47, { name: 'Mid Tom (hit)', outputMidiNumber: 47 }],
    [48, { name: 'High Tom (hit)', outputMidiNumber: 48 }],
    [49, { name: 'Crash high (hit)', outputMidiNumber: 49 }],
    [50, { name: 'High Floor Tom (hit)', outputMidiNumber: 50 }],
    [51, { name: 'Ride (middle)', outputMidiNumber: 51 }],
    [52, { name: 'China (hit)', outputMidiNumber: 52 }],
    [53, { name: 'Ride (bell)', outputMidiNumber: 53 }],
    [54, { name: 'Tambourine (hit)', outputMidiNumber: 54 }],
    [55, { name: 'Splash (hit)', outputMidiNumber: 55 }],
    [56, { name: 'Cowbell medium (hit)', outputMidiNumber: 56 }],
    [57, { name: 'Crash medium (hit)', outputMidiNumber: 57 }],
    [58, { name: 'Vibraslap (hit)', outputMidiNumber: 58 }],
    [59, { name: 'Ride (edge)', outputMidiNumber: 59 }],
    [60, { name: 'Ride Cymbal 2', outputMidiNumber: 59 }],
    [63, { name: 'Conga High (hit)', outputMidiNumber: 63 }],
    [64, { name: 'Open Hi Conga', outputMidiNumber: 63 }],
    [65, { name: 'Low Conga', outputMidiNumber: 64 }],
    [80, { name: 'Triangle (mute)', outputMidiNumber: 80 }],
    [81, { name: 'Triangle (hit)', outputMidiNumber: 81 }],
    [82, { name: 'Shaker (hit)', outputMidiNumber: 82 }],
    [91, { name: 'Snare (rim shot)', outputMidiNumber: 38 }],
    [92, { name: 'Hi-Hat (half)', outputMidiNumber: 46 }],
    [93, { name: 'Ride (edge)', outputMidiNumber: 51 }],
    [94, { name: 'Ride (choke)', outputMidiNumber: 51 }],
    [95, { name: 'Splash (choke)', outputMidiNumber: 55 }],
    [96, { name: 'China (choke)', outputMidiNumber: 52 }],
    [97, { name: 'Crash high (choke)', outputMidiNumber: 49 }],
    [98, { name: 'Crash medium (choke)', outputMidiNumber: 57 }],
    [99, { name: 'Cowbell low (hit)', outputMidiNumber: 56 }],
    [102, { name: 'Cowbell high (hit)', outputMidiNumber: 56 }],
    [126, { name: 'Ride (middle) 2', outputMidiNumber: 59 }],
    [127, { name: 'Ride (bell) 2', outputMidiNumber: 59 }]
]);

function resolveArticulation(note: alphaTab.model.Note): ResolvedArticulation | null {
    if (!note.isPercussion || Number.isNaN(note.percussionArticulation)) {
        return null;
    }

    const trackArticulations = note.beat.voice.bar.staff.track.percussionArticulations;
    const trackArticulation = trackArticulations[note.percussionArticulation];
    if (trackArticulation) {
        return {
            name: trackArticulation.elementType || `Articulation ${trackArticulation.id}`,
            outputMidiNumber: trackArticulation.outputMidiNumber
        };
    }

    return fallbackArticulationsById.get(note.percussionArticulation) ?? null;
}
