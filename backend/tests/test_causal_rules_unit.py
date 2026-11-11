"""Unit coverage for app.services.causal_rules.

Covers:
- log_time_to_seconds parsing (HH:MM:SS, the bare H:MM:SS form, float fallback,
  and the "N day, H:MM:SS" form that currently returns 0.0 — the timestamp bug).
- Rule loading from causal.yaml.
- Condition matching (severity / node_glob / log_pattern).
- evaluate() producing TRIGGERED / CAUSED / CONCURRENT_WITH edges, windows,
  evidence thresholds and lag_ms math.
"""
from __future__ import annotations

import logging
from datetime import timedelta

import pytest

from app.services.causal_rules import (
    CausalRulesEvaluator,
    causal_rules_evaluator,
    log_time_to_seconds,
)


# ---------------------------------------------------------------------------
# log_time_to_seconds
# ---------------------------------------------------------------------------

class TestLogTimeToSeconds:
    def test_full_hh_mm_ss_with_millis(self):
        # 1h 1m 1.5s
        assert log_time_to_seconds("01:01:01.500") == pytest.approx(3661.5)

    def test_zero_hours(self):
        assert log_time_to_seconds("00:00:12.412") == pytest.approx(12.412)

    def test_bare_h_mm_ss_form(self):
        # The "H:MM:SS" single-digit-hour form still has 3 colon-separated parts,
        # so it parses correctly. This is the form str(timedelta) emits for
        # durations under 24h, e.g. "1:01:01.250000".
        assert log_time_to_seconds("1:01:01.250000") == pytest.approx(3661.25)

    def test_minutes_and_seconds_only_hours_zero(self):
        assert log_time_to_seconds("00:05:30.000") == pytest.approx(330.0)

    def test_plain_float_string_fallback(self):
        # Not colon-delimited → falls through to float() fallback branch.
        assert log_time_to_seconds("42.5") == pytest.approx(42.5)

    def test_plain_integer_string_fallback(self):
        assert log_time_to_seconds("7") == pytest.approx(7.0)

    def test_garbage_returns_zero(self):
        assert log_time_to_seconds("not-a-time") == 0.0

    def test_empty_string_returns_zero(self):
        assert log_time_to_seconds("") == 0.0

    def test_two_part_mm_ss_not_supported_falls_back_to_zero(self):
        # Only 3-part strings are handled; "MM:SS" has 2 parts, so it falls
        # through to float("05:30") which raises → 0.0.
        assert log_time_to_seconds("05:30") == 0.0

    def test_day_form_is_parsed(self):
        # Fixed (issue #70). For bags longer than 24h (or any log whose
        # timestamp crosses a day boundary) str(timedelta) emits the
        # "N day, H:MM:SS" form, e.g. "1 day, 1:01:01.500000". The parser now
        # strips the "N day(s)," prefix and adds N*86400, so the true seconds
        # are recovered instead of silently collapsing to 0.0.
        day_form = str(timedelta(seconds=90061.5))  # '1 day, 1:01:01.500000'
        assert "day" in day_form
        assert log_time_to_seconds(day_form) == pytest.approx(90061.5)

    def test_multi_day_form_literal_is_parsed(self):
        # Plural "N days," prefix (issue #70). 2*86400 + 3*3600 + 4*60 + 5.
        assert log_time_to_seconds("2 days, 3:04:05.000000") == pytest.approx(183845.0)

    def test_unparseable_time_is_logged_at_debug(self, caplog):
        # The 0.0 fallback used to be silent (#89).
        with caplog.at_level(logging.DEBUG, logger="app.services.causal_rules"):
            assert log_time_to_seconds("not-a-time") == 0.0
        assert any("not-a-time" in r.getMessage() for r in caplog.records)


# ---------------------------------------------------------------------------
# Rule loading
# ---------------------------------------------------------------------------

