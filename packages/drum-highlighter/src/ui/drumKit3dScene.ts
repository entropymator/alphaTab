import * as THREE from 'three';
import type { DrumPart } from '../drums/drumTypes';

interface KitObject {
    group: THREE.Group;
    label: HTMLElement;
    material: THREE.MeshStandardMaterial;
}

interface Kit3dSlot {
    kind: 'cymbal' | 'drum' | 'kick';
    position: [number, number, number];
    rotation?: [number, number, number];
    scale: [number, number, number];
}

export class DrumKit3dScene {
    private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    private readonly highlighted = new Map<string, number>();
    private readonly labelsLayer: HTMLElement;
    private readonly objects = new Map<string, KitObject>();
    private readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    private readonly resizeObserver: ResizeObserver;
    private readonly scene = new THREE.Scene();
    private animationFrame = 0;
    private parts: DrumPart[] = [];

    constructor(private readonly stage: HTMLElement) {
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.domElement.className = 'kit-3d-canvas';

        this.labelsLayer = document.createElement('div');
        this.labelsLayer.className = 'kit-3d-labels';

        this.stage.append(this.renderer.domElement, this.labelsLayer);
        this.resizeObserver = new ResizeObserver(() => this.resize());

        this.setupScene();
        this.resize();
    }

    clearHighlights(): void {
        this.highlighted.clear();
        for (const object of this.objects.values()) {
            object.group.scale.set(1, 1, 1);
            object.material.emissive.setHex(0x000000);
            object.label.classList.remove('kit-3d-label-hit');
        }
    }

    dispose(): void {
        cancelAnimationFrame(this.animationFrame);
        this.resizeObserver.disconnect();
        this.renderer.dispose();
        this.renderer.domElement.remove();
        this.labelsLayer.remove();
    }

    hide(): void {
        this.renderer.domElement.hidden = true;
        this.labelsLayer.hidden = true;
        this.resizeObserver.unobserve(this.stage);
        cancelAnimationFrame(this.animationFrame);
        this.animationFrame = 0;
    }

    highlight(partIds: Set<string>): void {
        const now = performance.now();
        for (const partId of partIds) {
            const object = this.objects.get(partId);
            if (!object) {
                continue;
            }

            this.highlighted.set(partId, now + 190);
            object.group.scale.set(1.12, 1.12, 1.12);
            object.material.emissive.setHex(0x315fba);
            object.label.classList.add('kit-3d-label-hit');
        }
    }

    setParts(parts: DrumPart[]): void {
        this.parts = parts;
        this.renderKit();
    }

    show(): void {
        this.renderer.domElement.hidden = false;
        this.labelsLayer.hidden = false;
        this.resizeObserver.observe(this.stage);
        this.resize();
        this.start();
    }

