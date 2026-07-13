import * as alphaTab from '@coderline/alphatab';

const drumTrackNamePattern = /\b(drum|drums|drumkit|percussion|batterie|kit)\b/i;
const percussionMidiChannel = 9;

export interface DrumTrackDetection {
    isDrumTrack: boolean;
    reasons: string[];
    track: alphaTab.model.Track;
}

export function detectDrumTrack(track: alphaTab.model.Track): DrumTrackDetection {
    const reasons: string[] = [];

    if (track.isPercussion) {
        reasons.push('track.isPercussion');
    }
    if (track.staves.some(staff => staff.isPercussion)) {
        reasons.push('staff.isPercussion');
    }
    if (
        track.playbackInfo.primaryChannel === percussionMidiChannel ||
        track.playbackInfo.secondaryChannel === percussionMidiChannel
    ) {
        reasons.push('midiChannel:9');
    }
    if (drumTrackNamePattern.test(track.name) || drumTrackNamePattern.test(track.shortName)) {
        reasons.push('trackName');
    }

    const hasPercussionNotes = track.staves.some(staff =>
        staff.bars.some(bar => bar.voices.some(voice => voice.beats.some(beat => beat.notes.some(note => note.isPercussion))))
    );
    if (hasPercussionNotes) {
        reasons.push('percussionNotes');
    }

    return {
        isDrumTrack: reasons.length > 0,
        reasons,
        track
    };
}
