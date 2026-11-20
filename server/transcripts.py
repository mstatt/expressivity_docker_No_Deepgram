"""The turn's words, transcribed by the page's browser instead of a speech-to-text service.

The page has Chrome's own speech recognition (the Web Speech API) listen to the same audio the bot
hears, the clip being played or the microphone, and sends each turn's words as a ``transcript``
RTVI client message once the bot says the turn stopped. ``BrowserTranscripts`` goes where the STT
service would, and pushes those words on as the transcription the ``PerceptionReader`` reads.
"""

from __future__ import annotations

from loguru import logger
from pipecat.frames.frames import Frame, TranscriptionFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.transcriptions.language import Language
from pipecat.utils.time import time_now_iso8601

#: The most characters of a turn's words taken from the page. The clips run to about 120.
MAX_CHARS = 2000


class BrowserTranscripts(FrameProcessor):
    """Pushes the words the page transcribed as a turn's transcription.

    Goes right before the ``PerceptionReader``, in the STT service's place. Everything else passes
    through it untouched.
    """

    async def add(self, text: object) -> bool:
        """Push a turn's words on as its transcription.

        Args:
            text: The words, as the page sent them.

        Returns:
            Whether there were any words to push.
        """
        if not isinstance(text, str):
            return False
        words = " ".join(text.split())[:MAX_CHARS]
        if not words:
            return False
        logger.debug(f"{self}: the browser heard [{words}]")
        await self.push_frame(
            TranscriptionFrame(
                text=words,
                user_id="",
                timestamp=time_now_iso8601(),
                language=Language.EN_US,
            )
        )
        return True

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
