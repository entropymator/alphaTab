export type DrumGroup = 'kick' | 'snare' | 'hihat' | 'tom' | 'cymbal' | 'percussion' | 'unknown';

export interface DrumPart {
    id: string;
    displayName: string;
    group: DrumGroup;
    aliases: string[];
    midiNotes?: number[];
}

export type MappingConfidence = 'known' | 'fallback' | 'unknown';

export interface DrumMappingResult {
    part: DrumPart;
    confidence: MappingConfidence;
    source: string;
}

export interface DrumMappingRule {
    canonicalPartId: string;
    confidence?: MappingConfidence;
    displayName: string;
    group: DrumGroup;
    midiNote?: number;
    nameIncludes?: string[];
}

export interface UnknownDrumNote {
    articulationId: number | null;
    articulationName: string;
    barIndex: number;
    beatIndex: number;
    midiNote: number | null;
    noteId: number;
    source: string;
    staffIndex: number;
    trackIndex: number;
    trackName: string;
}
