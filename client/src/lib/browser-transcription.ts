/**
 * The turn's words, from the browser's own speech recognition (the Web Speech
 * API) in the place of a speech-to-text service on the bot.
 *
 * One recognizer listens to whichever track the bot is hearing: the clip
 * being played or the microphone. When the bot says a turn stopped, the
 * recognizer is stopped too, which has Chrome finish the words it was working
 * on, and the turn's words go to the bot in one piece. A new recognizer then
 * takes over for the next turn.
 *
 * Needs a Chromium browser recent enough to recognize a MediaStreamTrack
 * (Chrome 139 or later). Chrome sends the audio to Google's speech service,
 * unless its on-device English model is already installed, which is then used.
 */

const LANGUAGE = "en-US";
/** How long after a recognizer ends the next one starts. */
const RESTART_MS = 250;
/** The same, once recognizers keep ending as soon as they start. */
const BACKOFF_MS = 3000;
/** A recognizer that ends sooner than this after starting didn't really run. */
const QUICK_END_MS = 1000;
const QUICK_ENDS_BEFORE_BACKOFF = 3;
/** How long a stopped recognizer has to hand over its last words. */
const FLUSH_TIMEOUT_MS = 3000;

const UNSUPPORTED =
  "The words need Google Chrome 139 or later: this browser can't transcribe.";
const REFUSED = "The browser refused to transcribe the audio.";
const UNREACHABLE = "The browser's speech recognition isn't responding.";

/** Errors that only mean nothing was said, or that the page stopped the recognizer itself. */
const HARMLESS_ERRORS: ReadonlySet<string> = new Set(["no-speech", "aborted"]);
/** Errors that trying again won't fix. */
const FATAL_ERRORS: ReadonlySet<string> = new Set([
  "not-allowed",
  "service-not-allowed",
  "language-not-supported",
]);

// The Web Speech API as this file uses it. Declared here because not every
// TypeScript DOM library has it, and none has the track argument yet.
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly [index: number]: { readonly transcript: string };
}
interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: RecognitionResult;
  };
}
interface Recognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
}
interface RecognizerConstructor {
  new (): Recognizer;
  available?: (options: {
    langs: string[];
    processLocally: boolean;
  }) => Promise<string>;
}

export interface TranscriptionHandlers {
  /** A turn's words are ready to go to the bot. */
  onTranscript: (text: string) => void;
  /** The browser can't transcribe, with why. */
  onError: (message: string) => void;
}

let handlers: TranscriptionHandlers | null = null;
/** The track being listened to, if any. */
let source: MediaStreamTrack | null = null;
let active: Recognizer | null = null;
/** Goes up each time the source changes, so work started for an old one is dropped. */
let generation = 0;
/** The turn's words so far: the parts Chrome is sure of, and the part it's still working on. */
let finals: string[] = [];
let interim = "";
/** Whether a stopped recognizer's last words are awaited. */
let isFlushing = false;
let isBlocked = false;
let startedAt = 0;
let quickEnds = 0;
let restartTimer: ReturnType<typeof setTimeout> | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let localCheck: Promise<boolean> | undefined;

