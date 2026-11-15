"""Custom exception types for SiteScout."""
from __future__ import annotations


class SiteScoutError(Exception):
    """Base class."""


class ConfigError(SiteScoutError):
    pass


class InvalidURL(SiteScoutError):
    pass


class FatalAPIError(SiteScoutError):
    """Bad key, no credits, model not available: retrying or continuing is pointless."""


class NetworkError(SiteScoutError):
    pass


class ShapeError(SiteScoutError):
    """API answered 200 but the body is not what we asked for."""


class CaptureError(SiteScoutError):
    """kind: 'down' (site non-functional), 'blocked' (bot protection), 'failed' (other)."""

    def __init__(self, message: str, kind: str = "failed"):
        super().__init__(message)
        self.kind = kind


class DecisionError(SiteScoutError):
    def __init__(self, message: str, kind: str = "failed"):
        super().__init__(message)
        self.kind = kind
