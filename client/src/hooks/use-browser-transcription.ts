import { RTVIEvent } from "@pipecat-ai/client-js";
import {
  usePipecatClient,
  usePipecatClientMediaTrack,
  usePipecatClientTransportState,
  useRTVIClientEvent,
} from "@pipecat-ai/client-react";
import { useEffect } from "react";

import { useSessionControls } from "@/hooks/use-session-controls";
import {
  listenTo,
  setTranscriptionHandlers,
  transcriptionTurnStarted,
  transcriptionTurnStopped,
} from "@/lib/browser-transcription";
import { usePerceptionStore } from "@/stores/perception-store";

/**
 * Has the browser transcribe what the bot is hearing, and sends each turn's
 * words to the bot as a `transcript` client message (server/transcripts.py).
 * The bot has no speech-to-text service of its own. Mount once, under the
 * client provider.
 */
export function useBrowserTranscription(): void {
  const client = usePipecatClient();
  const isReady = usePipecatClientTransportState() === "ready";
  const { isMicOn } = useSessionControls();
  const clipTrack = usePipecatClientMediaTrack("audio", "bot");
  const micTrack = usePipecatClientMediaTrack("audio", "local");
  const setConnectionError = usePerceptionStore(
    (state) => state.setConnectionError,
  );
  // The microphone when it's on, else the bot's audio, which is the clips.
  const track = !isReady ? null : isMicOn ? micTrack : clipTrack;

  // The browser's recognizer is outside React: these keep it on the right track.
  useEffect(() => {
    setTranscriptionHandlers({
      onTranscript: (text) => {
        client?.sendClientMessage("transcript", { text });
      },
      onError: setConnectionError,
    });
  }, [client, setConnectionError]);
  useEffect(() => {
    listenTo(track);
    return () => listenTo(null);
  }, [track]);

  useRTVIClientEvent(RTVIEvent.UserStartedSpeaking, transcriptionTurnStarted);
  useRTVIClientEvent(RTVIEvent.UserStoppedSpeaking, transcriptionTurnStopped);
}
