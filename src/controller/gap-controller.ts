import { BufferHelper } from "../utils/buffer-helper";
import { ErrorTypes, ErrorDetails } from "../errors";
import Event from "../events";
import { logger } from "../utils/logger";
import { HlsConfig } from "../config";
import Hls from "../hls";
import Fragment from "../loader/fragment";

const stallDebounceInterval: number = 1000;
const jumpThreshold: number = 0.5; // tolerance needed as some browsers stalls playback before reaching buffered range end

export default class GapController {
  config: HlsConfig;
  media: any;
  fragmentTracker: any;
  hls: Hls;
  stallReported: boolean;
  stalled: number | null = null;
  nudgeRetry: number = 0;

  constructor(config: HlsConfig, media: any, fragmentTracker: any, hls: Hls) {
    this.config = config;
    this.media = media;
    this.fragmentTracker = fragmentTracker;
    this.hls = hls;
    this.stallReported = false;
  }

  /**
   * Checks if the playhead is stuck within a gap, and if so, attempts to free it.
   * A gap is an unbuffered range between two buffered ranges (or the start and the first buffered range).
   * @param lastCurrentTime
   * @param buffered
   */
  poll(lastCurrentTime: number, buffered: any): void {
    const { config, media } = this;
    const currentTime = media.currentTime;
    const tnow = window.performance.now();
    const stalledDuration =
      typeof this.stalled === "number" ? tnow - this.stalled : 0;

    if (currentTime !== lastCurrentTime) {
      // The playhead is now moving, but was previously stalled
      if (this.stallReported) {
        logger.warn(
          `playback not stuck anymore @${currentTime}, after ${Math.round(
            stalledDuration
          )}ms`
        );
        this.stallReported = false;
      }
      this.stalled = null;
      this.nudgeRetry = 0;
      return;
    }

    if (media.ended || !media.buffered.length || media.readyState > 2) {
      return;
    }

    if (media.seeking && BufferHelper.isBuffered(media, currentTime)) {
      return;
    }

    // The playhead isn't moving but it should be
    // Allow some slack time to for small stalls to resolve themselves
    const bufferInfo = BufferHelper.bufferInfo(
      media,
      currentTime,
      config.maxBufferHole
    );
    if (!this.stalled) {
      this.stalled = tnow;
      return;
    } else if (stalledDuration >= stallDebounceInterval) {
      // Report stalling after trying to fix
      this._reportStall(bufferInfo.len);
    }

    this._tryFixBufferStall(bufferInfo, stalledDuration);
  }

  /**
   * Detects and attempts to fix known buffer stalling issues.
   * @param bufferInfo - The properties of the current buffer.
   * @param stalledDuration - The amount of time Hls.js has been stalling for.
   * @private
   */
  _tryFixBufferStall(bufferInfo: any, stalledDuration: number): void {
    const { config, fragmentTracker, media } = this;
    const currentTime = media.currentTime;

    const partial = fragmentTracker.getPartialFragment(currentTime);
    if (partial) {
      // Try to skip over the buffer hole caused by a partial fragment
      // This method isn't limited by the size of the gap between buffered ranges
      this._trySkipBufferHole(partial);
    }

    if (
      bufferInfo.len > jumpThreshold &&
      stalledDuration > config.highBufferWatchdogPeriod * 1000
    ) {
      // Try to nudge currentTime over a buffer hole if we've been stalling for the configured amount of seconds
      // We only try to jump the hole if it's under the configured size
      // Reset stalled so to rearm watchdog timer
      this.stalled = null;
      this._tryNudgeBuffer();
    }
  }

  /**
   * Triggers a BUFFER_STALLED_ERROR event, but only once per stall period.
   * @param bufferLen - The playhead distance from the end of the current buffer segment.
   * @private
   */
  _reportStall(bufferLen: number): void {
    const { hls, media, stallReported } = this;
    if (!stallReported) {
      // Report stalled error once
      this.stallReported = true;
      logger.warn(
        `Playback stalling at @${media.currentTime} due to low buffer`
      );
      hls.trigger(Event.ERROR, {
        type: ErrorTypes.MEDIA_ERROR,
        details: ErrorDetails.BUFFER_STALLED_ERROR,
        fatal: false,
        buffer: bufferLen
      });
    }
  }

  /**
   * Attempts to fix buffer stalls by jumping over known gaps caused by partial fragments
   * @param partial - The partial fragment found at the current time (where playback is stalling).
   * @private
   */
  _trySkipBufferHole(partial: Fragment): void {
    const { hls, media } = this;
    const currentTime = media.currentTime;
    let lastEndTime = 0;
    // Check if currentTime is between unbuffered regions of partial fragments
    for (let i = 0; i < media.buffered.length; i++) {
      let startTime = media.buffered.start(i);
      if (currentTime >= lastEndTime && currentTime < startTime) {
        media.currentTime = Math.max(startTime, media.currentTime + 0.1);
        logger.warn(
          `skipping hole, adjusting currentTime from ${currentTime} to ${media.currentTime}`
        );
        this.stalled = null;
        hls.trigger(Event.ERROR, {
          type: ErrorTypes.MEDIA_ERROR,
          details: ErrorDetails.BUFFER_SEEK_OVER_HOLE,
          fatal: false,
          reason: `fragment loaded with buffer holes, seeking from ${currentTime} to ${media.currentTime}`,
          frag: partial
        });
        return;
      }
      lastEndTime = media.buffered.end(i);
    }
  }

  /**
   * Attempts to fix buffer stalls by advancing the mediaElement's current time by a small amount.
   * @private
   */
  _tryNudgeBuffer(): void {
    const { config, hls, media } = this;
    const currentTime = media.currentTime;
    const nudgeRetry = (this.nudgeRetry || 0) + 1;
    this.nudgeRetry = nudgeRetry;

    if (nudgeRetry < config.nudgeMaxRetry) {
      const targetTime = currentTime + nudgeRetry * config.nudgeOffset;
      logger.log(`adjust currentTime from ${currentTime} to ${targetTime}`);
      // playback stalled in buffered area ... let's nudge currentTime to try to overcome this
      media.currentTime = targetTime;
      hls.trigger(Event.ERROR, {
        type: ErrorTypes.MEDIA_ERROR,
        details: ErrorDetails.BUFFER_NUDGE_ON_STALL,
        fatal: false
      });
    } else {
      logger.error(
        `still stuck in high buffer @${currentTime} after ${config.nudgeMaxRetry}, raise fatal error`
      );
      hls.trigger(Event.ERROR, {
        type: ErrorTypes.MEDIA_ERROR,
        details: ErrorDetails.BUFFER_STALLED_ERROR,
        fatal: true
      });
    }
  }
}