class TestRuleLoading:
    def test_singleton_loads_rules_from_yaml(self):
        ev = CausalRulesEvaluator()
        assert len(ev.rules) > 0
        ids = {r["id"] for r in ev.rules}
        assert "sensor_dropout_inflates_costmap" in ids
        assert "planner_abort_triggers_ebrake" in ids

    def test_module_singleton_also_populated(self):
        assert len(causal_rules_evaluator.rules) > 0

    def test_each_rule_has_cause_and_effect(self):
        ev = CausalRulesEvaluator()
        for rule in ev.rules:
            assert "cause" in rule
            assert "effect" in rule
            assert "id" in rule

    def test_shipped_rules_load_without_error(self):
        assert causal_rules_evaluator.status()["error"] is None

    def test_valid_rules_file_reports_its_rule_count(self, tmp_path):
        path = tmp_path / "causal.yaml"
        path.write_text(
            "rules:\n"
            "  - {id: a, cause: {}, effect: {}}\n"
            "  - {id: b, cause: {}, effect: {}}\n"
        )
        ev = CausalRulesEvaluator(rules_path=str(path))
        assert [r["id"] for r in ev.rules] == ["a", "b"]
        assert ev.status() == {"loaded": 2, "error": None}

    def test_missing_rules_file_is_logged_as_an_error(self, tmp_path, caplog):
        # Used to be a print() to stdout, leaving causal chains empty with no
        # visible error (#89).
        path = tmp_path / "causal.yaml"
        with caplog.at_level(logging.ERROR, logger="app.services.causal_rules"):
            ev = CausalRulesEvaluator(rules_path=str(path))
        assert ev.rules == []
        assert ev.status() == {"loaded": 0, "error": "missing"}
        errors = [r.getMessage() for r in caplog.records if r.levelno == logging.ERROR]
        assert any(str(path) in message for message in errors)

    @pytest.mark.parametrize(
        "text, error",
        [
            ("rules: [unclosed\n", "unreadable"),
            ("rules: 5\n", "invalid"),
            ("- {id: not_under_rules}\n", "invalid"),
            ("", "invalid"),
        ],
        ids=["broken-yaml", "rules-not-a-list", "no-rules-key", "empty-file"],
    )
    def test_bad_rules_file_is_logged_as_an_error(self, tmp_path, caplog, text, error):
        path = tmp_path / "causal.yaml"
        path.write_text(text)
        with caplog.at_level(logging.ERROR, logger="app.services.causal_rules"):
            ev = CausalRulesEvaluator(rules_path=str(path))
        assert ev.rules == []
        assert ev.status() == {"loaded": 0, "error": error}
        assert any(r.levelno == logging.ERROR for r in caplog.records)


# ---------------------------------------------------------------------------
# Condition matching
# ---------------------------------------------------------------------------

class TestMatchesCondition:
    def setup_method(self):
        self.ev = CausalRulesEvaluator()

    def test_severity_case_insensitive_match(self):
        log = {"sev": "error", "node": "/sensors/lidar", "text": "boom"}
        assert self.ev._matches_condition(log, {"severity": ["ERROR"]}) is True

    def test_severity_mismatch(self):
        log = {"sev": "INFO", "node": "/x", "text": "ok"}
        assert self.ev._matches_condition(log, {"severity": ["ERROR"]}) is False

    def test_node_glob_match(self):
        log = {"sev": "ERROR", "node": "/sensors/lidar_a", "text": "x"}
        assert self.ev._matches_condition(log, {"node_glob": "/sensors*"}) is True

    def test_node_glob_mismatch(self):
        log = {"sev": "ERROR", "node": "/odom", "text": "x"}
        assert self.ev._matches_condition(log, {"node_glob": "/sensors*"}) is False

    def test_log_pattern_regex_match_case_insensitive(self):
        log = {"sev": "ERROR", "node": "/sensors", "text": "no data for 782ms"}
        assert self.ev._matches_condition(log, {"log_pattern": r"(?i)no data for \d+ms"}) is True

    def test_log_pattern_no_match(self):
        log = {"sev": "ERROR", "node": "/sensors", "text": "everything fine"}
        assert self.ev._matches_condition(log, {"log_pattern": r"no data for \d+ms"}) is False

    def test_invalid_regex_returns_false_not_raise(self):
        log = {"sev": "ERROR", "node": "/sensors", "text": "anything"}
        # An unbalanced group is invalid; the bare-except swallows it → False.
        assert self.ev._matches_condition(log, {"log_pattern": "("}) is False

    def test_empty_condition_matches_everything(self):
        log = {"sev": "INFO", "node": "/whatever", "text": "hi"}
        assert self.ev._matches_condition(log, {}) is True

    def test_combined_conditions_all_must_pass(self):
        cond = {
            "severity": ["ERROR"],
            "node_glob": "/sensors*",
            "log_pattern": r"(?i)dropout",
        }
        good = {"sev": "ERROR", "node": "/sensors/a", "text": "Sensor dropout"}
        bad_node = {"sev": "ERROR", "node": "/odom", "text": "Sensor dropout"}
        assert self.ev._matches_condition(good, cond) is True
        assert self.ev._matches_condition(bad_node, cond) is False


