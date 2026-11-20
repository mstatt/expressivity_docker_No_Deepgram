"""Lets a browser on the host reach the bot's WebRTC ports when the bot runs in a Docker container.

SmallWebRTC is peer-to-peer: the bot tells the browser which address and UDP port to send audio to.
In a container that address is the container's own (such as 172.18.0.2), which a browser on the
host can't reach under Docker Desktop on Windows and macOS, so the connection never completes.

With ``WEBRTC_ADVERTISE_IP`` set, every address the bot offers is offered a second time at that IP
with the same port. ``docker-compose.yml`` publishes the container's UDP ports at that IP, and
keeps them to a small range, so the browser's audio finds its way in. Unset, nothing changes.
"""

from __future__ import annotations

import hashlib
import os
import re

from loguru import logger

#: An ICE host candidate over UDP, as aiortc writes one in an SDP answer.
_HOST_CANDIDATE = re.compile(
    r"^a=candidate:\S+ (?P<component>\d+) (?:udp|UDP) (?P<priority>\d+) "
    r"(?P<ip>\d+\.\d+\.\d+\.\d+) (?P<port>\d+) typ host\b"
)


def advertise(sdp: str, address: str) -> str:
    """Offer each of an answer's IPv4 host candidates at another address too.

    Args:
        sdp: The SDP answer.
        address: The IPv4 address the browser can reach the same ports at.

    Returns:
        The answer, with a copy of each such candidate at ``address`` before it.
    """
    foundation = hashlib.md5(f"advertised-{address}".encode()).hexdigest()
    lines = []
    for line in sdp.split("\r\n"):
        found = _HOST_CANDIDATE.match(line)
        if found and found["ip"] != address:
            lines.append(
                f"a=candidate:{foundation} {found['component']} udp {found['priority']} "
                f"{address} {found['port']} typ host"
            )
        lines.append(line)
    return "\r\n".join(lines)


def advertise_from_environment() -> None:
    """Have every SmallWebRTC answer offer ``WEBRTC_ADVERTISE_IP`` too, when it's set."""
    address = os.environ.get("WEBRTC_ADVERTISE_IP", "").strip()
    if not address:
        return
    if not re.fullmatch(r"\d+\.\d+\.\d+\.\d+", address):
        logger.warning(f"WEBRTC_ADVERTISE_IP is not an IPv4 address, ignored: {address!r}")
        return
    try:
        from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
    except Exception as e:  # The transport isn't installed: there is nothing to adjust.
        logger.warning(f"WEBRTC_ADVERTISE_IP is set but SmallWebRTC can't be loaded: {e}")
        return

    get_answer = SmallWebRTCConnection.get_answer

    def get_answer_advertised(self):
        answer = get_answer(self)
        if answer and isinstance(answer.get("sdp"), str):
            answer = {**answer, "sdp": advertise(answer["sdp"], address)}
        return answer

    SmallWebRTCConnection.get_answer = get_answer_advertised
    logger.info(f"WebRTC answers also offer {address}, for a browser outside the container")
