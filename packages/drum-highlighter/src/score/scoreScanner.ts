import * as alphaTab from '@coderline/alphatab';
import { createUnknownDrumNote, mapAlphaTabNoteToDrumPart } from '../drums/drumMapping';
import type { DrumMappingResult, DrumPart, UnknownDrumNote } from '../drums/drumTypes';
import { detectDrumTrack, type DrumTrackDetection } from './drumTrackDetector';

export interface DetectedTrack {
    index: number;
    isDrumTrack: boolean;
    name: string;
    reasons: string[];
    staffCount: number;
}

export interface ScannedDrumNote {
    barIndex: number;
    beatIndex: number;
    mapping: DrumMappingResult;
    note: alphaTab.model.Note;
    staffIndex: number;
    trackIndex: number;
}

export interface ScoreScanResult {
    drumNotes: ScannedDrumNote[];
    drumTracks: DetectedTrack[];
    parts: DrumPart[];
    totalNotes: number;
    unknownNotes: UnknownDrumNote[];
}

const groupOrder = ['kick', 'snare', 'hihat', 'tom', 'cymbal', 'percussion', 'unknown'];

export function scanScoreForDrums(score: alphaTab.model.Score): ScoreScanResult {
    const partsById = new Map<string, DrumPart>();
    const unknownNotes: UnknownDrumNote[] = [];
    const drumNotes: ScannedDrumNote[] = [];
    const trackDetections = score.tracks.map(track => detectDrumTrack(track));

    for (const detection of trackDetections) {
        if (!detection.isDrumTrack) {
            continue;
        }

        for (const staff of detection.track.staves) {
            for (const bar of staff.bars) {
                for (const voice of bar.voices) {
                    for (const beat of voice.beats) {
                        for (const note of beat.notes) {
                            if (!note.isPercussion && !staff.isPercussion && !detection.track.isPercussion) {
                                continue;
                            }

                            const mapping = mapAlphaTabNoteToDrumPart(note);
                            partsById.set(mapping.part.id, mapping.part);
                            drumNotes.push({
                                barIndex: bar.index,
                                beatIndex: beat.index,
                                mapping,
                                note,
                                staffIndex: staff.index,
                                trackIndex: detection.track.index
                            });

                            if (mapping.confidence === 'unknown') {
                                unknownNotes.push(createUnknownDrumNote(note, mapping));
                            }
                        }
                    }
                }
            }
        }
    }

    return {
        drumNotes,
        drumTracks: trackDetections.map(toDetectedTrack),
        parts: [...partsById.values()].sort(compareParts),
        totalNotes: drumNotes.length,
        unknownNotes
    };
}

function toDetectedTrack(detection: DrumTrackDetection): DetectedTrack {
    return {
        index: detection.track.index,
        isDrumTrack: detection.isDrumTrack,
        name: detection.track.name || detection.track.shortName || `Track ${detection.track.index + 1}`,
        reasons: detection.reasons,
        staffCount: detection.track.staves.length
    };
}

function compareParts(a: DrumPart, b: DrumPart): number {
    const groupCompare = groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group);
    if (groupCompare !== 0) {
        return groupCompare;
    }
    return a.displayName.localeCompare(b.displayName);
}
