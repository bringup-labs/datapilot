import logging
from typing import Dict, List, Any, Tuple

logger = logging.getLogger(__name__)


def _frame_pair(transform: Any) -> Tuple[Any, Any]:
    """The (child, parent) frame ids of one transform, from attributes or dict keys."""
    child = getattr(transform, "child_frame_id", None)
    if not child and isinstance(transform, dict):
        child = transform.get("child_frame_id")

    header = getattr(transform, "header", None)
    parent = None
    if header:
        parent = getattr(header, "frame_id", None)
    elif isinstance(transform, dict):
        parent = transform.get("header", {}).get("frame_id")
    return child, parent


class TFParser:
    def __init__(self):
        # Maps child frame to parent frame
        self.frames: Dict[str, str] = {}
        # Transforms that couldn't be read. The bag parser reports the count,
        # since each one leaves a gap in the frame tree (#89).
        self.skipped = 0

    def parse_tf_message(self, msg: Any):
        """
        Parses a tf2_msgs/msg/TFMessage or similar structure.
        Looks for child_frame_id and header.frame_id (parent).

        A transform that isn't shaped like one is skipped and counted, and the
        rest of the message is still read. Other errors propagate.
        """
        # Handles dictionary format or object attributes
        transforms = getattr(msg, "transforms", None) or []
        if not transforms and isinstance(msg, dict):
            transforms = msg.get("transforms") or []
        try:
            transforms = list(transforms)
        except TypeError:
            self._skip(f"transforms is a {type(transforms).__name__}, not a list")
            return

        for transform in transforms:
            try:
                child, parent = _frame_pair(transform)
                if child and parent:
                    # Clean up slash prefixes if any
                    self.frames[child.lstrip("/")] = parent.lstrip("/")
            except (AttributeError, TypeError) as exc:
                self._skip(str(exc))

    def _skip(self, detail: str) -> None:
        self.skipped += 1
        logger.debug("Skipping an unreadable TF transform: %s", detail)

    def get_frames_list(self) -> List[Dict[str, str]]:
        return [{"name": child, "parent": parent} for child, parent in self.frames.items()]