# ---------------------------------------------------------------------------
# evaluate()
# ---------------------------------------------------------------------------

class TestEvaluate:
    def setup_method(self):
        self.ev = CausalRulesEvaluator()

    def test_triggered_edge_within_window(self):
        logs = [
            {"id": "l_1", "t": "00:00:10.000", "node": "/sensors/lidar_a",
             "sev": "ERROR", "text": "Sensor dropout: no data for 782ms"},
            {"id": "l_2", "t": "00:00:11.500", "node": "/costmap",
             "sev": "WARN", "text": "applying defensive inflation 0.45m"},
        ]
        edges = self.ev.evaluate(logs)
        triggered = [e for e in edges if e["type"] == "TRIGGERED"]
        assert len(triggered) == 1
        e = triggered[0]
        assert e["source_id"] == "l_1"
        assert e["target_id"] == "l_2"
        assert e["properties"]["rule_id"] == "sensor_dropout_inflates_costmap"
        assert e["properties"]["confidence"] == 0.92
        assert e["properties"]["lag_ms"] == 1500

    def test_caused_edge_for_planner_abort_ebrake(self):
        logs = [
            {"id": "l_1", "t": "00:00:06.118", "node": "/move_base",
             "sev": "ERROR", "text": "Planner aborted — no valid path"},
            {"id": "l_2", "t": "00:00:06.310", "node": "/cmd_vel",
             "sev": "ERROR", "text": "Velocity command zeroed; emergency brake engaged"},
        ]
        edges = self.ev.evaluate(logs)
        caused = [e for e in edges if e["type"] == "CAUSED"]
        # planner_abort_triggers_ebrake (CAUSED). The two logs are 192ms apart,
        # which is also <= 50ms? No (192 > 50), so no CONCURRENT_WITH here.
        rule_ids = {e["properties"]["rule_id"] for e in caused}
        assert "planner_abort_triggers_ebrake" in rule_ids
        edge = next(e for e in caused if e["properties"]["rule_id"] == "planner_abort_triggers_ebrake")
        assert edge["source_id"] == "l_1"
        assert edge["target_id"] == "l_2"
        assert edge["properties"]["lag_ms"] == 192

    def test_effect_outside_window_no_edge(self):
        # Window for sensor_dropout_inflates_costmap is 2000ms; put the effect
        # 3s later so it falls outside.
        logs = [
            {"id": "l_1", "t": "00:00:10.000", "node": "/sensors/lidar_a",
             "sev": "ERROR", "text": "Sensor dropout: no data for 782ms"},
            {"id": "l_2", "t": "00:00:13.000", "node": "/costmap",
             "sev": "WARN", "text": "applying defensive inflation 0.45m"},
        ]
        edges = self.ev.evaluate(logs)
        triggered = [e for e in edges if e["type"] == "TRIGGERED"]
        assert triggered == []

    def test_effect_at_same_time_excluded_strict_lower_bound(self):
        # The window check is strict: c_ts < e_ts <= c_ts + window.
        # An effect at exactly the cause time is NOT matched.
        logs = [
            {"id": "l_1", "t": "00:00:10.000", "node": "/sensors/lidar_a",
             "sev": "ERROR", "text": "Sensor dropout: no data for 782ms"},
            {"id": "l_2", "t": "00:00:10.000", "node": "/costmap",
             "sev": "WARN", "text": "applying defensive inflation 0.45m"},
        ]
        edges = self.ev.evaluate(logs)
        triggered = [e for e in edges if e["type"] == "TRIGGERED"]
        assert triggered == []

    def test_no_matching_rules_only_concurrent_or_empty(self):
        logs = [
            {"id": "l_1", "t": "00:00:10.000", "node": "/odom",
             "sev": "INFO", "text": "Odometry stable"},
            {"id": "l_2", "t": "00:00:30.000", "node": "/odom",
             "sev": "INFO", "text": "Still stable"},
        ]
        edges = self.ev.evaluate(logs)
        causal = [e for e in edges if e["type"] != "CONCURRENT_WITH"]
        assert causal == []

    def test_concurrent_within_50ms(self):
        logs = [
            {"id": "l_1", "t": "00:00:10.000", "node": "/a", "sev": "INFO", "text": "A"},
            {"id": "l_2", "t": "00:00:10.030", "node": "/b", "sev": "INFO", "text": "B"},
        ]
        edges = self.ev.evaluate(logs)
        conc = [e for e in edges if e["type"] == "CONCURRENT_WITH"]
        assert len(conc) == 1
        assert conc[0]["source_id"] == "l_1"
        assert conc[0]["target_id"] == "l_2"
        assert conc[0]["properties"]["lag_ms"] == 30

    def test_concurrent_boundary_at_50ms_excluded_by_float_error(self):
        # NOTE: the threshold is `diff_sec <= 0.050`, but parsing "10.050" - "10.0"
        # yields 0.05000000000000071 (binary float), which is strictly greater
        # than 0.050 — so the *exact* 50ms boundary is CURRENTLY excluded. We
        # characterize that real behavior rather than the nominal intent.
        logs = [
            {"id": "l_1", "t": "00:00:10.000", "node": "/a", "sev": "INFO", "text": "A"},
            {"id": "l_2", "t": "00:00:10.050", "node": "/b", "sev": "INFO", "text": "B"},
        ]
        edges = self.ev.evaluate(logs)
        conc = [e for e in edges if e["type"] == "CONCURRENT_WITH"]
        assert conc == []

    def test_concurrent_clearly_under_50ms_included(self):
        # 40ms is comfortably inside the window even with float jitter.
        logs = [
            {"id": "l_1", "t": "00:00:10.000", "node": "/a", "sev": "INFO", "text": "A"},
            {"id": "l_2", "t": "00:00:10.040", "node": "/b", "sev": "INFO", "text": "B"},
        ]
        edges = self.ev.evaluate(logs)
        conc = [e for e in edges if e["type"] == "CONCURRENT_WITH"]
        assert len(conc) == 1
        assert conc[0]["properties"]["lag_ms"] == 40

    def test_concurrent_just_over_50ms_excluded(self):
        logs = [
            {"id": "l_1", "t": "00:00:10.000", "node": "/a", "sev": "INFO", "text": "A"},
            {"id": "l_2", "t": "00:00:10.060", "node": "/b", "sev": "INFO", "text": "B"},
        ]
        edges = self.ev.evaluate(logs)
        conc = [e for e in edges if e["type"] == "CONCURRENT_WITH"]
        assert conc == []

    def test_evaluate_sorts_unordered_input(self):
        # Provide logs out of timestamp order; evaluate sorts internally so the
        # cause (earlier) still precedes the effect.
        logs = [
            {"id": "l_2", "t": "00:00:11.500", "node": "/costmap",
             "sev": "WARN", "text": "applying defensive inflation 0.45m"},
            {"id": "l_1", "t": "00:00:10.000", "node": "/sensors/lidar_a",
             "sev": "ERROR", "text": "Sensor dropout: no data for 782ms"},
        ]
        edges = self.ev.evaluate(logs)
        triggered = [e for e in edges if e["type"] == "TRIGGERED"]
        assert len(triggered) == 1
        assert triggered[0]["source_id"] == "l_1"
        assert triggered[0]["target_id"] == "l_2"

    def test_empty_logs_returns_empty_edges(self):
        assert self.ev.evaluate([]) == []

    def test_evidence_required_threshold(self):
        # Force a custom rule requiring 2 pieces of evidence; a single matching
        # effect should NOT produce an edge.
        ev = CausalRulesEvaluator()
        ev.rules = [{
            "id": "needs_two",
            "cause": {"node_glob": "/cause*"},
            "effect": {"node_glob": "/effect*"},
            "window_ms": 5000,
            "confidence": 0.5,
            "edge_type": "CAUSED",
            "evidence_required": 2,
        }]
        one_effect = [
            {"id": "c", "t": "00:00:10.000", "node": "/cause", "sev": "INFO", "text": "c"},
            {"id": "e1", "t": "00:00:11.000", "node": "/effect", "sev": "INFO", "text": "e"},
        ]
        edges = ev.evaluate(one_effect)
        caused = [e for e in edges if e["type"] == "CAUSED"]
        assert caused == []

        two_effects = one_effect + [
            {"id": "e2", "t": "00:00:12.000", "node": "/effect", "sev": "INFO", "text": "e"},
        ]
        edges2 = ev.evaluate(two_effects)
        caused2 = [e for e in edges2 if e["type"] == "CAUSED"]
        # Threshold met → one edge per matched effect (2 effects → 2 edges).
        assert len(caused2) == 2
        assert {e["target_id"] for e in caused2} == {"e1", "e2"}
