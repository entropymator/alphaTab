import type { DrumPart } from '../drums/drumTypes';
import { DrumKit3dScene } from './drumKit3dScene';

interface KitLayoutSlot {
    className: string;
    height: number;
    left: number;
    top: number;
    width: number;
}

export type DrumKitPerspective = 'top' | 'pov';

export class DrumKitView {
    private readonly highlightTimers = new Map<string, number>();
    private onHighlightedPartsChanged?: (partIds: Set<string>) => void;
    private parts: DrumPart[] = [];
    private perspective: DrumKitPerspective = 'top';
    private scene3d?: DrumKit3dScene;

    constructor(private readonly stage: HTMLElement) {}

    setParts(parts: DrumPart[]): void {
        this.parts = parts;
        this.render();
    }

    setPerspective(perspective: DrumKitPerspective): void {
        this.perspective = perspective;
        this.stage.dataset.perspective = perspective;
        this.render();
    }

    private render(): void {
        this.clearHighlights();
        this.stage.querySelectorAll('.kit-piece').forEach(piece => piece.remove());
        this.scene3d?.hide();

        if (this.perspective === 'pov') {
            this.scene3d ??= new DrumKit3dScene(this.stage);
            this.scene3d.setParts(this.parts);
            this.scene3d.show();
            return;
        }

        const visibleParts = this.parts.length > 0 ? this.parts : fallbackParts;
        const fallbackSlotCounts = new Map<DrumPart['group'], number>();

        for (const part of visibleParts) {
            const slot = getKitSlot(part, this.perspective, fallbackSlotCounts);
            const piece = document.createElement('div');
            piece.className = `kit-piece ${slot.className} kit-${part.group}`;
            piece.dataset.partId = part.id;
            piece.style.left = `${slot.left}%`;
            piece.style.top = `${slot.top}%`;
            piece.style.width = `${slot.width}%`;
            piece.style.height = `${slot.height}%`;

            const label = document.createElement('span');
            label.className = 'kit-label';
            label.textContent = part.displayName;
            piece.appendChild(label);
            this.stage.appendChild(piece);
        }
    }

    highlight(partIds: Set<string>): void {
        if (partIds.size === 0) {
            return;
        }

        this.onHighlightedPartsChanged?.(partIds);

        if (this.perspective === 'pov') {
            this.scene3d?.highlight(partIds);
            const timer = window.setTimeout(() => {
                this.highlightTimers.delete('__3d__');
                if (this.highlightTimers.size === 0) {
                    this.onHighlightedPartsChanged?.(new Set());
                }
            }, 200);
            const existingTimer = this.highlightTimers.get('__3d__');
            if (existingTimer !== undefined) {
                window.clearTimeout(existingTimer);
            }
            this.highlightTimers.set('__3d__', timer);
            return;
        }

        for (const partId of partIds) {
            const piece = this.stage.querySelector<HTMLElement>(`[data-part-id="${CSS.escape(partId)}"]`);
            if (!piece) {
                continue;
            }

            piece.classList.remove('kit-hit');
            void piece.offsetWidth;
            piece.classList.add('kit-hit');
            this.scene3d?.highlight(new Set([partId]));

            const existingTimer = this.highlightTimers.get(partId);
            if (existingTimer !== undefined) {
                window.clearTimeout(existingTimer);
            }

            const timer = window.setTimeout(() => {
                piece.classList.remove('kit-hit');
                this.highlightTimers.delete(partId);
                if (this.highlightTimers.size === 0) {
                    this.onHighlightedPartsChanged?.(new Set());
                }
            }, 180);
            this.highlightTimers.set(partId, timer);
        }
    }

    clearHighlights(): void {
        for (const timer of this.highlightTimers.values()) {
            window.clearTimeout(timer);
        }
        this.highlightTimers.clear();

        for (const piece of this.stage.querySelectorAll('.kit-hit')) {
            piece.classList.remove('kit-hit');
        }
        this.scene3d?.clearHighlights();

        this.onHighlightedPartsChanged?.(new Set());
    }

    onHighlightChange(callback: (partIds: Set<string>) => void): void {
        this.onHighlightedPartsChanged = callback;
    }
}

