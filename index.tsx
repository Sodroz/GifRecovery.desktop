/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Paragraph } from "@components/Paragraph";
import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";
import { saveFile } from "@utils/web";
import { ChannelStore, DraftType, Menu, SelectedChannelStore, showToast, Toasts, UploadHandler } from "@webpack/common";

import type { RecoveryResult } from "./native";
import { detectMedia, getPickerCandidateUrls, makeRecoveredFilename, MediaInfo } from "./utils";

const Native = VencordNative.pluginHelpers.GifRecovery as PluginNative<typeof import("./native")> | undefined;
const logger = new Logger("GifRecovery");
const recovering = new Set<string>();
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

type RecoveryAction = "download" | "attach";
interface RecoveredMedia {
    data: Uint8Array;
    media: MediaInfo;
    source: string;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message.slice(0, 160) : "Unknown error";
}

function getRenderedSrc(target: EventTarget | null): string | undefined {
    if (!(target instanceof Element)) return;
    // Right-clicks land on hover overlays inside the media card — closest()
    // finds the enclosing <img>/<video>, querySelector() the child if any.
    const media = target.matches("img, video")
        ? target
        : target.closest("img, video") ?? target.querySelector("img, video");
    if (!(media instanceof HTMLImageElement || media instanceof HTMLVideoElement)) return;
    return media.currentSrc || media.src || undefined;
}

async function readBody(response: Response): Promise<Uint8Array | null> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MEDIA_BYTES) return null;
    if (!response.body) return null;

    // Stream and enforce the cap while reading — arrayBuffer() alone would
    // allocate unbounded memory for a body without a Content-Length header.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_MEDIA_BYTES) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }

    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return data;
}

async function recoverFromRenderer(candidates: string[]): Promise<RecoveredMedia | null> {
    for (const source of candidates) {
        try {
            const response = await fetch(source, { cache: "force-cache", credentials: "omit" });
            if (!response.ok) continue;

            const data = await readBody(response);
            if (!data) continue;
            const media = detectMedia(data);
            if (media) return { data, media, source };
        } catch {
            continue;
        }
    }
    return null;
}

async function recoverFile(candidates: string[]): Promise<File | null> {
    let recovered = await recoverFromRenderer(candidates);

    if (!recovered) {
        const nativeCandidates = candidates.filter(candidate => URL.parse(candidate)?.protocol === "https:").slice(0, 2);
        if (!Native?.recoverCachedMedia) {
            showToast("GifRecovery's native cache bridge is unavailable. Fully restart Discord.", Toasts.Type.FAILURE);
            return null;
        }

        const result: RecoveryResult = await Native.recoverCachedMedia(nativeCandidates);
        if (!result.success) {
            showToast(result.error, Toasts.Type.FAILURE);
            return null;
        }

        const data = new Uint8Array(result.data);
        const media = detectMedia(data);
        if (!media) {
            showToast("The cached response is not recoverable animated media.", Toasts.Type.FAILURE);
            return null;
        }
        recovered = { data, media, source: result.source };
    }

    const filenameSource = candidates.at(-1) ?? recovered.source;
    return new File(
        [new Uint8Array(recovered.data).buffer],
        makeRecoveredFilename(filenameSource, recovered.media.extension),
        { type: recovered.media.type }
    );
}

async function recover(candidates: string[], action: RecoveryAction) {
    const key = candidates[0];
    if (!key || recovering.has(key)) {
        if (key) showToast("This GIF is already being recovered.", Toasts.Type.MESSAGE);
        return;
    }

    recovering.add(key);
    try {
        const file = await recoverFile(candidates);
        if (!file) return;

        if (action === "download") {
            saveFile(file);
            showToast("Recovered GIF downloaded.", Toasts.Type.SUCCESS);
            return;
        }

        const channel = ChannelStore.getChannel(SelectedChannelStore.getChannelId());
        if (!channel) {
            showToast("Open a channel before attaching the recovered GIF.", Toasts.Type.FAILURE);
            return;
        }

        await UploadHandler.promptToUpload([file], channel, DraftType.ChannelMessage);
        showToast("Recovered GIF attached to the current draft.", Toasts.Type.SUCCESS);
    } catch (error) {
        logger.error("Recovery failed", error);
        showToast(`GIF recovery failed: ${getErrorMessage(error)}`, Toasts.Type.FAILURE);
    } finally {
        recovering.delete(key);
    }
}

function SettingsAbout() {
    return (
        <Paragraph>
            Right-click a GIF in Discord's GIF picker, choose Recover GIF, then download it or attach it to the current channel. The attachment option adds the recovered file to your draft and does not send it automatically.
        </Paragraph>
    );
}

export default definePlugin({
    name: "GifRecovery",
    description: "Recovers animated media still present in Discord's caches.",
    authors: [{ name: "Sodroz", id: 145188106289545216n }],
    tags: ["Utility"],
    settingsAboutComponent: SettingsAbout,
    gifPickerContextMenu(instance, event) {
        const item: unknown = instance?.props?.item;
        const candidates = getPickerCandidateUrls(item, getRenderedSrc(event.target));
        if (candidates.length === 0) return null;

        return (
            <Menu.MenuItem id="gif-recovery" key="gif-recovery" label="Recover GIF">
                <Menu.MenuItem
                    id="gif-recovery-download"
                    key="gif-recovery-download"
                    label="Download recovered file"
                    action={() => void recover(candidates, "download")}
                />
                <Menu.MenuItem
                    id="gif-recovery-attach"
                    key="gif-recovery-attach"
                    label="Attach to current channel"
                    action={() => void recover(candidates, "attach")}
                />
            </Menu.MenuItem>
        );
    }
});
