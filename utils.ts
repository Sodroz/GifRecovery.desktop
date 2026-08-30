/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface MediaInfo {
    extension: "gif" | "webp" | "mp4" | "webm";
    type: "image/gif" | "image/webp" | "video/mp4" | "video/webm";
}

export function getPickerCandidateUrls(item: unknown, renderedSrc?: string): string[] {
    const candidates: string[] = [];
    if (renderedSrc) candidates.push(renderedSrc);
    if (typeof item !== "object" || item === null) return candidates;
    const { src, url, name, type } = item as Record<string, unknown>;
    // Category/collection tiles ("Laugh", "Hug", GifCollections covers) carry a
    // name/type and a cover src but no url, so they are not recoverable GIF items.
    if (typeof url !== "string" && (typeof name === "string" || typeof type === "string")) return [];
    if (typeof src === "string" && !candidates.includes(src)) candidates.push(src);
    if (typeof url === "string" && !candidates.includes(url)) candidates.push(url);
    return candidates;
}

export function makeRecoveredFilename(url: string, extension: MediaInfo["extension"]): string {
    const parsed = URL.parse(url);
    let name = "recovered";
    if (parsed) {
        const raw = parsed.pathname.split("/").pop() || name;
        try {
            name = decodeURIComponent(raw);
        } catch {
            name = raw;
        }
        const dot = name.lastIndexOf(".");
        if (dot > 0) name = name.slice(0, dot);
        name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "recovered";
    }
    return `${name}.${extension}`;
}

function matches(data: Uint8Array, offset: number, value: string): boolean {
    if (data.length < offset + value.length) return false;
    for (let i = 0; i < value.length; i++) {
        if (data[offset + i] !== value.charCodeAt(i)) return false;
    }
    return true;
}

// Walks RIFF chunks (id + u32 size + payload [+ 1 padding byte]) instead of
// scanning raw pixel data, where the bytes "ANIM" could appear by coincidence.
function webpIsAnimated(data: Uint8Array): boolean {
    let offset = 12;
    while (offset + 8 <= data.length) {
        if (matches(data, offset, "ANIM") || matches(data, offset, "ANMF")) return true;
        const size = data[offset + 4] | (data[offset + 5] << 8) | (data[offset + 6] << 16) | (data[offset + 7] << 24);
        if (size < 0 || offset + 8 + size > data.length) return false;
        offset += 8 + size + (size & 1);
    }
    return false;
}

export function detectMedia(data: Uint8Array): MediaInfo | null {
    if (matches(data, 0, "GIF87a") || matches(data, 0, "GIF89a"))
        return { extension: "gif", type: "image/gif" };
    if (matches(data, 0, "RIFF") && matches(data, 8, "WEBP") && webpIsAnimated(data))
        return { extension: "webp", type: "image/webp" };
    if (matches(data, 4, "ftyp"))
        return { extension: "mp4", type: "video/mp4" };
    if (data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3)
        return { extension: "webm", type: "video/webm" };
    return null;
}
