import * as alphaTab from '@coderline/alphatab';

export interface AlphaTabHostElements {
    score: HTMLElement;
    viewport: HTMLElement;
}

export interface PlaybackDebugSnapshot {
    eventName: string;
    summary: string;
    details: unknown;
}

export interface AlphaTabHostOptions {
    onActiveBeatsChanged?: (beats: alphaTab.model.Beat[]) => void;
    onPlaybackRangeChanged?: (range: alphaTab.synth.PlaybackRange | null) => void;
    onReadyChanged?: (ready: boolean) => void;
    onScoreLoaded?: (score: alphaTab.model.Score) => void;
    onPlayedBeatChanged?: (beat: alphaTab.model.Beat | null) => void;
    onPlayerStateChanged?: (state: alphaTab.synth.PlayerState) => void;
    onPlayerPositionChanged?: (currentTime: number, endTime: number) => void;
    onDebugEvent?: (snapshot: PlaybackDebugSnapshot) => void;
    onError?: (error: unknown) => void;
}

export class AlphaTabHost {
    readonly api: alphaTab.AlphaTabApi;
    private subscriptions: (() => void)[] = [];
    private readonly rowScrollHandler: RowAnchoredScrollHandler;
    private loopSelectionEnabled = false;

    constructor(
        elements: AlphaTabHostElements,
        private options: AlphaTabHostOptions = {}
    ) {
        this.api = new alphaTab.AlphaTabApi(elements.score, {
            core: {
                fontDirectory: new URL('/font/', document.location.href).href,
                logLevel: alphaTab.LogLevel.Info
            },
            display: {
                scale: 0.85
            },
            player: {
                enableAnimatedBeatCursor: true,
                enableCursor: true,
                enableElementHighlighting: true,
                enablePlayer: true,
                scrollMode: alphaTab.ScrollMode.Continuous,
                scrollElement: elements.viewport,
                soundFont: new URL('/soundfont/sonivox.sf2', document.location.href).href
            }
        });
        this.rowScrollHandler = new RowAnchoredScrollHandler(elements.viewport);
        this.api.customScrollHandler = this.rowScrollHandler;

        this.subscribeToCoreEvents();
        this.subscribeToPlaybackEvents();

        if (typeof window !== 'undefined') {
            Object.assign(window, { alphaTab, alphaTabDrumHighlighterApi: this.api });
        }
    }

    loadFile(file: File): void {
        this.options.onReadyChanged?.(false);
        this.setLoopSelection(false);
        this.rowScrollHandler.reset();
        this.rowScrollHandler.scrollToStart('auto');
        const reader = new FileReader();
        reader.onload = event => {
            const data = event.target?.result;
            if (data instanceof ArrayBuffer) {
                this.api.load(data, [0]);
            }
        };
        reader.onerror = () => this.options.onError?.(reader.error);
        reader.readAsArrayBuffer(file);
    }

    playPause(): void {
        this.api.playPause();
    }

    setPlaybackSpeed(speed: number): void {
        this.api.playbackSpeed = speed;
        this.emitDebug('playbackSpeedChanged', `${Math.round(speed * 100)}%`, { speed });
    }

    setCountInEnabled(enabled: boolean): void {
        this.api.countInVolume = enabled ? 0.8 : 0;
        this.emitDebug('countInChanged', enabled ? 'Enabled' : 'Disabled', { enabled });
    }

    setMetronomeEnabled(enabled: boolean): void {
        this.api.metronomeVolume = enabled ? 0.65 : 0;
        this.emitDebug('metronomeChanged', enabled ? 'Enabled' : 'Disabled', { enabled });
    }

    stop(): void {
        this.api.stop();
        this.rowScrollHandler.reset();
        this.rowScrollHandler.scrollToStart('smooth');
    }

    setAutoScroll(enabled: boolean): void {
        this.rowScrollHandler.setEnabled(enabled);
        this.api.settings.player.scrollMode = enabled ? alphaTab.ScrollMode.Continuous : alphaTab.ScrollMode.Off;
        this.api.updateSettings();
    }

    setLoopSelection(enabled: boolean): boolean {
        this.loopSelectionEnabled = enabled;
        if (!enabled) {
            this.api.isLooping = false;
            return true;
        }

        this.api.applyPlaybackRangeFromHighlight();
        const hasRange = this.api.playbackRange !== null;
        this.api.isLooping = hasRange;
        return hasRange;
    }

    dispose(): void {
        for (const unsubscribe of this.subscriptions) {
            unsubscribe();
        }
        this.subscriptions = [];
        this.api.destroy();
    }

    private subscribeToCoreEvents(): void {
        this.subscriptions.push(
            this.api.error.on(error => {
                this.options.onError?.(error);
            })
        );
        this.subscriptions.push(
            this.api.scoreLoaded.on(score => {
                this.options.onScoreLoaded?.(score);
            })
        );
        this.subscriptions.push(
            this.api.playerReady.on(() => {
                this.options.onReadyChanged?.(true);
            })
        );
        this.subscriptions.push(
            this.api.playerStateChanged.on(event => {
                this.options.onPlayerStateChanged?.(event.state);
            })
        );
        this.subscriptions.push(
            this.api.playerPositionChanged.on(event => {
                this.options.onPlayerPositionChanged?.(event.currentTime, event.endTime);
                this.emitDebug('playerPositionChanged', formatPosition(event.currentTime, event.endTime), event);
            })
        );
        this.subscriptions.push(
            this.api.playbackRangeChanged.on(event => {
                if (this.loopSelectionEnabled) {
                    this.api.isLooping = event.playbackRange !== null;
                }
                this.options.onPlaybackRangeChanged?.(event.playbackRange);
                this.emitDebug('playbackRangeChanged', summarizePlaybackRange(event.playbackRange), event);
            })
        );
    }