const fallbackParts: DrumPart[] = [
    { id: 'crash-1', displayName: 'Crash', group: 'cymbal', aliases: [] },
    { id: 'high-tom', displayName: 'High tom', group: 'tom', aliases: [] },
    { id: 'kick', displayName: 'Kick', group: 'kick', aliases: [] },
    { id: 'mid-tom', displayName: 'Mid tom', group: 'tom', aliases: [] },
    { id: 'ride', displayName: 'Ride', group: 'cymbal', aliases: [] },
    { id: 'closed-hihat', displayName: 'Hi-hat', group: 'hihat', aliases: [] },
    { id: 'snare', displayName: 'Snare', group: 'snare', aliases: [] },
    { id: 'floor-tom', displayName: 'Floor tom', group: 'tom', aliases: [] }
];

const kitSlotsByPartId = new Map<string, KitLayoutSlot>([
    ['crash-1', { className: 'kit-cymbal', left: 13, top: 16, width: 17, height: 34 }],
    ['crash-2', { className: 'kit-cymbal', left: 72, top: 22, width: 17, height: 34 }],
    ['splash', { className: 'kit-cymbal kit-small', left: 33, top: 11, width: 11, height: 23 }],
    ['china', { className: 'kit-cymbal kit-small', left: 85, top: 13, width: 11, height: 23 }],
    ['ride', { className: 'kit-cymbal', left: 74, top: 19, width: 18, height: 36 }],
    ['ride-edge', { className: 'kit-cymbal kit-small', left: 84, top: 44, width: 12, height: 24 }],
    ['ride-bell', { className: 'kit-cymbal kit-small', left: 66, top: 7, width: 12, height: 24 }],
    ['high-tom', { className: 'kit-drum kit-tom', left: 34, top: 28, width: 14, height: 28 }],
    ['mid-tom', { className: 'kit-drum kit-tom', left: 52, top: 28, width: 14, height: 28 }],
    ['low-tom', { className: 'kit-drum kit-tom', left: 63, top: 58, width: 14, height: 28 }],
    ['floor-tom', { className: 'kit-drum kit-tom', left: 72, top: 58, width: 14, height: 28 }],
    ['kick', { className: 'kit-drum kit-kick', left: 44, top: 54, width: 15, height: 31 }],
    ['snare', { className: 'kit-drum kit-snare', left: 31, top: 61, width: 15, height: 30 }],
    ['sidestick', { className: 'kit-drum kit-snare kit-small', left: 23, top: 72, width: 11, height: 22 }],
    ['snare-rimshot', { className: 'kit-drum kit-snare kit-small', left: 40, top: 76, width: 11, height: 22 }],
    ['closed-hihat', { className: 'kit-cymbal kit-hihat', left: 15, top: 57, width: 13, height: 26 }],
    ['open-hihat', { className: 'kit-cymbal kit-hihat kit-small', left: 7, top: 49, width: 11, height: 22 }],
    ['pedal-hihat', { className: 'kit-cymbal kit-hihat kit-small', left: 7, top: 73, width: 11, height: 22 }],
    ['half-open-hihat', { className: 'kit-cymbal kit-hihat kit-small', left: 25, top: 49, width: 11, height: 22 }]
]);

const povSlotsByPartId = new Map<string, KitLayoutSlot>([
    ['crash-1', { className: 'kit-cymbal kit-pov-cymbal kit-pov-left', left: 8, top: 6, width: 23, height: 24 }],
    ['crash-2', { className: 'kit-cymbal kit-pov-cymbal kit-pov-right', left: 77, top: 9, width: 21, height: 22 }],
    ['splash', { className: 'kit-cymbal kit-pov-cymbal kit-pov-left kit-small', left: 34, top: 5, width: 14, height: 16 }],
    ['china', { className: 'kit-cymbal kit-pov-cymbal kit-pov-right kit-small', left: 84, top: 4, width: 14, height: 16 }],
    ['ride', { className: 'kit-cymbal kit-pov-cymbal kit-pov-right', left: 68, top: 13, width: 27, height: 27 }],
    ['ride-edge', { className: 'kit-cymbal kit-pov-cymbal kit-pov-right kit-small', left: 82, top: 32, width: 15, height: 16 }],
    ['ride-bell', { className: 'kit-cymbal kit-pov-cymbal kit-pov-right kit-small', left: 64, top: 4, width: 15, height: 16 }],
    ['high-tom', { className: 'kit-drum kit-tom kit-pov-tom', left: 31, top: 30, width: 20, height: 27 }],
    ['mid-tom', { className: 'kit-drum kit-tom kit-pov-tom', left: 50, top: 30, width: 20, height: 27 }],
    ['low-tom', { className: 'kit-drum kit-tom kit-pov-floor', left: 63, top: 58, width: 21, height: 32 }],
    ['floor-tom', { className: 'kit-drum kit-tom kit-pov-floor', left: 73, top: 56, width: 22, height: 34 }],
    ['kick', { className: 'kit-drum kit-kick kit-pov-kick', left: 39, top: 52, width: 27, height: 42 }],
    ['snare', { className: 'kit-drum kit-snare kit-pov-snare', left: 22, top: 57, width: 25, height: 34 }],
    ['sidestick', { className: 'kit-drum kit-snare kit-pov-snare kit-small', left: 16, top: 67, width: 15, height: 20 }],
    ['snare-rimshot', { className: 'kit-drum kit-snare kit-pov-snare kit-small', left: 37, top: 72, width: 15, height: 20 }],
    ['closed-hihat', { className: 'kit-cymbal kit-hihat kit-pov-hihat kit-pov-left', left: 6, top: 40, width: 24, height: 24 }],
    ['open-hihat', { className: 'kit-cymbal kit-hihat kit-pov-hihat kit-pov-left kit-small', left: 3, top: 29, width: 16, height: 17 }],
    ['pedal-hihat', { className: 'kit-cymbal kit-hihat kit-pov-hihat kit-pov-left kit-small', left: 8, top: 68, width: 16, height: 17 }],
    ['half-open-hihat', { className: 'kit-cymbal kit-hihat kit-pov-hihat kit-pov-left kit-small', left: 21, top: 31, width: 16, height: 17 }]
]);

