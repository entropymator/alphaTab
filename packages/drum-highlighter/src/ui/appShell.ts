export interface AppElements {
    autoScrollInput: HTMLInputElement;
    countInInput: HTMLInputElement;
    debugPanel: HTMLElement;
    debugToggleInput: HTMLInputElement;
    debugEventLog: HTMLOListElement;
    detectedKitStage: HTMLElement;
    detectedParts: HTMLElement;
    detectedTracks: HTMLElement;
    fileInput: HTMLInputElement;
    highlightedParts: HTMLElement;
    latestEvent: HTMLElement;
    loadedFile: HTMLElement;
    loopSelectionInput: HTMLInputElement;
    metronomeInput: HTMLInputElement;
    playPauseButton: HTMLButtonElement;
    playerState: HTMLElement;
    pwaStatus: HTMLElement;
    perspectiveInputs: HTMLInputElement[];
    scoreCanvas: HTMLElement;
    scoreTitle: HTMLElement;
    scoreViewport: HTMLElement;
    statusText: HTMLElement;
    stopButton: HTMLButtonElement;
    speedInputs: HTMLInputElement[];
    timeReadout: HTMLElement;
    unknownNotes: HTMLElement;
}

export function renderAppShell(app: HTMLElement): AppElements {
    app.innerHTML = `
        <main class="app-shell">
            <header class="top-bar">
                <div>
                    <p class="eyebrow">AlphaTab prototype</p>
                    <h1>Drum Highlighter</h1>
                </div>
                <label class="file-picker">
                    <span>Open score</span>
                    <input class="file-input" type="file" accept=".gp,.gp3,.gp4,.gp5,.gpx,.gpif,.musicxml,.xml,.mxl" />
                </label>
            </header>

            <section class="workspace">
                <section class="score-panel" aria-label="Score viewer">
                    <div class="drum-kit-strip" aria-label="Drum kit">
                        <div class="drum-kit-header">
                            <h2>Drum Kit</h2>
                            <fieldset class="kit-perspective-control" aria-label="Drum kit view">
                                <legend>View</legend>
                                <label>
                                    <input class="kit-perspective-input" type="radio" name="kit-perspective" value="top" checked />
                                    <span>Top</span>
                                </label>
                                <label>
                                    <input class="kit-perspective-input" type="radio" name="kit-perspective" value="pov" />
                                    <span>POV</span>
                                </label>
                            </fieldset>
                        </div>
                        <div class="kit-stage detected-kit-stage" data-perspective="top" aria-label="Detected drum kit parts">
                            <div class="kit-rack" aria-hidden="true"></div>
                            <div class="kit-stand kit-stand-left" aria-hidden="true"></div>
                            <div class="kit-stand kit-stand-right" aria-hidden="true"></div>
                        </div>
                    </div>
                    <div class="score-toolbar">
                        <button class="control-button play-pause" type="button" disabled>Play</button>
                        <button class="control-button stop" type="button" disabled>Stop</button>
                        <fieldset class="speed-control" aria-label="Practice speed">
                            <legend>Speed</legend>
                            <label>
                                <input class="speed-input" type="radio" name="practice-speed" value="0.5" />
                                <span>50%</span>
                            </label>
                            <label>
                                <input class="speed-input" type="radio" name="practice-speed" value="0.75" />
                                <span>75%</span>
                            </label>
                            <label>
                                <input class="speed-input" type="radio" name="practice-speed" value="1" checked />
                                <span>100%</span>
                            </label>
                        </fieldset>
                        <label class="count-in-toggle">
                            <input class="count-in-input" type="checkbox" />
                            <span>Count in</span>
                        </label>
                        <label class="metronome-toggle">
                            <input class="metronome-input" type="checkbox" />
                            <span>Metronome</span>
                        </label>
                        <label class="auto-scroll-toggle">
                            <input class="auto-scroll-input" type="checkbox" checked />
                            <span>Auto-scroll</span>
                        </label>
                        <label class="loop-selection-toggle">
                            <input class="loop-selection-input" type="checkbox" />
                            <span>Loop selection</span>
                        </label>
                        <label class="debug-toggle">
                            <input class="debug-toggle-input" type="checkbox" />
                            <span>Debug</span>
                        </label>
                        <span class="time-readout">00:00 / 00:00</span>
                        <span class="status-text">Choose a score file to begin.</span>
                    </div>
                    <div class="score-viewport">
                        <div class="score-canvas"></div>
                    </div>
                </section>

                <aside class="debug-panel" aria-label="Debug panel">
                    <h2>Debug</h2>
                    <dl>
                        <div>
                            <dt>File</dt>
                            <dd class="loaded-file">None</dd>
                        </div>
                        <div>
                            <dt>Score</dt>
                            <dd class="score-title">None</dd>
                        </div>
                        <div>
                            <dt>Player</dt>
                            <dd class="player-state">Idle</dd>
                        </div>
                        <div>
                            <dt>PWA</dt>
                            <dd class="pwa-status">Checking...</dd>
                        </div>
                        <div>
                            <dt>Latest event</dt>
                            <dd class="latest-event">None</dd>
                        </div>
                        <div>
                            <dt>Detected tracks</dt>
                            <dd class="detected-tracks">None</dd>
                        </div>
                        <div>
                            <dt>Detected parts</dt>
                            <dd class="detected-parts">None</dd>
                        </div>
                        <div>
                            <dt>Unknown notes</dt>
                            <dd class="unknown-notes">None</dd>
                        </div>
                        <div>
                            <dt>Highlighted parts</dt>
                            <dd class="highlighted-parts">None</dd>
                        </div>
                    </dl>
                    <ol class="event-log"></ol>
                </aside>
            </section>
        </main>
    `;

    return {
        autoScrollInput: query<HTMLInputElement>(app, '.auto-scroll-input'),
        countInInput: query<HTMLInputElement>(app, '.count-in-input'),
        debugPanel: query<HTMLElement>(app, '.debug-panel'),
        debugToggleInput: query<HTMLInputElement>(app, '.debug-toggle-input'),
        debugEventLog: query<HTMLOListElement>(app, '.event-log'),
        detectedKitStage: query<HTMLElement>(app, '.detected-kit-stage'),
        detectedParts: query<HTMLElement>(app, '.detected-parts'),
        detectedTracks: query<HTMLElement>(app, '.detected-tracks'),
        fileInput: query<HTMLInputElement>(app, '.file-input'),
        highlightedParts: query<HTMLElement>(app, '.highlighted-parts'),
        latestEvent: query<HTMLElement>(app, '.latest-event'),
        loadedFile: query<HTMLElement>(app, '.loaded-file'),
        loopSelectionInput: query<HTMLInputElement>(app, '.loop-selection-input'),
        metronomeInput: query<HTMLInputElement>(app, '.metronome-input'),
        perspectiveInputs: queryAll<HTMLInputElement>(app, '.kit-perspective-input'),
        playPauseButton: query<HTMLButtonElement>(app, '.play-pause'),
        playerState: query<HTMLElement>(app, '.player-state'),
        pwaStatus: query<HTMLElement>(app, '.pwa-status'),
        scoreCanvas: query<HTMLElement>(app, '.score-canvas'),
        scoreTitle: query<HTMLElement>(app, '.score-title'),
        scoreViewport: query<HTMLElement>(app, '.score-viewport'),
        statusText: query<HTMLElement>(app, '.status-text'),
        stopButton: query<HTMLButtonElement>(app, '.stop'),
        speedInputs: queryAll<HTMLInputElement>(app, '.speed-input'),
        timeReadout: query<HTMLElement>(app, '.time-readout'),
        unknownNotes: query<HTMLElement>(app, '.unknown-notes')
    };
}

function queryAll<T extends Element>(root: ParentNode, selector: string): T[] {
    const elements = [...root.querySelectorAll<T>(selector)];
    if (elements.length === 0) {
        throw new Error(`Missing expected elements: ${selector}`);
    }
    return elements;
}

function query<T extends Element>(root: ParentNode, selector: string): T {
    const element = root.querySelector<T>(selector);
    if (!element) {
        throw new Error(`Missing expected element: ${selector}`);
    }
    return element;
}