function recognizerConstructor(): RecognizerConstructor | undefined {
  const scope = window as unknown as {
    SpeechRecognition?: RecognizerConstructor;
    webkitSpeechRecognition?: RecognizerConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

/** Whether Chrome's on-device English model is installed already. Asked once. */
function isLocalAvailable(Ctor: RecognizerConstructor): Promise<boolean> {
  localCheck ??= (async () => {
    try {
      const status = await Ctor.available?.({
        langs: [LANGUAGE],
        processLocally: true,
      });
      return status === "available";
    } catch {
      return false;
    }
  })();
  return localCheck;
}

/** Lets go of the recognizer in use without hearing from it again. */
function dropActive(): void {
  const recognizer = active;
  active = null;
  if (!recognizer) return;
  recognizer.onresult = null;
  recognizer.onerror = null;
  recognizer.onend = null;
  try {
    recognizer.abort();
  } catch {
    // Already stopped.
  }
}

function scheduleRestart(delayMs: number): void {
  clearTimeout(restartTimer);
  const mine = generation;
  restartTimer = setTimeout(() => {
    if (mine === generation && source && !active) void begin();
  }, delayMs);
}

/** Sends the turn's words to the bot, if there are any. */
function emit(): void {
  isFlushing = false;
  const text = [...finals, interim].join(" ").trim();
  finals = [];
  interim = "";
  if (text) handlers?.onTranscript(text);
}

function collect(event: RecognitionEvent): void {
  let pending = "";
  for (let index = 0; index < event.results.length; index += 1) {
    const result = event.results[index];
    const text = result?.[0]?.transcript.trim() ?? "";
    if (!result || !text) continue;
    if (!result.isFinal) pending = `${pending} ${text}`.trim();
    // A final result is reported once, at or after the event's own index.
    else if (index >= event.resultIndex) finals.push(text);
  }
  interim = pending;
}

function failed(error: string): void {
  if (HARMLESS_ERRORS.has(error)) return;
  if (FATAL_ERRORS.has(error)) {
    isBlocked = true;
    handlers?.onError(REFUSED);
  } else {
    handlers?.onError(UNREACHABLE);
  }
}

function ended(): void {
  active = null;
  clearTimeout(flushTimer);
  if (isFlushing) {
    emit();
  } else if (interim) {
    // Chrome ended it mid-turn: what it was working on is kept for the turn's end.
    finals.push(interim);
    interim = "";
  }
  const lived = performance.now() - startedAt;
  quickEnds = lived < QUICK_END_MS ? quickEnds + 1 : 0;
  scheduleRestart(
    quickEnds >= QUICK_ENDS_BEFORE_BACKOFF ? BACKOFF_MS : RESTART_MS,
  );
}

async function begin(): Promise<void> {
  const Ctor = recognizerConstructor();
  // `available` came with on-device recognition, after recognizing a track did.
  if (!Ctor || typeof Ctor.available !== "function") {
    handlers?.onError(UNSUPPORTED);
    return;
  }
  if (isBlocked) return;
  const mine = generation;
  const isLocal = await isLocalAvailable(Ctor);
  const track = source;
  if (mine !== generation || !track || active) return;

  const recognizer = new Ctor();
  recognizer.lang = LANGUAGE;
  recognizer.continuous = true;
  recognizer.interimResults = true;
  if (isLocal) recognizer.processLocally = true;
  recognizer.onresult = (event) => {
    if (active === recognizer) collect(event);
  };
  recognizer.onerror = (event) => {
    if (active === recognizer) failed(event.error);
  };
  recognizer.onend = () => {
    if (active === recognizer) ended();
  };
  active = recognizer;
  startedAt = performance.now();
  try {
    recognizer.start(track);
  } catch {
    dropActive();
    quickEnds += 1;
    handlers?.onError(UNREACHABLE);
    scheduleRestart(BACKOFF_MS);
  }
}

/** Says where a turn's words go, and where to report that there can't be any. */
export function setTranscriptionHandlers(next: TranscriptionHandlers): void {
  handlers = next;
}

/** Listens to a track, in place of any listened to before, or with null to none. */
export function listenTo(track: MediaStreamTrack | null): void {
  if (track === source) return;
  source = track;
  generation += 1;
  clearTimeout(restartTimer);
  clearTimeout(flushTimer);
  dropActive();
  finals = [];
  interim = "";
  isFlushing = false;
  isBlocked = false;
  quickEnds = 0;
  if (track) void begin();
}

/** A turn started: what was heard before it isn't part of it. */
export function transcriptionTurnStarted(): void {
  // Unless the turn before is still handing over its words.
  if (isFlushing) return;
  finals = [];
  interim = "";
}

/** A turn stopped: its words are finished off and sent to the bot. */
export function transcriptionTurnStopped(): void {
  if (!source || isFlushing) return;
  const recognizer = active;
  if (!recognizer) {
    // Between two recognizers: what the last one heard is all there is.
    emit();
    return;
  }
  isFlushing = true;
  try {
    recognizer.stop();
  } catch {
    emit();
    return;
  }
  flushTimer = setTimeout(() => {
    if (active !== recognizer || !isFlushing) return;
    // It never ended: go with what it heard, and start afresh.
    emit();
    dropActive();
    scheduleRestart(RESTART_MS);
  }, FLUSH_TIMEOUT_MS);
}