    private addCymbal(part: DrumPart, slot: Kit3dSlot): void {
        const group = new THREE.Group();
        group.position.set(...slot.position);
        group.rotation.set(...(slot.rotation ?? [0, 0, 0]));

        const material = new THREE.MeshStandardMaterial({
            color: 0xf2c230,
            emissive: 0x000000,
            metalness: 0.42,
            roughness: 0.34
        });
        const cymbal = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.84, 0.055, 48), material);
        cymbal.castShadow = true;
        cymbal.receiveShadow = true;
        cymbal.scale.set(...slot.scale);
        group.add(cymbal);

        const bell = new THREE.Mesh(new THREE.SphereGeometry(0.16, 24, 12), material);
        bell.position.y = 0.055;
        bell.scale.set(1, 0.32, 1);
        group.add(bell);

        this.addStand(slot.position[0], slot.position[2], slot.position[1] - 0.08);
        this.addObject(part, group, material, new THREE.Vector3(0, 0.32, 0));
    }

    private addDrum(part: DrumPart, slot: Kit3dSlot): void {
        const group = new THREE.Group();
        group.position.set(...slot.position);
        group.rotation.set(...(slot.rotation ?? [0, 0, 0]));

        const material = new THREE.MeshStandardMaterial({
            color: getShellColor(part.group),
            emissive: 0x000000,
            metalness: 0.18,
            roughness: 0.46
        });
        const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.64, 0.48, 48), material);
        shell.castShadow = true;
        shell.receiveShadow = true;
        shell.scale.set(...slot.scale);
        group.add(shell);

        const headMaterial = new THREE.MeshStandardMaterial({
            color: 0xf4f7f9,
            metalness: 0.05,
            roughness: 0.52
        });
        const head = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.035, 48), headMaterial);
        head.position.y = 0.26 * slot.scale[1];
        head.scale.set(slot.scale[0], 1, slot.scale[2]);
        group.add(head);

        this.addObject(part, group, material, new THREE.Vector3(0, 0.52, 0));
    }

    private addKick(part: DrumPart, slot: Kit3dSlot): void {
        const group = new THREE.Group();
        group.position.set(...slot.position);
        group.rotation.set(Math.PI / 2, 0, 0);

        const material = new THREE.MeshStandardMaterial({
            color: 0x182231,
            emissive: 0x000000,
            metalness: 0.22,
            roughness: 0.42
        });
        const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.86, 0.86, 0.62, 56), material);
        shell.castShadow = true;
        shell.receiveShadow = true;
        shell.scale.set(...slot.scale);
        group.add(shell);

        const ring = new THREE.Mesh(
            new THREE.TorusGeometry(0.72 * slot.scale[0], 0.035, 12, 56),
            new THREE.MeshStandardMaterial({ color: 0xced7df, metalness: 0.34, roughness: 0.28 })
        );
        ring.position.y = 0.34 * slot.scale[1];
        group.add(ring);

        this.addObject(part, group, material, new THREE.Vector3(0, 0.86, 0.15));
    }

    private addObject(
        part: DrumPart,
        group: THREE.Group,
        material: THREE.MeshStandardMaterial,
        labelOffset: THREE.Vector3
    ): void {
        const label = document.createElement('span');
        label.className = 'kit-3d-label';
        label.textContent = part.displayName;
        this.labelsLayer.append(label);
        group.userData.labelOffset = labelOffset;
        this.scene.add(group);
        this.objects.set(part.id, { group, label, material });
    }

    private addStand(x: number, z: number, topY: number): void {
        const material = new THREE.MeshStandardMaterial({ color: 0xaeb9c2, metalness: 0.65, roughness: 0.3 });
        const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, Math.max(topY + 0.1, 0.1), 10), material);
        stand.position.set(x, topY / 2, z);
        stand.castShadow = true;
        this.scene.add(stand);
    }

    private renderKit(): void {
        for (const object of this.objects.values()) {
            this.scene.remove(object.group);
            object.label.remove();
        }
        this.objects.clear();
        this.highlighted.clear();

        const visibleParts = this.parts.length > 0 ? this.parts : fallbackParts3d;
        const fallbackSlotCounts = new Map<DrumPart['group'], number>();
        for (const part of visibleParts) {
            const slot = get3dSlot(part, fallbackSlotCounts);
            if (slot.kind === 'cymbal') {
                this.addCymbal(part, slot);
            } else if (slot.kind === 'kick') {
                this.addKick(part, slot);
            } else {
                this.addDrum(part, slot);
            }
        }

        this.render();
    }

    private render(): void {
        this.updateHighlights();
        this.updateLabels();
        this.renderer.render(this.scene, this.camera);
    }

    private resize(): void {
        const width = Math.max(this.stage.clientWidth, 1);
        const height = Math.max(this.stage.clientHeight, 1);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height, false);
        this.render();
    }

    private setupScene(): void {
        this.scene.background = null;
        this.camera.position.set(0, 2.1, 5.7);
        this.camera.lookAt(0, 0.75, 0);

        const ambient = new THREE.HemisphereLight(0xffffff, 0xc4d0d8, 2.2);
        this.scene.add(ambient);

        const key = new THREE.DirectionalLight(0xffffff, 3.4);
        key.position.set(-2.5, 5, 4);
        key.castShadow = true;
        this.scene.add(key);

        const floor = new THREE.Mesh(
            new THREE.CircleGeometry(4.6, 64),
            new THREE.MeshStandardMaterial({ color: 0xdfe7ec, roughness: 0.78 })
        );
        floor.rotation.x = -Math.PI / 2;
        floor.position.y = -0.03;
        floor.position.z = -0.2;
        floor.receiveShadow = true;
        this.scene.add(floor);
    }

    private start(): void {
        if (this.animationFrame !== 0) {
            return;
        }

        const tick = () => {
            this.animationFrame = requestAnimationFrame(tick);
            this.render();
        };
        tick();
    }

    private updateHighlights(): void {
        const now = performance.now();
        for (const [partId, expiresAt] of this.highlighted) {
            const object = this.objects.get(partId);
            if (!object) {
                this.highlighted.delete(partId);
                continue;
            }

            if (expiresAt <= now) {
                object.group.scale.lerp(new THREE.Vector3(1, 1, 1), 0.32);
                object.material.emissive.lerp(new THREE.Color(0x000000), 0.36);
                object.label.classList.remove('kit-3d-label-hit');
                if (Math.abs(object.group.scale.x - 1) < 0.01) {
                    object.group.scale.set(1, 1, 1);
                    object.material.emissive.setHex(0x000000);
                    this.highlighted.delete(partId);
                }
            }
        }
    }

    private updateLabels(): void {
        const width = this.stage.clientWidth;
        const height = this.stage.clientHeight;
        const projection = new THREE.Vector3();
        for (const object of this.objects.values()) {
            projection.copy(object.group.position).add(object.group.userData.labelOffset).project(this.camera);
            object.label.style.left = `${(projection.x * 0.5 + 0.5) * width}px`;
            object.label.style.top = `${(-projection.y * 0.5 + 0.5) * height}px`;
        }
    }
}

