import logging
import os
import re
import yaml
import fnmatch
from typing import List, Dict, Any

from app.config import settings

logger = logging.getLogger(__name__)

# app/rules/causal.yaml, shipped with the backend.
RULES_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "rules", "causal.yaml"
)

def log_time_to_seconds(t_str: str) -> float:
    """Convert a ``str(timedelta)`` display string to float seconds.

    Handles both the plain ``"H:MM:SS[.ffffff]"`` form and the
    ``"N day[s], H:MM:SS"`` form that ``str(timedelta)`` emits once a duration
    crosses 24h (issue #70 — without the day handling, long bags silently
    collapsed every timestamp to 0.0). Bare numeric strings fall through to
    ``float()``; anything unparseable yields 0.0, logged at debug level.
    """
    try:
        s = t_str.strip()
        days = 0.0
        if "day" in s:
            # "N day, H:MM:SS" or "N days, H:MM:SS"
            day_part, _, rest = s.partition(",")
            days = float(day_part.split()[0])
            s = rest.strip()
        parts = s.split(":")
        if len(parts) == 3:
            h, m, sec = parts
            return days * 86400.0 + float(h) * 3600.0 + float(m) * 60.0 + float(sec)
    except (AttributeError, IndexError, ValueError):
        pass  # not a display string; try it as a plain number below
    try:
        # Fallback if float is passed as string
        return float(t_str)
    except (TypeError, ValueError, OverflowError):
        logger.debug("Unparseable log time %r, using 0.0", t_str)
        return 0.0

class CausalRulesEvaluator:
    def __init__(self, rules_path: str = RULES_PATH):
        self.rules_path = rules_path
        self.rules: List[Dict[str, Any]] = []
        # Why no rules loaded ("missing", "unreadable" or "invalid"), or None.
        # /health reports it, since ingestion without rules builds no causal
        # chains (#89).
        self.load_error: str | None = None
        self._load_rules()

    def _load_rules(self) -> None:
        try:
            with open(self.rules_path, "r") as f:
                data = yaml.safe_load(f)
        except FileNotFoundError:
            self._rules_not_loaded("missing", "%s doesn't exist", self.rules_path)
            return
        except (OSError, yaml.YAMLError) as exc:
            self._rules_not_loaded("unreadable", "couldn't read %s: %s", self.rules_path, exc)
            return
        rules = data.get("rules") if isinstance(data, dict) else None
        if not isinstance(rules, list):
            self._rules_not_loaded("invalid", "%s has no list of rules under `rules:`", self.rules_path)
            return
        self.rules = rules

    def _rules_not_loaded(self, reason: str, detail: str, *args: Any) -> None:
        self.load_error = reason
        logger.error(
            "Causal rules not loaded, so ingestion will build no CAUSED or TRIGGERED edges: " + detail,
            *args,
        )

    def status(self) -> Dict[str, Any]:
        """How many rules loaded and, if none did, why. Reported on /health."""
        return {"loaded": len(self.rules), "error": self.load_error}

    def _matches_condition(self, log: Dict[str, Any], cond: Dict[str, Any]) -> bool:
        # Match severity (case-insensitive list comparison)
        sev_list = cond.get("severity")
        if sev_list and log.get("sev", "").upper() not in [s.upper() for s in sev_list]:
            return False

        # Match node using fnmatch (node_glob)
        node_glob = cond.get("node_glob")
        if node_glob and not fnmatch.fnmatch(log.get("node", ""), node_glob):
            return False

        # Match log message pattern (regex)
        log_pattern = cond.get("log_pattern")
        if log_pattern:
            try:
                if not re.search(log_pattern, log.get("text", "")):
                    return False
            except Exception:
                return False

        return True

    def evaluate(self, logs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Evaluates causal rules against a sorted list of logs and generates edges.
        Returns a list of dicts representing causal edges to write into Neo4j.
        """
        # Parse log times and sort logs
        logs_with_ts = []
        for log in logs:
            # Prefer the absolute numeric key when ingestion has stamped it
            # (issue #70); fall back to parsing the display string.
            ts_num = log.get("t_sec")
            ts_sec = float(ts_num) if isinstance(ts_num, (int, float)) else log_time_to_seconds(log.get("t", "0"))
            logs_with_ts.append({
                **log,
                "_ts_sec": ts_sec,
            })
        logs_with_ts.sort(key=lambda x: x["_ts_sec"])

        edges = []

        # 1. Evaluate YAML causal rules
        for rule in self.rules:
            rule_id = rule.get("id")
            cause_cond = rule.get("cause", {})
            effect_cond = rule.get("effect", {})
            window_sec = rule.get("window_ms", 2000) / 1000.0
            confidence = rule.get("confidence", 1.0)
            edge_type = rule.get("edge_type", "CAUSED")
            evidence_required = rule.get("evidence_required", 1)

            # Filter causes and effects
            causes = [l for l in logs_with_ts if self._matches_condition(l, cause_cond)]
            effects = [l for l in logs_with_ts if self._matches_condition(l, effect_cond)]

            # For each cause, look for effects in window
            for c in causes:
                # Find matching effects in the window
                matching_effects = []
                for e in effects:
                    if c["_ts_sec"] < e["_ts_sec"] <= c["_ts_sec"] + window_sec:
                        matching_effects.append(e)

                # Check evidence threshold
                if len(matching_effects) >= evidence_required:
                    # Create edge for each matched effect
                    for e in matching_effects:
                        lag_ms = round((e["_ts_sec"] - c["_ts_sec"]) * 1000)
                        edges.append({
                            "source_id": c["id"],
                            "target_id": e["id"],
                            "type": edge_type,
                            "properties": {
                                "rule_id": rule_id,
                                "confidence": confidence,
                                "lag_ms": lag_ms
                            }
                        })

        # 2. Automatic CONCURRENT_WITH relationships
        # Any pair of logs occurring within 50ms of each other
        for i in range(len(logs_with_ts)):
            l1 = logs_with_ts[i]
            for j in range(i + 1, len(logs_with_ts)):
                l2 = logs_with_ts[j]
                diff_sec = l2["_ts_sec"] - l1["_ts_sec"]
                if diff_sec <= 0.050:
                    edges.append({
                        "source_id": l1["id"],
                        "target_id": l2["id"],
                        "type": "CONCURRENT_WITH",
                        "properties": {
                            "lag_ms": round(diff_sec * 1000)
                        }
                    })
                else:
                    break

        return edges

causal_rules_evaluator = CausalRulesEvaluator()
