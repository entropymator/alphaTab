import type { PlaybackDebugSnapshot } from '../alphatab/alphaTabHost';
import type { UnknownDrumNote } from '../drums/drumTypes';
import type { DetectedTrack, ScoreScanResult } from '../score/scoreScanner';

export interface DebugPanelElements {
    detectedParts: HTMLElement;
    detectedTracks: HTMLElement;
    eventLog: HTMLOListElement;
    highlightedParts: HTMLElement;
    latestEvent: HTMLElement;
    loadedFile: HTMLElement;
    playerState: HTMLElement;
    pwaStatus: HTMLElement;
    scoreTitle: HTMLElement;
    unknownNotes: HTMLElement;
}

export class DebugPanel {
    constructor(private readonly elements: DebugPanelElements) {}

    resetForLoad(fileName: string): void {
        this.elements.loadedFile.textContent = fileName;
        this.elements.scoreTitle.textContent = 'Loading...';
        this.elements.latestEvent.textContent = 'None';
        this.elements.detectedTracks.textContent = 'Scanning...';
        this.elements.detectedParts.textContent = 'Scanning...';
        this.elements.unknownNotes.textContent = 'Scanning...';
        this.setHighlightedParts(new Set());
        this.elements.eventLog.replaceChildren();
    }

    renderDebugEvent(event: PlaybackDebugSnapshot): void {
        this.elements.latestEvent.textContent = `${event.eventName}: ${event.summary}`;

        const item = document.createElement('li');
        item.textContent = `${new Date().toLocaleTimeString()} ${event.eventName}: ${event.summary}`;
        this.elements.eventLog.prepend(item);

        while (this.elements.eventLog.children.length > 30) {
            this.elements.eventLog.lastElementChild?.remove();
        }
    }

    renderScanResult(scan: ScoreScanResult): void {
        this.elements.detectedTracks.replaceChildren(...renderTrackList(scan.drumTracks));
        this.elements.detectedParts.textContent =
            scan.parts.length > 0
                ? `${scan.parts.map(part => part.displayName).join(', ')} (${scan.totalNotes} scanned note(s))`
                : 'No drum parts detected';
        this.elements.unknownNotes.replaceChildren(...renderUnknownNotes(scan.unknownNotes));
    }

    setHighlightedParts(partIds: Set<string>): void {
        this.elements.highlightedParts.textContent = partIds.size > 0 ? [...partIds].join(', ') : 'None';
    }

    setPlayerState(value: string): void {
        this.elements.playerState.textContent = value;
    }

    setPwaStatus(value: string): void {
        this.elements.pwaStatus.textContent = value;
    }

    setScoreTitle(value: string): void {
        this.elements.scoreTitle.textContent = value;
    }
}

function renderTrackList(tracks: DetectedTrack[]): Node[] {
    if (tracks.length === 0) {
        return [document.createTextNode('No tracks')];
    }

    return tracks.map(track => {
        const item = document.createElement('div');
        item.className = track.isDrumTrack ? 'track-detected' : 'track-muted';
        item.textContent = `${track.index + 1}. ${track.name}: ${
            track.isDrumTrack ? track.reasons.join(', ') : 'not a drum track'
        }`;
        return item;
    });
}

function renderUnknownNotes(notes: UnknownDrumNote[]): Node[] {
    if (notes.length === 0) {
        return [document.createTextNode('None')];
    }

    const summary = document.createElement('div');
    summary.textContent = `${notes.length} unknown note(s). See console scan output for full details.`;

    const preview = document.createElement('div');
    preview.className = 'unknown-preview';
    preview.textContent = notes
        .slice(0, 4)
        .map(
            note =>
                `${note.trackName} bar ${note.barIndex + 1}, beat ${note.beatIndex + 1}, articulation ${
                    note.articulationId ?? 'n/a'
                }`
        )
        .join('; ');

    return [summary, preview];
}