const fallbackParts3d: DrumPart[] = [
    { id: 'crash-1', displayName: 'Crash', group: 'cymbal', aliases: [] },
    { id: 'high-tom', displayName: 'High tom', group: 'tom', aliases: [] },
    { id: 'kick', displayName: 'Kick', group: 'kick', aliases: [] },
    { id: 'mid-tom', displayName: 'Mid tom', group: 'tom', aliases: [] },
    { id: 'ride', displayName: 'Ride', group: 'cymbal', aliases: [] },
    { id: 'closed-hihat', displayName: 'Hi-hat', group: 'hihat', aliases: [] },
    { id: 'snare', displayName: 'Snare', group: 'snare', aliases: [] },
    { id: 'floor-tom', displayName: 'Floor tom', group: 'tom', aliases: [] }
];

const slotsByPartId = new Map<string, Kit3dSlot>([
    ['kick', { kind: 'kick', position: [0, 0.42, 0.45], scale: [1.08, 1, 1.08] }],
    ['snare', { kind: 'drum', position: [-1.05, 0.55, 1.05], rotation: [0.1, 0.1, -0.04], scale: [0.82, 0.62, 0.82] }],
    ['high-tom', { kind: 'drum', position: [-0.55, 0.98, 0.03], rotation: [-0.15, 0, -0.08], scale: [0.72, 0.58, 0.72] }],
    ['mid-tom', { kind: 'drum', position: [0.55, 0.98, 0.03], rotation: [-0.15, 0, 0.08], scale: [0.72, 0.58, 0.72] }],
    ['low-tom', { kind: 'drum', position: [1.35, 0.62, 0.9], rotation: [0.05, -0.18, 0.08], scale: [0.88, 0.78, 0.88] }],
    ['floor-tom', { kind: 'drum', position: [1.68, 0.62, 0.92], rotation: [0.05, -0.18, 0.08], scale: [0.92, 0.82, 0.92] }],
    ['closed-hihat', { kind: 'cymbal', position: [-1.95, 1.38, 0.7], rotation: [0.18, 0.2, -0.16], scale: [0.78, 1, 0.46] }],
    ['open-hihat', { kind: 'cymbal', position: [-2.1, 1.52, 0.45], rotation: [0.18, 0.2, -0.2], scale: [0.6, 1, 0.36] }],
    ['half-open-hihat', { kind: 'cymbal', position: [-1.72, 1.55, 0.42], rotation: [0.18, 0.2, -0.12], scale: [0.6, 1, 0.36] }],
    ['pedal-hihat', { kind: 'cymbal', position: [-2.05, 0.62, 1.36], rotation: [0.18, 0.2, -0.16], scale: [0.48, 1, 0.28] }],
    ['crash-1', { kind: 'cymbal', position: [-1.62, 2.15, -0.55], rotation: [0.05, 0.1, -0.28], scale: [0.92, 1, 0.56] }],
    ['crash-2', { kind: 'cymbal', position: [1.85, 2.08, -0.45], rotation: [0.06, -0.18, 0.26], scale: [0.88, 1, 0.52] }],
    ['ride', { kind: 'cymbal', position: [2.0, 1.62, 0.42], rotation: [0.12, -0.22, 0.18], scale: [1.02, 1, 0.6] }],
    ['ride-edge', { kind: 'cymbal', position: [2.22, 1.36, 0.95], rotation: [0.12, -0.22, 0.18], scale: [0.62, 1, 0.36] }],
    ['ride-bell', { kind: 'cymbal', position: [1.45, 2.2, -0.72], rotation: [0.06, -0.18, 0.18], scale: [0.54, 1, 0.32] }],
    ['splash', { kind: 'cymbal', position: [-0.08, 2.05, -0.8], rotation: [0.05, 0, 0], scale: [0.54, 1, 0.32] }],
    ['china', { kind: 'cymbal', position: [2.35, 2.05, -0.7], rotation: [0.08, -0.25, 0.28], scale: [0.62, 1, 0.36] }],
    ['sidestick', { kind: 'drum', position: [-1.45, 0.42, 1.2], rotation: [0.1, 0.15, -0.04], scale: [0.48, 0.35, 0.48] }],
    ['snare-rimshot', { kind: 'drum', position: [-0.72, 0.42, 1.24], rotation: [0.1, 0.1, -0.04], scale: [0.48, 0.35, 0.48] }]
]);

