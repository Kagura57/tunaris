import type { MusicTrack } from "./music-types";

function hasText(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0;
}

export function hasAudioPreview(track: Pick<MusicTrack, "previewUrl">) {
  return hasText(track.previewUrl);
}

export function hasYouTubePlayback(track: Pick<MusicTrack, "provider" | "sourceUrl">) {
  if (track.provider === "youtube") return true;
  if (!hasText(track.sourceUrl)) return false;
  const source = track.sourceUrl?.toLowerCase() ?? "";
  return source.includes("youtube.com/watch") || source.includes("youtu.be/");
}

export function hasAnimeThemesPlayback(track: Pick<MusicTrack, "provider" | "sourceUrl">) {
  if (track.provider === "animethemes") return true;
  if (!hasText(track.sourceUrl)) return false;
  const source = track.sourceUrl?.toLowerCase() ?? "";
  return source.includes("animethemes.moe/") || source.endsWith(".webm");
}

export function isTrackPlayable(track: Pick<MusicTrack, "provider" | "previewUrl" | "sourceUrl">) {
  return hasYouTubePlayback(track) || hasAnimeThemesPlayback(track);
}
