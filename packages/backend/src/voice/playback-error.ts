/**
 * A track cannot be started. The message is written for the user and never
 * contains a file path, a URL or a credential: it is shown in the interface.
 */
export class PlaybackStartError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PlaybackStartError';
  }
}

/** ffmpeg ended with an error before any audio came (file missing or unreadable). */
export const MSG_TRACK_UNREADABLE = 'The track could not be read. Check that the file is still there.';
/** ffmpeg ended with an error before any audio came while reading from Navidrome. */
export const MSG_NAVIDROME_NO_AUDIO = 'Navidrome did not deliver the track. Check that Navidrome is running and its settings are correct.';
