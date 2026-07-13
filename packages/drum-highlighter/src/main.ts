import * as alphaTab from '@coderline/alphatab';
import { AlphaTabHost, formatDuration } from './alphatab/alphaTabHost';
import { mapAlphaTabNoteToDrumPart } from './drums/drumMapping';
import { registerServiceWorker, type PwaStatus } from './pwa/registerServiceWorker';
import { scanScoreForDrums } from './score/scoreScanner';
import { renderAppShell } from './ui/appShell';
import { DebugPanel } from './ui/debugPanel';
import { DrumKitView, type DrumKitPerspective } from './ui/drumKitView';
import './styles/main.css';

const app = document.querySelector<HTMLElement>('#app');
if (!app) {
    throw new Error('#app element not found');
}

const elements = renderAppShell(app);
elements.debugPanel.hidden = !elements.debugToggleInput.checked;

const debugPanel = new DebugPanel({
    detectedParts: elements.detectedParts,
    detectedTracks: elements.detectedTracks,
    eventLog: elements.debugEventLog,
    highlightedParts: elements.highlightedParts,
    latestEvent: elements.latestEvent,
    loadedFile: elements.loadedFile,
    playerState: elements.playerState,
    pwaStatus: elements.pwaStatus,
    scoreTitle: elements.scoreTitle,
    unknownNotes: elements.unknownNotes
});
const drumKitView = new DrumKitView(elements.detectedKitStage);

registerServiceWorker(status => {
    debugPanel.setPwaStatus(formatPwaStatus(status));
});

drumKitView.onHighlightChange(partIds => debugPanel.setHighlightedParts(partIds));

const host = new AlphaTabHost(
    {
        score: elements.scoreCanvas,
        viewport: elements.scoreViewport
    },
    {
        onActiveBeatsChanged: beats => {
            drumKitView.highlight(partsFromBeats(beats));
        },
        onPlaybackRangeChanged: range => {
            if (elements.loopSelectionInput.checked) {
                elements.statusText.textContent = range
                    ? 'Looping the selected score range.'
                    : 'Loop selection is on, but no score range is selected.';
            }
        },
        onPlayedBeatChanged: beat => {
            if (beat) {
                drumKitView.highlight(partsFromBeats([beat]));
            }
        },
        onReadyChanged: ready => {
            elements.playPauseButton.disabled = !ready;
            elements.stopButton.disabled = !ready;
            elements.statusText.textContent = ready ? 'Ready to play.' : 'Loading score and audio engine...';
        },
        onScoreLoaded: score => {
            debugPanel.setScoreTitle([score.title, score.artist].filter(Boolean).join(' - ') || 'Untitled score');
            const scan = scanScoreForDrums(score);
            debugPanel.renderScanResult(scan);
            drumKitView.setParts(scan.parts);
            elements.statusText.textContent = `Score loaded. Found ${scan.parts.length} drum part(s). Waiting for player.`;
            console.info('[drum-highlighter] score scan', scan);
        },
        onPlayerStateChanged: state => {
            debugPanel.setPlayerState(alphaTab.synth.PlayerState[state] ?? String(state));
            elements.playPauseButton.textContent = state === alphaTab.synth.PlayerState.Playing ? 'Pause' : 'Play';
        },
        onPlayerPositionChanged: (currentTime, endTime) => {
            elements.timeReadout.textContent = `${formatDuration(currentTime)} / ${formatDuration(endTime)}`;
        },
        onDebugEvent: event => {
            debugPanel.renderDebugEvent(event);
        },
        onError: error => {
            console.error('[drum-highlighter] alphaTab error', error);
            elements.statusText.textContent = 'AlphaTab reported an error. Check the browser console.';
        }
    }
);

elements.fileInput.addEventListener('change', () => {
    const file = elements.fileInput.files?.[0];
    if (!file) {
        return;
    }

    debugPanel.resetForLoad(file.name);
    elements.loopSelectionInput.checked = false;
    drumKitView.clearHighlights();
    host.loadFile(file);
});

elements.playPauseButton.addEventListener('click', () => host.playPause());
elements.stopButton.addEventListener('click', () => host.stop());
elements.autoScrollInput.addEventListener('change', () => host.setAutoScroll(elements.autoScrollInput.checked));
elements.countInInput.addEventListener('change', () => {
    host.setCountInEnabled(elements.countInInput.checked);
    elements.statusText.textContent = elements.countInInput.checked
        ? 'Count-in enabled before playback.'
        : 'Count-in disabled.';
});
elements.metronomeInput.addEventListener('change', () => {
    host.setMetronomeEnabled(elements.metronomeInput.checked);
    elements.statusText.textContent = elements.metronomeInput.checked
        ? 'Metronome enabled during playback.'
        : 'Metronome disabled.';
});
elements.debugToggleInput.addEventListener('change', () => {
    elements.debugPanel.hidden = !elements.debugToggleInput.checked;
});
for (const speedInput of elements.speedInputs) {
    speedInput.addEventListener('change', () => {
        if (!speedInput.checked) {
            return;
        }

        const speed = Number(speedInput.value);
        host.setPlaybackSpeed(speed);
        elements.statusText.textContent = `Practice speed set to ${Math.round(speed * 100)}%.`;
    });
}
for (const perspectiveInput of elements.perspectiveInputs) {
    perspectiveInput.addEventListener('change', () => {
        if (!perspectiveInput.checked) {
            return;
        }

        const perspective = perspectiveInput.value as DrumKitPerspective;
        drumKitView.setPerspective(perspective);
        elements.statusText.textContent =
            perspective === 'pov' ? 'Drum kit switched to player POV.' : 'Drum kit switched to top view.';
    });
}
elements.loopSelectionInput.addEventListener('change', () => {
    const applied = host.setLoopSelection(elements.loopSelectionInput.checked);
    if (!applied && elements.loopSelectionInput.checked) {
        elements.loopSelectionInput.checked = false;
        elements.statusText.textContent = 'Drag across beats in the score first, then enable Loop selection.';
        return;
    }

    elements.statusText.textContent = elements.loopSelectionInput.checked
        ? 'Looping the selected score range.'
        : 'Selection looping disabled.';
});

window.addEventListener('beforeunload', () => host.dispose());

function partsFromBeats(beats: alphaTab.model.Beat[]): Set<string> {
    const partIds = new Set<string>();

    for (const beat of beats) {
        for (const note of beat.notes) {
            const mapped = mapAlphaTabNoteToDrumPart(note);
            partIds.add(mapped.part.id);
        }
    }

    return partIds;
}

function formatPwaStatus(status: PwaStatus): string {
    const requiredUrls = [
        '/',
        '/manifest.webmanifest',
        '/apple-touch-icon.png',
        '/apple-touch-icon-precomposed.png',
        '/icon-192.png',
        '/icon-512.png',
        '/font/Bravura.woff2',
        '/soundfont/sonivox.sf2'
    ];
    const cachedUrlSet = new Set(status.cachedUrls);
    const missingUrls = requiredUrls.filter(url => !cachedUrlSet.has(url));
    const cacheSummary =
        missingUrls.length === 0
            ? `${status.cachedUrls.length} cached file(s)`
            : `${status.cachedUrls.length} cached file(s), missing ${missingUrls.join(', ')}`;

    return `${status.cacheName}, ${status.serviceWorker}, ${
        status.controlled ? 'controlled' : 'not controlled yet'
    }, ${status.displayMode}, ${status.online ? 'online' : 'offline'}, ${cacheSummary}`;
}
