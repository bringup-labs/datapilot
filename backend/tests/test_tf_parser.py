"""Unit coverage for app.services.tf_parser.TFParser.

Covers TF frame extraction from both object-attribute and dict message shapes,
slash-prefix cleanup, accumulation across calls, and unreadable transforms:
they're skipped and counted, in this parser and in the parser service's copy,
while unexpected errors propagate (#89).
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services.tf_parser import TFParser

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from mcap_parser.parser import _TFParser as ServiceTFParser  # noqa: E402


def _obj_transform(child, parent):
    """Build an object-style TransformStamped (attribute access)."""
    return SimpleNamespace(
        child_frame_id=child,
        header=SimpleNamespace(frame_id=parent),
    )


class TestParseObjectShape:
    def test_single_transform(self):
        p = TFParser()
        msg = SimpleNamespace(transforms=[_obj_transform("base_link", "odom")])
        p.parse_tf_message(msg)
        assert p.frames == {"base_link": "odom"}

    def test_multiple_transforms(self):
        p = TFParser()
        msg = SimpleNamespace(transforms=[
            _obj_transform("base_link", "odom"),
            _obj_transform("laser_link", "base_link"),
        ])
        p.parse_tf_message(msg)
        assert p.frames == {"base_link": "odom", "laser_link": "base_link"}

    def test_strips_leading_slashes(self):
        p = TFParser()
        msg = SimpleNamespace(transforms=[_obj_transform("/laser_link", "/base_link")])
        p.parse_tf_message(msg)
        assert p.frames == {"laser_link": "base_link"}


class TestParseDictShape:
    def test_dict_message_and_dict_transforms(self):
        p = TFParser()
        msg = {
            "transforms": [
                {"child_frame_id": "base_link", "header": {"frame_id": "odom"}},
            ]
        }
        p.parse_tf_message(msg)
        assert p.frames == {"base_link": "odom"}

    def test_dict_multiple(self):
        p = TFParser()
        msg = {
            "transforms": [
                {"child_frame_id": "base_link", "header": {"frame_id": "odom"}},
                {"child_frame_id": "imu_link", "header": {"frame_id": "base_link"}},
            ]
        }
        p.parse_tf_message(msg)
        assert p.frames == {"base_link": "odom", "imu_link": "base_link"}


class TestAccumulationAndOutput:
    def test_accumulates_across_calls(self):
        p = TFParser()
        p.parse_tf_message(SimpleNamespace(transforms=[_obj_transform("base_link", "odom")]))
        p.parse_tf_message(SimpleNamespace(transforms=[_obj_transform("laser_link", "base_link")]))
        assert p.frames == {"base_link": "odom", "laser_link": "base_link"}

    def test_later_call_overwrites_same_child(self):
        p = TFParser()
        p.parse_tf_message(SimpleNamespace(transforms=[_obj_transform("base_link", "odom")]))
        p.parse_tf_message(SimpleNamespace(transforms=[_obj_transform("base_link", "world")]))
        assert p.frames == {"base_link": "world"}

    def test_get_frames_list_shape(self):
        p = TFParser()
        p.parse_tf_message(SimpleNamespace(transforms=[_obj_transform("base_link", "odom")]))
        out = p.get_frames_list()
        assert out == [{"name": "base_link", "parent": "odom"}]

    def test_get_frames_list_empty_when_no_frames(self):
        assert TFParser().get_frames_list() == []


class TestEdgeAndErrorPaths:
    def test_empty_transforms_list(self):
        p = TFParser()
        p.parse_tf_message(SimpleNamespace(transforms=[]))
        assert p.frames == {}

    def test_missing_child_skips_transform(self):
        p = TFParser()
        # child_frame_id is None → pair is incomplete → not recorded.
        msg = SimpleNamespace(transforms=[
            SimpleNamespace(child_frame_id=None, header=SimpleNamespace(frame_id="odom")),
        ])
        p.parse_tf_message(msg)
        assert p.frames == {}

    def test_missing_parent_skips_transform(self):
        p = TFParser()
        msg = SimpleNamespace(transforms=[
            SimpleNamespace(child_frame_id="base_link", header=SimpleNamespace(frame_id=None)),
        ])
        p.parse_tf_message(msg)
        assert p.frames == {}

    def test_no_transforms_attribute_is_ignored(self):
        # An object with no `transforms` attr and not a dict → getattr default []
        # so nothing happens, no exception.
        p = TFParser()
        p.parse_tf_message(SimpleNamespace(foo="bar"))
        assert p.frames == {}

    def test_none_message_is_ignored(self):
        p = TFParser()
        # getattr(None, 'transforms', None) -> None ; isinstance(None, dict) False.
        p.parse_tf_message(None)
        assert p.frames == {}


@pytest.fixture(params=["backend", "mcap-parser-service"])
def tf(request):
    """(parser, parse function) for the backend's TFParser and the service's copy."""
    if request.param == "backend":
        parser = TFParser()
        return parser, parser.parse_tf_message
    parser = ServiceTFParser()
    return parser, parser.parse


class TestUnreadableTransforms:
    """Unreadable transforms are skipped and counted, not silently dropped (#89)."""

    def test_bad_transform_is_skipped_without_losing_the_rest(self, tf):
        parser, parse = tf
        parse(SimpleNamespace(transforms=[
            _obj_transform("base_link", "odom"),
            _obj_transform(5, "odom"),  # the child id isn't a string
            _obj_transform("laser_link", "base_link"),
        ]))
        assert parser.frames == {"base_link": "odom", "laser_link": "base_link"}
        assert parser.skipped == 1

    def test_dict_transform_whose_header_is_not_a_dict_is_skipped(self, tf):
        parser, parse = tf
        parse({"transforms": [{"child_frame_id": "base_link", "header": "odom"}]})
        assert parser.frames == {}
        assert parser.skipped == 1

    def test_transforms_that_are_not_a_list_count_as_skipped(self, tf):
        parser, parse = tf
        parse(SimpleNamespace(transforms=123))
        assert parser.frames == {}
        assert parser.skipped == 1

    def test_readable_and_empty_messages_skip_nothing(self, tf):
        parser, parse = tf
        parse(SimpleNamespace(transforms=[_obj_transform("base_link", "odom")]))
        parse(SimpleNamespace(transforms=[]))
        parse(None)
        assert parser.skipped == 0

    def test_unexpected_errors_are_not_swallowed(self, tf):
        class Exploding:
            child_frame_id = "base_link"

            @property
            def header(self):  # noqa: D401 - intentionally raises on access
                raise RuntimeError("boom")

        _parser, parse = tf
        with pytest.raises(RuntimeError, match="boom"):
            parse(SimpleNamespace(transforms=[Exploding()]))
