/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IpcMainInvokeEvent, Session } from "electron";

const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DISCORD_HOSTS = new Set([
    "cdn.discordapp.com",
    "media.discordapp.net",
    "images-ext-1.discordapp.net",
    "images-ext-2.discordapp.net"
]);
const MEDIA_DOMAINS = ["tenor.com", "giphy.com", "klipy.com"];

export type RecoveryResult =
    | { success: true; data: Uint8Array; source: string; }
    | { success: false; error: string; };

function parseAllowedUrl(value: string): URL | null {
    if (value.length > 8192) return null;
    const url = URL.parse(value);
    if (!url || url.protocol !== "https:") return null;

    const host = url.hostname.toLowerCase();
    if (DISCORD_HOSTS.has(host)) return url;
    if (MEDIA_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`))) return url;
    return null;
}

async function readBody(response: Response): Promise<Uint8Array | null> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MEDIA_BYTES) return null;
    if (!response.body) return null;

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

async function fetchCached(session: Session, initialUrl: URL): Promise<{ data: Uint8Array; source: string; } | null> {
    let url = initialUrl;

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        const response = await session.fetch(url.toString(), {
            cache: "only-if-cached",
            credentials: "omit",
            mode: "same-origin",
            redirect: "manual"
        });

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            const redirected = location && parseAllowedUrl(new URL(location, url).toString());
            if (!redirected) return null;
            url = redirected;
            continue;
        }

        if (!response.ok) return null;
        const data = await readBody(response);
        return data ? { data, source: url.toString() } : null;
    }

    return null;
}

export async function recoverCachedMedia(event: IpcMainInvokeEvent, candidates: string[]): Promise<RecoveryResult> {
    if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > 2)
        return { success: false, error: "Invalid recovery request." };

    for (const candidate of candidates) {
        if (typeof candidate !== "string") return { success: false, error: "Invalid recovery request." };
        const url = parseAllowedUrl(candidate);
        if (!url) continue;

        try {
            const recovered = await fetchCached(event.sender.session, url);
            if (recovered) return { success: true, ...recovered };
        } catch {
            continue;
        }
    }

    return { success: false, error: "The media is not present in Discord's HTTP cache." };
}