const kitSlotsByGroup = new Map<DrumPart['group'], KitLayoutSlot>([
    ['kick', { className: 'kit-drum kit-kick', left: 44, top: 54, width: 15, height: 31 }],
    ['snare', { className: 'kit-drum kit-snare', left: 31, top: 61, width: 15, height: 30 }],
    ['hihat', { className: 'kit-cymbal kit-hihat', left: 15, top: 57, width: 13, height: 26 }],
    ['tom', { className: 'kit-drum kit-tom', left: 63, top: 58, width: 14, height: 28 }],
    ['cymbal', { className: 'kit-cymbal', left: 74, top: 19, width: 18, height: 36 }],
    ['percussion', { className: 'kit-drum kit-percussion kit-small', left: 88, top: 69, width: 11, height: 22 }],
    ['unknown', { className: 'kit-drum kit-unknown kit-small', left: 88, top: 69, width: 11, height: 22 }]
]);

const povSlotsByGroup = new Map<DrumPart['group'], KitLayoutSlot>([
    ['kick', { className: 'kit-drum kit-kick kit-pov-kick', left: 39, top: 52, width: 27, height: 42 }],
    ['snare', { className: 'kit-drum kit-snare kit-pov-snare', left: 22, top: 57, width: 25, height: 34 }],
    ['hihat', { className: 'kit-cymbal kit-hihat kit-pov-hihat kit-pov-left', left: 6, top: 40, width: 24, height: 24 }],
    ['tom', { className: 'kit-drum kit-tom kit-pov-floor', left: 63, top: 58, width: 21, height: 32 }],
    ['cymbal', { className: 'kit-cymbal kit-pov-cymbal kit-pov-right', left: 68, top: 13, width: 27, height: 27 }],
    ['percussion', { className: 'kit-drum kit-percussion kit-pov-small', left: 86, top: 66, width: 14, height: 20 }],
    ['unknown', { className: 'kit-drum kit-unknown kit-pov-small', left: 86, top: 66, width: 14, height: 20 }]
]);

function getKitSlot(
    part: DrumPart,
    perspective: DrumKitPerspective,
    fallbackSlotCounts: Map<DrumPart['group'], number>
): KitLayoutSlot {
    const slotsByPartId = perspective === 'pov' ? povSlotsByPartId : kitSlotsByPartId;
    const slotsByGroup = perspective === 'pov' ? povSlotsByGroup : kitSlotsByGroup;
    const slot = slotsByPartId.get(part.id);
    if (slot) {
        return slot;
    }

    const groupSlot = slotsByGroup.get(part.group) ?? slotsByGroup.get('unknown')!;
    const slotCount = fallbackSlotCounts.get(part.group) ?? 0;
    fallbackSlotCounts.set(part.group, slotCount + 1);

    return {
        ...groupSlot,
        left: Math.min(groupSlot.left + slotCount * 7, 90),
        top: Math.min(groupSlot.top + slotCount * 8, 78)
    };
}