const slotsByGroup = new Map<DrumPart['group'], Kit3dSlot>([
    ['kick', slotsByPartId.get('kick')!],
    ['snare', slotsByPartId.get('snare')!],
    ['hihat', slotsByPartId.get('closed-hihat')!],
    ['tom', slotsByPartId.get('floor-tom')!],
    ['cymbal', slotsByPartId.get('ride')!],
    ['percussion', { kind: 'drum', position: [2.35, 0.48, 1.28], rotation: [0, 0, 0], scale: [0.5, 0.42, 0.5] }],
    ['unknown', { kind: 'drum', position: [2.35, 0.48, 1.28], rotation: [0, 0, 0], scale: [0.5, 0.42, 0.5] }]
]);

function get3dSlot(part: DrumPart, fallbackSlotCounts: Map<DrumPart['group'], number>): Kit3dSlot {
    const slot = slotsByPartId.get(part.id);
    if (slot) {
        return slot;
    }

    const groupSlot = slotsByGroup.get(part.group) ?? slotsByGroup.get('unknown')!;
    const slotCount = fallbackSlotCounts.get(part.group) ?? 0;
    fallbackSlotCounts.set(part.group, slotCount + 1);

    return {
        ...groupSlot,
        position: [groupSlot.position[0] + slotCount * 0.32, groupSlot.position[1], groupSlot.position[2] + slotCount * 0.16]
    };
}

function getShellColor(group: DrumPart['group']): number {
    switch (group) {
        case 'snare':
            return 0xb8c4cd;
        case 'tom':
            return 0x8f1f2d;
        case 'percussion':
        case 'unknown':
            return 0x7057b8;
        default:
            return 0x9a1f2d;
    }
}
