/**
 * The timing module's public surface.
 *
 * Two questions, answered independently of each other and of anything that
 * renders: *what instant are we counting down to* (`target.ts`, real IANA tz
 * rules via Temporal) and *what time is it really* (`trueTime.ts`, NTP-lite
 * over HTTPS on top of a monotonic in-session clock).
 *
 * See `docs/timing.md`. Nothing under `src/time/` may import three.js or touch
 * the DOM directly.
 */

export {
  MS_PER_SECOND,
  MS_PER_MINUTE,
  MS_PER_HOUR,
  MS_PER_DAY,
  MAX_DISPLAY_HOURS,
  MAX_DISPLAY_SECONDS,
  computeCountdown,
  computeRemaining,
  formatCountdown,
  formatRemaining,
  countdownDigits,
  clockDigits,
} from './countdown.js';
export type { CountdownParts, RemainingTime } from './countdown.js';

export {
  TargetError,
  systemTimeSource,
  viewerTimeZone,
  isValidTimeZone,
  resolveTarget,
  resolveTargetFromParams,
  resolveCountdownTarget,
  defaultTarget,
  nextNewYear,
  nextNewYearZoned,
  parseTargetParam,
} from './target.js';
export type {
  TimeSource,
  CountdownTarget,
  ResolvedTarget,
  TargetInput,
  TargetParams,
  TargetSource,
  TargetErrorCode,
  Disambiguation,
  ZoneEcho,
} from './target.js';

export {
  TrueTimeClock,
  DEFAULT_MAX_SLEW_MS,
  DEFAULT_SKEW_WARN_MS,
  estimateOffset,
  getRemaining,
  getTimeStatus,
  getTrueTimeClock,
  initTrueTime,
  subscribeTimeStatus,
  disposeTrueTime,
  trueNow,
  trueTimeSource,
} from './trueTime.js';
export type {
  AccuracyTier,
  OffsetEstimate,
  OffsetSample,
  Scheduler,
  TimeProvider,
  TrueTimeOptions,
  TrueTimeStatus,
  VisibilitySource,
} from './trueTime.js';

export {
  cloudflareTraceProvider,
  defaultProviders,
  httpDateProvider,
  timeApiIoProvider,
} from './providers.js';
export type { FetchLike } from './providers.js';