    private subscribeToPlaybackEvents(): void {
        this.subscriptions.push(
            this.api.activeBeatsChanged.on(event => {
                this.options.onActiveBeatsChanged?.(event.activeBeats ?? []);
                this.emitDebug('activeBeatsChanged', summarizeActiveBeats(event), event);
            })
        );
        this.subscriptions.push(
            this.api.playedBeatChanged.on(beat => {
                this.options.onPlayedBeatChanged?.(beat);
                this.emitDebug('playedBeatChanged', summarizeBeat(beat), beat);
            })
        );
    }

    private emitDebug(eventName: string, summary: string, details: unknown): void {
        const snapshot: PlaybackDebugSnapshot = { eventName, summary, details };
        console.debug(`[drum-highlighter] ${eventName}`, details);
        this.options.onDebugEvent?.(snapshot);
    }
}

interface BoundsLike {
    y: number;
    h: number;
}

interface StaffSystemBoundsLike {
    index: number;
    realBounds: BoundsLike;
    boundsLookup?: {
        staffSystems?: StaffSystemBoundsLike[];
    };
}

interface BeatBoundsLike {
    barBounds?: {
        masterBarBounds?: {
            staffSystemBounds?: StaffSystemBoundsLike;
        };
    };
}

class RowAnchoredScrollHandler implements alphaTab.IScrollHandler {
    private readonly currentRowVisibleIndex = 2;
    private readonly topMargin = 8;
    private enabled = true;
    private lastSystemIndex = -1;

    constructor(private readonly viewport: HTMLElement) {}

    [Symbol.dispose](): void {
        // Nothing to release; the handler only owns plain DOM references.
    }

    forceScrollTo(currentBeatBounds: unknown): void {
        this.scrollForBeat(currentBeatBounds, true);
    }

    onBeatCursorUpdating(startBeat: unknown): void {
        this.scrollForBeat(startBeat, false);
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        this.reset();
    }

    reset(): void {
        this.lastSystemIndex = -1;
    }

    scrollToStart(behavior: ScrollBehavior): void {
        if (this.enabled) {
            this.viewport.scrollTo({ top: 0, behavior });
        }
    }

    private scrollForBeat(beatBounds: unknown, force: boolean): void {
        if (!this.enabled) {
            return;
        }

        const currentSystem = getStaffSystemBounds(beatBounds);
        if (!currentSystem) {
            return;
        }

        if (!force && currentSystem.index === this.lastSystemIndex) {
            return;
        }
        this.lastSystemIndex = currentSystem.index;

        const targetSystemIndex = currentSystem.index - this.currentRowVisibleIndex;
        if (targetSystemIndex < 0) {
            return;
        }

        const targetSystem = currentSystem.boundsLookup?.staffSystems?.[targetSystemIndex];
        if (!targetSystem) {
            return;
        }

        const maxScrollTop = Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight);
        const targetTop = Math.min(Math.max(targetSystem.realBounds.y - this.topMargin, 0), maxScrollTop);
        if (Math.abs(this.viewport.scrollTop - targetTop) < 4) {
            return;
        }

        this.viewport.scrollTo({
            top: targetTop,
            behavior: force ? 'auto' : 'smooth'
        });
    }
}

function getStaffSystemBounds(beatBounds: unknown): StaffSystemBoundsLike | null {
    const candidate = beatBounds as BeatBoundsLike;
    return candidate.barBounds?.masterBarBounds?.staffSystemBounds ?? null;
}

interface ActiveBeatsEvent {
    activeBeats?: alphaTab.model.Beat[];
}

function summarizeActiveBeats(event: ActiveBeatsEvent): string {
    const beats = event.activeBeats ?? [];
    const noteCount = beats.reduce((total: number, beat: alphaTab.model.Beat) => total + beat.notes.length, 0);
    return `${beats.length} active beat(s), ${noteCount} note(s)`;
}

function summarizeBeat(beat: alphaTab.model.Beat | null): string {
    if (!beat) {
        return 'No beat';
    }
    return `Beat ${beat.index} with ${beat.notes.length} note(s)`;
}

function summarizePlaybackRange(range: alphaTab.synth.PlaybackRange | null): string {
    if (!range) {
        return 'No selected range';
    }
    return `Ticks ${range.startTick} to ${range.endTick}`;
}

function formatPosition(currentTime: number, endTime: number): string {
    return `${formatDuration(currentTime)} / ${formatDuration(endTime)}`;
}

export function formatDuration(milliseconds: number): string {
    let seconds = Math.max(0, milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    seconds = Math.floor(seconds - minutes * 60);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
